import type { ConnectionOptions } from 'node:tls';
import {
  AndFilter,
  BerWriter,
  Change,
  Attribute as ChangeAttribute,
  Client,
  type Entry,
  EqualityFilter,
  type Filter,
  FilterParser,
  InvalidCredentialsError,
  OrFilter,
  ResultCodeError,
} from 'ldapts';
import type { DirectorySettings } from './settings';
import { transportProblem } from './settings';

/**
 * The LDAP client side of directories (M1-082, IAM-005): connect over LDAPS or StartTLS, bind,
 * search in pages, read long multi-valued attributes in ranges (Active Directory), and the few
 * writes read-write directories take. Built on ldapts (MIT).
 */

/** The directory could not be reached, or TLS failed: nothing was decided about the person. */
export class DirectoryUnavailableError extends Error {
  constructor(
    readonly reason: 'unreachable' | 'tls' | 'transport' | 'protocol',
    detail: string,
  ) {
    super(detail);
  }
}

/** The service account's bind was refused. */
export class DirectoryBindError extends Error {}

/** A search or write the directory refused, with its LDAP result code. */
export class DirectoryOperationError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
  ) {
    super(message);
  }
}

const CONNECT_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 120_000;
export const PAGE_SIZE = 500;

/** An entry with attribute names in lower case, so servers' spellings do not matter. */
export interface LdapEntry {
  dn: string;
  /** Text values of an attribute (empty when absent). */
  values(name: string): string[];
  first(name: string): string | undefined;
  /** The first value as bytes (binary attributes such as objectGUID). */
  bytes(name: string): Buffer | undefined;
  /** For a ranged attribute (`member;range=0-1499`): where the next range starts, if any. */
  nextRange(name: string): number | null;
}

/**
 * ldapts adds every requested attribute the answer lacks as an empty list, so a request for
 * `member` answered with `member;range=0-1499` also holds an empty `member`, and one for
 * `member;range=1500-*` an empty one beside the real `member;range=1500-2999`. Empty lists
 * never replace values.
 */
function toEntry(raw: Entry): LdapEntry {
  const map = new Map<string, (string | Buffer)[]>();
  const ranges = new Map<string, number | null>();
  const ranged = new Map<
    string,
    { values: (string | Buffer)[]; next: number | null; real: boolean }
  >();
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'dn') continue;
    const values = (Array.isArray(value) ? value : [value]) as (string | Buffer)[];
    const lower = key.toLowerCase();
    const range = /^(.+);range=(\d+)-(\d+|\*)$/.exec(lower);
    if (range) {
      const name = range[1] as string;
      const current = ranged.get(name) ?? { values: [], next: null, real: false };
      if (values.length > 0 || !current.real) {
        current.values.push(...values);
        current.next = range[3] === '*' ? null : Number(range[3]) + 1;
        current.real = current.real || values.length > 0;
      }
      ranged.set(name, current);
    } else if (values.length > 0 || !map.has(lower)) {
      map.set(lower, values);
    }
  }
  for (const [name, r] of ranged) {
    if (r.real || !map.has(name) || (map.get(name) ?? []).length === 0) {
      map.set(name, r.values);
      ranges.set(name, r.next);
    }
  }
  const text = (v: string | Buffer) => (Buffer.isBuffer(v) ? v.toString('utf8') : v);
  return {
    dn: raw.dn,
    values: (name) => (map.get(name.toLowerCase()) ?? []).map(text),
    first: (name) => {
      const v = map.get(name.toLowerCase())?.[0];
      return v === undefined ? undefined : text(v);
    },
    bytes: (name) => {
      const v = map.get(name.toLowerCase())?.[0];
      return v === undefined ? undefined : Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8');
    },
    nextRange: (name) => ranges.get(name.toLowerCase()) ?? null,
  };
}

/** Node's TLS options for a directory: its own CA certificates when given, always verified. */
function tlsOptions(
  settings: Pick<DirectorySettings, 'url' | 'caCertificates'>,
): ConnectionOptions {
  const host = new URL(settings.url).hostname.replace(/^\[|\]$/g, '');
  return {
    rejectUnauthorized: true,
    ...(settings.caCertificates.length > 0 ? { ca: settings.caCertificates } : {}),
    // A host name is verified against the certificate; an IP address needs one in it.
    servername: /^[\d.]+$|:/.test(host) ? undefined : host,
    minVersion: 'TLSv1.2',
  };
}

function classify(error: unknown): DirectoryUnavailableError {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code ?? '';
  if (/certificate|self.signed|SSL|TLS|altname|ERR_TLS/i.test(`${code} ${message}`)) {
    return new DirectoryUnavailableError('tls', message);
  }
  if (
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|timeout|Socket|closed/i.test(
      `${code} ${message}`,
    )
  ) {
    return new DirectoryUnavailableError('unreachable', message);
  }
  return new DirectoryUnavailableError('protocol', message);
}

/** Opens a connection (LDAPS, or LDAP upgraded with StartTLS) without binding. */
async function open(
  settings: Pick<DirectorySettings, 'url' | 'startTls' | 'caCertificates'>,
): Promise<Client> {
  const problem = transportProblem(settings.url, settings.startTls);
  if (problem) throw new DirectoryUnavailableError('transport', problem);
  const options = tlsOptions(settings);
  const client = new Client({
    url: settings.url,
    connectTimeout: CONNECT_TIMEOUT_MS,
    timeout: OPERATION_TIMEOUT_MS,
    ...(settings.url.startsWith('ldaps:') ? { tlsOptions: options } : {}),
  });
  if (settings.startTls) {
    try {
      await client.startTLS(options);
    } catch (error) {
      await client.unbind().catch(() => undefined);
      throw classify(error);
    }
  }
  return client;
}

/** Binds as a DN with a password; false when the directory refuses the credentials. */
async function bindAs(client: Client, dn: string, password: string): Promise<boolean> {
  // An empty password is an unauthenticated bind, which many servers accept as anonymous.
  if (password === '' || dn === '') return false;
  try {
    await client.bind(dn, password);
    return true;
  } catch (error) {
    if (error instanceof InvalidCredentialsError) return false;
    throw classify(error);
  }
}

export interface RootDse {
  /** Active Directory: the domain controller's highest committed USN. */
  highestCommittedUsn: string | null;
  /** Active Directory: the domain controller answering (its NTDS settings DN). */
  server: string | null;
}

/** A bound connection as the directory's service account. */
export class DirectoryClient {
  private constructor(
    private readonly client: Client,
    readonly settings: DirectorySettings,
  ) {}

  static async connect(settings: DirectorySettings): Promise<DirectoryClient> {
    let client: Client;
    try {
      client = await open(settings);
    } catch (error) {
      throw error instanceof DirectoryUnavailableError ? error : classify(error);
    }
    let bound: boolean;
    try {
      bound = await bindAs(client, settings.bindDn, settings.bindPassword);
    } catch (error) {
      await client.unbind().catch(() => undefined);
      throw error;
    }
    if (!bound) {
      await client.unbind().catch(() => undefined);
      throw new DirectoryBindError('The directory refused the service account');
    }
    return new DirectoryClient(client, settings);
  }

  async close(): Promise<void> {
    await this.client.unbind().catch(() => undefined);
  }

  async rootDse(): Promise<RootDse> {
    try {
      const result = await this.client.search('', {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: ['highestCommittedUSN', 'dsServiceName'],
      });
      const entry = result.searchEntries[0] ? toEntry(result.searchEntries[0]) : undefined;
      return {
        highestCommittedUsn: entry?.first('highestCommittedUSN') ?? null,
        server: entry?.first('dsServiceName') ?? null,
      };
    } catch (error) {
      throw classify(error);
    }
  }

  /**
   * Every entry below `base` matching `filter`, a page at a time. Ranged attributes are read to
   * the end before an entry is handed out.
   */
  async *search(
    base: string,
    filter: Filter | string,
    attributes: string[],
    options: { pageSize?: number; ranged?: string[] } = {},
  ): AsyncGenerator<LdapEntry[]> {
    const parsed = typeof filter === 'string' ? FilterParser.parseString(filter) : filter;
    let pages: AsyncGenerator<{ searchEntries: Entry[] }>;
    try {
      pages = this.client.searchPaginated(base, {
        scope: 'sub',
        filter: parsed,
        attributes,
        explicitBufferAttributes: this.settings.binary,
        paged: { pageSize: options.pageSize ?? PAGE_SIZE },
      });
    } catch (error) {
      throw classify(error);
    }
    while (true) {
      let next: IteratorResult<{ searchEntries: Entry[] }>;
      try {
        next = await pages.next();
      } catch (error) {
        if (error instanceof DirectoryUnavailableError) throw error;
        if (error instanceof ResultCodeError) {
          throw new DirectoryOperationError(`${error.name}: ${error.message}`, error.code);
        }
        throw classify(error);
      }
      if (next.done) return;
      const entries = next.value.searchEntries.map(toEntry);
      for (const name of options.ranged ?? []) {
        for (const entry of entries) {
          let from = entry.nextRange(name);
          const extra: string[] = [];
          while (from !== null) {
            const more = await this.range(entry.dn, name, from);
            extra.push(...more.values);
            from = more.next;
          }
          if (extra.length > 0) {
            const base = entry.values(name);
            const all = [...base, ...extra];
            const original = entry.values.bind(entry);
            entry.values = (n: string) =>
              n.toLowerCase() === name.toLowerCase() ? all : original(n);
          }
        }
      }
      yield entries;
    }
  }

  /** One further range of a multi-valued attribute (Active Directory's MaxValRange). */
  private async range(
    dn: string,
    name: string,
    from: number,
  ): Promise<{ values: string[]; next: number | null }> {
    try {
      const result = await this.client.search(dn, {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: [`${name};range=${from}-*`],
      });
      const raw = result.searchEntries[0];
      if (!raw) return { values: [], next: null };
      const entry = toEntry(raw);
      return { values: entry.values(name), next: entry.nextRange(name) };
    } catch (error) {
      throw classify(error);
    }
  }

  /** Changes attributes of an entry as the service account. */
  async modify(
    dn: string,
    changes: { operation: 'add' | 'delete' | 'replace'; type: string; values: string[] }[],
  ): Promise<void> {
    try {
      await this.client.modify(
        dn,
        changes.map(
          (c) =>
            new Change({
              operation: c.operation,
              modification: new ChangeAttribute({ type: c.type, values: c.values }),
            }),
        ),
      );
    } catch (error) {
      if (error instanceof ResultCodeError) {
        throw new DirectoryOperationError(`${error.name}: ${error.message}`, error.code);
      }
      throw classify(error);
    }
  }
}

/** Filters for entries by identifier: entryUUID as text, objectGUID as its bytes. */
export function idFilter(
  settings: DirectorySettings,
  base: string,
  ids: readonly string[],
): Filter {
  const attribute = settings.attributes.id;
  const binary = settings.binary.some((b) => b.toLowerCase() === attribute.toLowerCase());
  const terms = ids.map(
    (id) => new EqualityFilter({ attribute, value: binary ? guidBytes(id) : id }),
  );
  return new AndFilter({
    filters: [FilterParser.parseString(base), new OrFilter({ filters: terms })],
  });
}

/** Filters for groups that list any of these DNs as members. */
export function memberFilter(settings: DirectorySettings, dns: readonly string[]): Filter {
  const terms = dns.map(
    (dn) => new EqualityFilter({ attribute: settings.attributes.member, value: dn }),
  );
  return new AndFilter({
    filters: [FilterParser.parseString(settings.groupFilter), new OrFilter({ filters: terms })],
  });
}

/** Active Directory's GUID text: the first three groups are little-endian. */
export function guidText(bytes: Buffer): string {
  if (bytes.length !== 16) return bytes.toString('hex');
  const h = (from: number, to: number, reverse: boolean) => {
    const part = [...bytes.subarray(from, to)];
    return Buffer.from(reverse ? part.reverse() : part).toString('hex');
  };
  return `${h(0, 4, true)}-${h(4, 6, true)}-${h(6, 8, true)}-${h(8, 10, false)}-${h(10, 16, false)}`;
}

/** The bytes of a GUID written by `guidText`. */
export function guidBytes(text: string): Buffer {
  const hex = text.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) return Buffer.from(text, 'hex');
  const b = Buffer.from(hex, 'hex');
  const out = Buffer.alloc(16);
  [3, 2, 1, 0, 5, 4, 7, 6].forEach((from, to) => {
    out[to] = b[from] as number;
  });
  b.copy(out, 8, 8, 16);
  return out;
}

export type Verdict = 'ok' | 'invalid' | 'unavailable';

/**
 * Checks a person's password by binding as them (IAM-005): the directory decides, with its own
 * lockout and expiry rules. 'unavailable' when it cannot be reached.
 */
export async function verifyPassword(
  settings: Pick<DirectorySettings, 'url' | 'startTls' | 'caCertificates'>,
  dn: string,
  password: string,
): Promise<Verdict> {
  if (password === '') return 'invalid';
  let client: Client | undefined;
  try {
    client = await open(settings);
    return (await bindAs(client, dn, password)) ? 'ok' : 'invalid';
  } catch {
    return 'unavailable';
  } finally {
    await client?.unbind().catch(() => undefined);
  }
}

/** The value of a Password Modify request (RFC 3062) naming the old and new password. */
function passwordModifyValue(oldPassword: string, newPassword: string): Buffer {
  const writer = new BerWriter();
  writer.startSequence();
  writer.writeString(oldPassword, 0x81);
  writer.writeString(newPassword, 0x82);
  writer.endSequence();
  return writer.buffer;
}

/** Active Directory's unicodePwd value: the quoted password in UTF-16LE. */
export function unicodePassword(password: string): Buffer {
  return Buffer.from(`"${password}"`, 'utf16le');
}

/**
 * Changes a person's password in the directory as that person (read-write directories): Active
 * Directory removes the old unicodePwd and adds the new one, which it accepts only over TLS;
 * other servers take the Password Modify extended operation, which hashes it their way.
 */
export async function changePassword(
  settings: Pick<DirectorySettings, 'url' | 'startTls' | 'caCertificates' | 'kind'>,
  dn: string,
  oldPassword: string,
  newPassword: string,
): Promise<Verdict> {
  let client: Client | undefined;
  try {
    client = await open(settings);
    if (!(await bindAs(client, dn, oldPassword))) return 'invalid';
    if (settings.kind === 'active_directory') {
      await client.modify(dn, [
        new Change({
          operation: 'delete',
          modification: new ChangeAttribute({
            type: 'unicodePwd',
            values: [unicodePassword(oldPassword)],
          }),
        }),
        new Change({
          operation: 'add',
          modification: new ChangeAttribute({
            type: 'unicodePwd',
            values: [unicodePassword(newPassword)],
          }),
        }),
      ]);
    } else {
      await client.exop('1.3.6.1.4.1.4203.1.11.1', passwordModifyValue(oldPassword, newPassword));
    }
    return 'ok';
  } catch (error) {
    if (error instanceof ResultCodeError) {
      throw new DirectoryOperationError(`${error.name}: ${error.message}`, error.code);
    }
    return 'unavailable';
  } finally {
    await client?.unbind().catch(() => undefined);
  }
}
