import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

/**
 * An in-process LDAP server for tests (M1-082): enough of RFC 4511 to stand in for OpenLDAP and
 * Active Directory in sync and sign-in tests. Its BER codec is its own, so the client library
 * and this server cannot share an encoding mistake.
 *
 * - Bind (simple), unbind, search (base, one level and subtree; and, or, not, equality,
 *   substrings, ordering, presence and the Active Directory bit matching rules), the paged
 *   results control, modify, the Password Modify extended operation (RFC 3062) and StartTLS.
 * - Flavours: `openldap` entries carry entryUUID and modifyTimestamp; `active_directory` ones a
 *   binary objectGUID, uSNChanged, userAccountControl and objectCategory, the root DSE names
 *   the domain controller and its highest committed USN, unpaged searches stop at the page
 *   limit (sizeLimitExceeded), and long multi-valued attributes come in ranges
 *   (`member;range=0-1499`).
 * - Renames and deletions update group members without changing the groups' change marks, as
 *   Active Directory's linked attributes do, so a sync cannot rely on groups being re-read.
 *
 * Passwords live outside the entries and are never returned. Everything is generated at run
 * time; no credential is part of the repository.
 */
export type FakeLdapFlavour = 'openldap' | 'active_directory';

export interface FakeLdapOptions {
  flavour: FakeLdapFlavour;
  baseDn?: string;
  /** 'ldaps' listens with TLS; 'starttls' offers StartTLS on a plain port. */
  transport?: 'plain' | 'ldaps' | 'starttls';
  /** PEM key and certificate for 'ldaps' and 'starttls'. */
  tls?: { key: string; cert: string };
  /** Active Directory's MaxValRange (default 1500); 0 returns every value at once. */
  maxValueRange?: number;
  /** Active Directory's MaxPageSize (default 1000): an unpaged search stops there. */
  maxPageSize?: number;
  /** The host name in `url` (default 127.0.0.1); TLS tests use `localhost`. */
  host?: string;
  /** The service account's password; made per server when left out. */
  bindPassword?: string;
}

interface Value {
  name: string;
  values: Buffer[];
}

export interface FakeEntry {
  dn: string;
  attributes: Map<string, Value>;
}

export interface FakeUser {
  /** uid (OpenLDAP) or sAMAccountName (Active Directory). */
  username: string;
  mail?: string | null;
  displayName?: string;
  givenName?: string;
  sn?: string;
  password?: string;
  disabled?: boolean;
  /** Under this RDN path below the base (default ou=people or cn=Users). */
  container?: string;
}

export interface FakeGroup {
  cn: string;
  members?: string[];
  container?: string;
}

const OPERATIONAL = new Set([
  'entryuuid',
  'modifytimestamp',
  'createtimestamp',
  'entrydn',
  'structuralobjectclass',
]);
const PASSWORD_MODIFY = '1.3.6.1.4.1.4203.1.11.1';
const START_TLS = '1.3.6.1.4.1.1466.20037';
const PAGED = '1.2.840.113556.1.4.319';
const AND_RULE = '1.2.840.113556.1.4.803';
const OR_RULE = '1.2.840.113556.1.4.804';

const RESULT = {
  success: 0,
  operationsError: 1,
  protocolError: 2,
  sizeLimitExceeded: 4,
  noSuchAttribute: 16,
  constraintViolation: 19,
  noSuchObject: 32,
  invalidCredentials: 49,
  insufficientAccessRights: 50,
  unwillingToPerform: 53,
  other: 80,
} as const;

// ---- BER ----

function lengthBytes(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, content: Buffer) =>
  Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content]);
const seq = (tag: number, ...parts: Buffer[]) => tlv(tag, Buffer.concat(parts));
function intBytes(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  if ((bytes[0] ?? 0) & 0x80) bytes.unshift(0);
  return Buffer.from(bytes);
}
const int = (n: number, tag = 0x02) => tlv(tag, intBytes(n));
const octets = (v: string | Buffer, tag = 0x04) =>
  tlv(tag, Buffer.isBuffer(v) ? v : Buffer.from(v));

interface Node {
  tag: number;
  value: Buffer;
}

/** The element at `offset`, or null when the buffer does not hold all of it yet. */
function readNode(buffer: Buffer, offset: number): { node: Node; end: number } | null {
  if (offset + 2 > buffer.length) return null;
  const tag = buffer[offset] as number;
  let at = offset + 1;
  let length = buffer[at] as number;
  at += 1;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new Error('unsupported BER length');
    if (at + count > buffer.length) return null;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + (buffer[at + i] as number);
    at += count;
  }
  if (at + length > buffer.length) return null;
  return { node: { tag, value: buffer.subarray(at, at + length) }, end: at + length };
}

function children(node: Node): Node[] {
  const out: Node[] = [];
  let at = 0;
  while (at < node.value.length) {
    const next = readNode(node.value, at);
    if (!next) throw new Error('truncated BER element');
    out.push(next.node);
    at = next.end;
  }
  return out;
}

function toInt(node: Node | undefined): number {
  if (!node) return 0;
  let n = 0;
  for (const b of node.value) n = n * 256 + b;
  return node.value.length > 0 && (node.value[0] as number) & 0x80
    ? n - 2 ** (8 * node.value.length)
    : n;
}
const text = (node: Node | undefined) => node?.value.toString('utf8') ?? '';

// ---- Filters ----

type Filter =
  | { kind: 'and' | 'or'; filters: Filter[] }
  | { kind: 'not'; filter: Filter }
  | { kind: 'eq' | 'ge' | 'le' | 'approx'; attribute: string; value: Buffer }
  | { kind: 'present'; attribute: string }
  | { kind: 'sub'; attribute: string; initial?: string; any: string[]; final?: string }
  | { kind: 'ext'; attribute: string; rule: string; value: Buffer };

function parseFilter(node: Node): Filter {
  switch (node.tag) {
    case 0xa0:
    case 0xa1:
      return { kind: node.tag === 0xa0 ? 'and' : 'or', filters: children(node).map(parseFilter) };
    case 0xa2:
      return { kind: 'not', filter: parseFilter(children(node)[0] as Node) };
    case 0xa3:
    case 0xa5:
    case 0xa6:
    case 0xa8: {
      const [attribute, value] = children(node);
      const kind = ({ 163: 'eq', 165: 'ge', 166: 'le', 168: 'approx' } as const)[node.tag];
      return {
        kind,
        attribute: text(attribute).toLowerCase(),
        value: value?.value ?? Buffer.alloc(0),
      };
    }
    case 0x87:
      return { kind: 'present', attribute: node.value.toString('utf8').toLowerCase() };
    case 0xa4: {
      const [attribute, parts] = children(node);
      const filter: Filter = { kind: 'sub', attribute: text(attribute).toLowerCase(), any: [] };
      for (const part of parts ? children(parts) : []) {
        const value = part.value.toString('utf8').toLowerCase();
        if (part.tag === 0x80) filter.initial = value;
        else if (part.tag === 0x81) filter.any.push(value);
        else if (part.tag === 0x82) filter.final = value;
      }
      return filter;
    }
    case 0xa9: {
      const filter: Filter & { kind: 'ext' } = {
        kind: 'ext',
        attribute: '',
        rule: '',
        value: Buffer.alloc(0),
      };
      for (const part of children(node)) {
        if (part.tag === 0x81) filter.rule = text(part);
        else if (part.tag === 0x82) filter.attribute = text(part).toLowerCase();
        else if (part.tag === 0x83) filter.value = part.value;
      }
      return filter;
    }
    default:
      throw new Error(`unsupported filter 0x${node.tag.toString(16)}`);
  }
}

/** DN comparison: case and spaces around separators do not matter. */
export function normalizeDn(dn: string): string {
  return dn
    .trim()
    .replace(/\s*([,=+])\s*/g, '$1')
    .toLowerCase();
}

const DN_VALUED = new Set(['member', 'uniquemember', 'distinguishedname', 'memberof']);
const BINARY = new Set(['objectguid']);

function equalValues(attribute: string, a: Buffer, b: Buffer): boolean {
  if (BINARY.has(attribute)) return a.equals(b);
  const x = a.toString('utf8');
  const y = b.toString('utf8');
  if (DN_VALUED.has(attribute)) return normalizeDn(x) === normalizeDn(y);
  if (attribute === 'objectcategory') {
    // Active Directory accepts the class name for the category's DN.
    const short = (v: string) => (v.includes('=') ? (v.split(',')[0]?.split('=')[1] ?? v) : v);
    return short(x).toLowerCase() === short(y).toLowerCase();
  }
  return x.toLowerCase() === y.toLowerCase();
}

function compare(a: Buffer, b: Buffer): number {
  const x = a.toString('utf8');
  const y = b.toString('utf8');
  if (/^-?\d+$/.test(x) && /^-?\d+$/.test(y)) {
    const d = BigInt(x) - BigInt(y);
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

function matches(entry: FakeEntry, filter: Filter): boolean {
  switch (filter.kind) {
    case 'and':
      return filter.filters.every((f) => matches(entry, f));
    case 'or':
      return filter.filters.some((f) => matches(entry, f));
    case 'not':
      return !matches(entry, filter.filter);
    case 'present':
      return filter.attribute === 'objectclass' || entry.attributes.has(filter.attribute);
    case 'eq':
    case 'approx':
      return (entry.attributes.get(filter.attribute)?.values ?? []).some((v) =>
        equalValues(filter.attribute, v, filter.value),
      );
    case 'ge':
      return (entry.attributes.get(filter.attribute)?.values ?? []).some(
        (v) => compare(v, filter.value) >= 0,
      );
    case 'le':
      return (entry.attributes.get(filter.attribute)?.values ?? []).some(
        (v) => compare(v, filter.value) <= 0,
      );
    case 'sub':
      return (entry.attributes.get(filter.attribute)?.values ?? []).some((raw) => {
        let v = raw.toString('utf8').toLowerCase();
        if (filter.initial !== undefined) {
          if (!v.startsWith(filter.initial)) return false;
          v = v.slice(filter.initial.length);
        }
        for (const part of filter.any) {
          const at = v.indexOf(part);
          if (at < 0) return false;
          v = v.slice(at + part.length);
        }
        return filter.final === undefined || v.endsWith(filter.final);
      });
    case 'ext': {
      const wanted = BigInt(filter.value.toString('utf8') || '0');
      return (entry.attributes.get(filter.attribute)?.values ?? []).some((v) => {
        const have = BigInt(v.toString('utf8') || '0');
        if (filter.rule === AND_RULE) return (have & wanted) === wanted;
        if (filter.rule === OR_RULE) return (have & wanted) !== 0n;
        return false;
      });
    }
  }
}

// ---- Server ----

interface PagedSearch {
  dns: string[];
  next: number;
}

interface Connection {
  socket: net.Socket;
  boundDn: string | null;
  secure: boolean;
  pages: Map<string, PagedSearch>;
}

export interface FakeLdapStats {
  binds: number;
  searches: number;
  /** Searches that asked for more pages with a cookie. */
  pagesServed: number;
  /** Follow-up searches for further ranges of a multi-valued attribute. */
  rangeRequests: number;
  modifies: number;
}

function generalizedTime(at: Date): string {
  return `${at.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
}

/** Active Directory's GUID text: the first three groups are little-endian. */
export function guidText(bytes: Buffer): string {
  const h = (from: number, to: number, reverse: boolean) => {
    const part = [...bytes.subarray(from, to)];
    return Buffer.from(reverse ? part.reverse() : part).toString('hex');
  };
  return `${h(0, 4, true)}-${h(4, 6, true)}-${h(6, 8, true)}-${h(8, 10, false)}-${h(10, 16, false)}`;
}

export class FakeLdap {
  readonly flavour: FakeLdapFlavour;
  readonly baseDn: string;
  readonly stats: FakeLdapStats = {
    binds: 0,
    searches: 0,
    pagesServed: 0,
    rangeRequests: 0,
    modifies: 0,
  };
  /** The service account's DN and password, made per server. */
  readonly bindDn: string;
  readonly bindPassword: string;
  /** Set to make every connection fail: an unreachable directory. */
  down = false;
  /** Change marks use this clock (OpenLDAP's modifyTimestamp has one-second steps). */
  clock: () => Date = () => new Date();

  private readonly entries = new Map<string, FakeEntry>();
  private readonly passwords = new Map<string, string>();
  private readonly transport: 'plain' | 'ldaps' | 'starttls';
  private readonly maxValueRange: number;
  private readonly maxPageSize: number;
  private readonly host: string;
  private server: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();
  private usn = 1000;
  private domainController = 'CN=NTDS Settings,CN=DC1,CN=Servers,CN=Default,CN=Sites';

  constructor(private readonly options: FakeLdapOptions) {
    this.flavour = options.flavour;
    this.baseDn = options.baseDn ?? 'dc=example,dc=com';
    this.transport = options.transport ?? 'plain';
    this.maxValueRange = options.maxValueRange ?? (this.flavour === 'active_directory' ? 1500 : 0);
    this.maxPageSize = options.maxPageSize ?? (this.flavour === 'active_directory' ? 1000 : 0);
    this.host = options.host ?? '127.0.0.1';
    this.bindPassword = options.bindPassword ?? `bind-${randomBytes(18).toString('base64url')}`;
    this.bindDn =
      this.flavour === 'active_directory'
        ? `CN=Taskmoor Sync,CN=Users,${this.baseDn}`
        : `cn=sync,${this.baseDn}`;
    this.put(this.baseDn, { objectClass: ['top', 'domain'] });
    this.put(this.bindDn, { objectClass: ['top', 'person'], cn: ['sync'] });
    this.passwords.set(normalizeDn(this.bindDn), this.bindPassword);
  }

  get url(): string {
    const address = this.server?.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return `${this.transport === 'ldaps' ? 'ldaps' : 'ldap'}://${this.host}:${port}`;
  }

  get peopleContainer(): string {
    return this.flavour === 'active_directory'
      ? `CN=Users,${this.baseDn}`
      : `ou=people,${this.baseDn}`;
  }

  get groupContainer(): string {
    return this.flavour === 'active_directory'
      ? `CN=Users,${this.baseDn}`
      : `ou=groups,${this.baseDn}`;
  }

  /** Listens on the loopback interface, on `port` or a free one. */
  async start(port = 0): Promise<this> {
    const onSocket = (socket: net.Socket) => this.serve(socket, this.transport === 'ldaps');
    this.server =
      this.transport === 'ldaps'
        ? tls.createServer({ key: this.options.tls?.key, cert: this.options.tls?.cert }, onSocket)
        : net.createServer(onSocket);
    await new Promise<void>((resolve) => this.server?.listen(port, '127.0.0.1', resolve));
    return this;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  // ---- Directory content ----

  private stamp(entry: FakeEntry): void {
    const at = this.clock();
    if (this.flavour === 'active_directory') {
      this.usn += 1;
      this.setValues(entry, 'uSNChanged', [String(this.usn)]);
      this.setValues(entry, 'whenChanged', [`${generalizedTime(at).slice(0, 14)}.0Z`]);
    } else {
      this.setValues(entry, 'modifyTimestamp', [generalizedTime(at)]);
    }
  }

  private setValues(entry: FakeEntry, name: string, values: (string | Buffer)[]): void {
    if (values.length === 0) {
      entry.attributes.delete(name.toLowerCase());
      return;
    }
    entry.attributes.set(name.toLowerCase(), {
      name,
      values: values.map((v) => (Buffer.isBuffer(v) ? v : Buffer.from(v))),
    });
  }

  /** Adds or replaces an entry with these attributes, plus its identifier and change mark. */
  put(dn: string, attributes: Record<string, (string | Buffer)[]>): FakeEntry {
    const key = normalizeDn(dn);
    const existing = this.entries.get(key);
    const entry: FakeEntry = existing ?? { dn, attributes: new Map() };
    for (const [name, values] of Object.entries(attributes)) this.setValues(entry, name, values);
    if (!existing) {
      if (this.flavour === 'active_directory') {
        this.setValues(entry, 'objectGUID', [randomBytes(16)]);
        this.setValues(entry, 'distinguishedName', [dn]);
        this.setValues(entry, 'uSNCreated', [String(this.usn + 1)]);
      } else {
        this.setValues(entry, 'entryUUID', [randomUUID()]);
        this.setValues(entry, 'createTimestamp', [generalizedTime(this.clock())]);
      }
    }
    this.stamp(entry);
    this.entries.set(key, entry);
    return entry;
  }

  addUser(user: FakeUser): string {
    const container = user.container ? `${user.container},${this.baseDn}` : this.peopleContainer;
    const name = user.displayName ?? user.username;
    if (this.flavour === 'active_directory') {
      const dn = `CN=${name},${container}`;
      this.put(dn, {
        objectClass: ['top', 'person', 'organizationalPerson', 'user'],
        objectCategory: [`CN=Person,CN=Schema,CN=Configuration,${this.baseDn}`],
        cn: [name],
        sAMAccountName: [user.username],
        userPrincipalName: [`${user.username}@${this.domain()}`],
        ...(user.mail === null ? {} : { mail: [user.mail ?? `${user.username}@example.com`] }),
        displayName: [name],
        ...(user.givenName ? { givenName: [user.givenName] } : {}),
        ...(user.sn ? { sn: [user.sn] } : {}),
        userAccountControl: [String(user.disabled ? 514 : 512)],
      });
      if (user.password) this.passwords.set(normalizeDn(dn), user.password);
      return dn;
    }
    const dn = `uid=${user.username},${container}`;
    this.put(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'inetOrgPerson'],
      uid: [user.username],
      cn: [name],
      sn: [user.sn ?? name.split(' ').at(-1) ?? name],
      ...(user.givenName ? { givenName: [user.givenName] } : {}),
      ...(user.mail === null ? {} : { mail: [user.mail ?? `${user.username}@example.com`] }),
      displayName: [name],
      ...(user.disabled ? { pwdAccountLockedTime: ['000001010000Z'] } : {}),
    });
    if (user.password) this.passwords.set(normalizeDn(dn), user.password);
    return dn;
  }

  addGroup(group: FakeGroup): string {
    const container = group.container ? `${group.container},${this.baseDn}` : this.groupContainer;
    if (this.flavour === 'active_directory') {
      const dn = `CN=${group.cn},${container}`;
      this.put(dn, {
        objectClass: ['top', 'group'],
        objectCategory: [`CN=Group,CN=Schema,CN=Configuration,${this.baseDn}`],
        cn: [group.cn],
        sAMAccountName: [group.cn],
        member: group.members ?? [],
      });
      return dn;
    }
    const dn = `cn=${group.cn},${container}`;
    this.put(dn, {
      objectClass: ['top', 'groupOfNames'],
      cn: [group.cn],
      member: group.members ?? [],
    });
    return dn;
  }

  private domain(): string {
    return this.baseDn
      .split(',')
      .map((part) => part.split('=')[1] ?? '')
      .join('.');
  }

  entry(dn: string): FakeEntry | undefined {
    return this.entries.get(normalizeDn(dn));
  }

  /** The entry's identifier as the sync stores it: entryUUID, or objectGUID as a GUID string. */
  idOf(dn: string): string {
    const entry = this.entry(dn);
    if (!entry) throw new Error(`no entry ${dn}`);
    if (this.flavour === 'active_directory') {
      return guidText(entry.attributes.get('objectguid')?.values[0] ?? Buffer.alloc(16));
    }
    return entry.attributes.get('entryuuid')?.values[0]?.toString('utf8') ?? '';
  }

  /** Replaces attributes of an entry (an empty list removes one) and moves its change mark. */
  modify(dn: string, attributes: Record<string, (string | Buffer)[]>): void {
    const entry = this.entry(dn);
    if (!entry) throw new Error(`no entry ${dn}`);
    for (const [name, values] of Object.entries(attributes)) this.setValues(entry, name, values);
    this.stamp(entry);
  }

  setDisabled(dn: string, disabled: boolean): void {
    if (this.flavour === 'active_directory') {
      this.modify(dn, { userAccountControl: [String(disabled ? 514 : 512)] });
    } else {
      this.modify(dn, { pwdAccountLockedTime: disabled ? ['000001010000Z'] : [] });
    }
  }

  setPassword(dn: string, password: string): void {
    this.passwords.set(normalizeDn(dn), password);
  }

  passwordOf(dn: string): string | undefined {
    return this.passwords.get(normalizeDn(dn));
  }

  addMember(groupDn: string, memberDn: string): void {
    const entry = this.entry(groupDn);
    const current = (entry?.attributes.get('member')?.values ?? []).map((v) => v.toString('utf8'));
    this.modify(groupDn, { member: [...current, memberDn] });
  }

  removeMember(groupDn: string, memberDn: string): void {
    const entry = this.entry(groupDn);
    const current = (entry?.attributes.get('member')?.values ?? []).map((v) => v.toString('utf8'));
    this.modify(groupDn, {
      member: current.filter((m) => normalizeDn(m) !== normalizeDn(memberDn)),
    });
  }

  /** Rewrites DN-valued member links from one DN to another (or drops them) silently. */
  private relink(from: string, to: string | null): void {
    const key = normalizeDn(from);
    for (const entry of this.entries.values()) {
      const member = entry.attributes.get('member');
      if (!member) continue;
      const values = member.values.map((v) => v.toString('utf8'));
      if (!values.some((v) => normalizeDn(v) === key)) continue;
      const next = values.flatMap((v) =>
        normalizeDn(v) === key ? (to === null ? [] : [to]) : [v],
      );
      this.setValues(entry, member.name, next);
    }
  }

  /** Renames an entry (a new first RDN value); members elsewhere follow without a change mark. */
  rename(dn: string, newRdn: string): string {
    const entry = this.entry(dn);
    if (!entry) throw new Error(`no entry ${dn}`);
    const parent = dn.slice(dn.indexOf(',') + 1);
    const next = `${newRdn},${parent}`;
    this.entries.delete(normalizeDn(dn));
    entry.dn = next;
    if (this.flavour === 'active_directory') this.setValues(entry, 'distinguishedName', [next]);
    const [attr = '', value = ''] = newRdn.split('=');
    const rdnAttr = this.flavour === 'active_directory' ? 'cn' : attr;
    this.setValues(entry, rdnAttr, [value]);
    this.stamp(entry);
    this.entries.set(normalizeDn(next), entry);
    const password = this.passwords.get(normalizeDn(dn));
    if (password) {
      this.passwords.delete(normalizeDn(dn));
      this.passwords.set(normalizeDn(next), password);
    }
    this.relink(dn, next);
    return next;
  }

  /** Deletes an entry; groups lose it as a member without a change mark. */
  remove(dn: string): void {
    this.entries.delete(normalizeDn(dn));
    this.passwords.delete(normalizeDn(dn));
    this.relink(dn, null);
  }

  /** Another domain controller answers from now on: its USNs are not comparable. */
  switchDomainController(): void {
    this.domainController = `CN=NTDS Settings,CN=DC${randomBytes(2).toString('hex')},CN=Servers`;
    this.usn += 50_000;
  }

  // ---- Protocol ----

  private serve(socket: net.Socket, secure: boolean): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    if (this.down) {
      socket.destroy();
      return;
    }
    const connection: Connection = { socket, boundDn: null, secure, pages: new Map() };
    this.listen(connection, socket);
  }

  private listen(connection: Connection, socket: net.Socket): void {
    let pending = Buffer.alloc(0);
    let queue = Promise.resolve();
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        let parsed: ReturnType<typeof readNode>;
        try {
          parsed = readNode(pending, 0);
        } catch {
          socket.destroy();
          return;
        }
        if (!parsed) return;
        const message = parsed.node;
        pending = pending.subarray(parsed.end);
        // StartTLS swaps the socket: stop reading this one until the handshake is set up.
        const upgrade = this.isStartTls(message);
        if (upgrade) socket.removeListener('data', onData);
        queue = queue
          .then(() => this.handle(connection, message, upgrade ? pending : undefined))
          .catch(() => {
            socket.destroy();
          });
        if (upgrade) return;
      }
    };
    socket.on('data', onData);
  }

  private isStartTls(message: Node): boolean {
    const [, op] = children(message);
    if (op?.tag !== 0x77) return false;
    return children(op).some((c) => c.tag === 0x80 && text(c) === START_TLS);
  }

  private send(connection: Connection, id: number, op: Buffer, controls?: Buffer): void {
    connection.socket.write(seq(0x30, int(id), op, ...(controls ? [controls] : [])));
  }

  private result(tag: number, code: number, message = '', extra: Buffer[] = []): Buffer {
    return seq(tag, int(code, 0x0a), octets(''), octets(message), ...extra);
  }

  private async handle(connection: Connection, message: Node, rest?: Buffer): Promise<void> {
    const [idNode, op, controlsNode] = children(message);
    const id = toInt(idNode);
    if (!op) return;
    const controls = controlsNode?.tag === 0xa0 ? children(controlsNode) : [];
    switch (op.tag) {
      case 0x60:
        return this.bind(connection, id, op);
      case 0x42:
        connection.socket.end();
        return;
      case 0x50:
        return;
      case 0x63:
        return this.search(connection, id, op, controls);
      case 0x66:
        return this.modifyOp(connection, id, op);
      case 0x77:
        return this.extended(connection, id, op, rest);
      default:
        this.send(
          connection,
          id,
          this.result(op.tag + 1, RESULT.unwillingToPerform, 'unsupported'),
        );
    }
  }

  private bind(connection: Connection, id: number, op: Node): void {
    this.stats.binds += 1;
    const [, nameNode, auth] = children(op);
    const dn = text(nameNode);
    const password = auth?.tag === 0x80 ? auth.value.toString('utf8') : '';
    connection.boundDn = null;
    if (dn === '' && password === '') {
      this.send(connection, id, this.result(0x61, RESULT.success));
      return;
    }
    // An unauthenticated bind (a name without a password) is refused (RFC 4513 5.1.2).
    if (password === '') {
      this.send(
        connection,
        id,
        this.result(0x61, RESULT.unwillingToPerform, 'unauthenticated bind'),
      );
      return;
    }
    const entry = this.entry(dn);
    const disabled =
      this.flavour === 'active_directory'
        ? (Number(entry?.attributes.get('useraccountcontrol')?.values[0]?.toString() ?? 0) & 2) !==
          0
        : entry?.attributes.has('pwdaccountlockedtime') === true;
    if (!entry || disabled || this.passwords.get(normalizeDn(dn)) !== password) {
      this.send(connection, id, this.result(0x61, RESULT.invalidCredentials));
      return;
    }
    connection.boundDn = entry.dn;
    this.send(connection, id, this.result(0x61, RESULT.success));
  }

  private isAdmin(connection: Connection): boolean {
    return (
      connection.boundDn !== null && normalizeDn(connection.boundDn) === normalizeDn(this.bindDn)
    );
  }

  private rootDse(): FakeEntry {
    const attributes = new Map<string, Value>();
    const set = (name: string, values: string[]) =>
      attributes.set(name.toLowerCase(), { name, values: values.map((v) => Buffer.from(v)) });
    set('namingContexts', [this.baseDn]);
    set('supportedLDAPVersion', ['3']);
    set('supportedControl', [PAGED]);
    set('supportedExtension', [START_TLS, PASSWORD_MODIFY]);
    if (this.flavour === 'active_directory') {
      set('defaultNamingContext', [this.baseDn]);
      set('highestCommittedUSN', [String(this.usn)]);
      set('dsServiceName', [this.domainController]);
    }
    return { dn: '', attributes };
  }

  private inScope(dn: string, base: string, scope: number): boolean {
    const d = normalizeDn(dn);
    const b = normalizeDn(base);
    if (scope === 0) return d === b;
    if (scope === 1) return d.slice(d.indexOf(',') + 1) === b && d !== b;
    return d === b || d.endsWith(`,${b}`);
  }

  private search(connection: Connection, id: number, op: Node, controls: Node[]): void {
    this.stats.searches += 1;
    const [baseNode, scopeNode, , sizeNode, , , filterNode, attributesNode] = children(op);
    const base = text(baseNode);
    const scope = toInt(scopeNode);
    const sizeLimit = toInt(sizeNode);
    const requested = attributesNode ? children(attributesNode).map((a) => text(a)) : [];
    const filter = filterNode
      ? parseFilter(filterNode)
      : ({ kind: 'present', attribute: 'objectclass' } as Filter);

    if (base === '' && scope === 0) {
      const dse = this.rootDse();
      if (matches(dse, filter)) this.sendEntry(connection, id, dse, requested, true);
      this.send(connection, id, this.result(0x65, RESULT.success));
      return;
    }
    if (connection.boundDn === null) {
      this.send(connection, id, this.result(0x65, RESULT.insufficientAccessRights, 'bind first'));
      return;
    }
    if (!this.entry(base)) {
      this.send(connection, id, this.result(0x65, RESULT.noSuchObject));
      return;
    }
    if (requested.some((a) => /;range=/i.test(a))) this.stats.rangeRequests += 1;

    const paged = controls.map((c) => children(c)).find((parts) => text(parts[0]) === PAGED);
    let dns: string[];
    let state: PagedSearch | undefined;
    let pageSize = 0;
    if (paged) {
      // controlType, criticality (optional), controlValue: the value is the second string.
      const value = paged.slice(1).find((p) => p.tag === 0x04);
      const inner = value ? children(readNode(value.value, 0)?.node as Node) : [];
      pageSize = toInt(inner[0]);
      const cookie = inner[1]?.value.toString('hex') ?? '';
      if (cookie) {
        state = connection.pages.get(cookie);
        connection.pages.delete(cookie);
        this.stats.pagesServed += 1;
        if (!state || pageSize === 0) {
          this.send(connection, id, this.result(0x65, RESULT.success), this.pagedControl(''));
          return;
        }
      }
    }
    if (!state) {
      dns = [...this.entries.values()]
        .filter((e) => this.inScope(e.dn, base, scope) && matches(e, filter))
        .map((e) => e.dn);
      state = { dns, next: 0 };
    }
    let limit = state.dns.length - state.next;
    let code: number = RESULT.success;
    // Active Directory caps every page at MaxPageSize, asked for or not.
    if (paged && pageSize > 0) limit = Math.min(limit, pageSize);
    if (paged && this.maxPageSize > 0) limit = Math.min(limit, this.maxPageSize);
    if (!paged && this.maxPageSize > 0 && limit > this.maxPageSize) {
      limit = this.maxPageSize;
      code = RESULT.sizeLimitExceeded;
    }
    if (sizeLimit > 0 && limit > sizeLimit) {
      limit = sizeLimit;
      code = RESULT.sizeLimitExceeded;
    }
    for (const dn of state.dns.slice(state.next, state.next + limit)) {
      const entry = this.entry(dn);
      if (entry) this.sendEntry(connection, id, entry, requested, false);
    }
    state.next += limit;
    let control: Buffer | undefined;
    if (paged) {
      let cookie = '';
      if (state.next < state.dns.length) {
        cookie = randomBytes(8).toString('hex');
        connection.pages.set(cookie, state);
      }
      control = this.pagedControl(cookie);
    }
    this.send(connection, id, this.result(0x65, code), control);
  }

  private pagedControl(cookie: string): Buffer {
    const value = seq(0x30, int(0), octets(Buffer.from(cookie, 'hex')));
    return seq(0xa0, seq(0x30, octets(PAGED), octets(value)));
  }

  private sendEntry(
    connection: Connection,
    id: number,
    entry: FakeEntry,
    requested: string[],
    operational: boolean,
  ): void {
    const wanted = requested.map((r) => r.toLowerCase());
    const all = wanted.length === 0 || wanted.includes('*');
    const plus = wanted.includes('+');
    if (wanted.length === 1 && wanted[0] === '1.1') {
      this.send(connection, id, seq(0x64, octets(entry.dn), seq(0x30)));
      return;
    }
    const parts: Buffer[] = [];
    for (const [key, attribute] of entry.attributes) {
      const isOperational = OPERATIONAL.has(key);
      const ranged = wanted.find((w) => w.startsWith(`${key};range=`));
      const named = wanted.includes(key);
      if (!(named || ranged || (all && !isOperational) || (plus && isOperational) || operational)) {
        continue;
      }
      let values = attribute.values;
      let name = attribute.name;
      if (this.maxValueRange > 0 && (ranged || values.length > this.maxValueRange)) {
        const match = /;range=(\d+)-(\d+|\*)/.exec(ranged ?? ';range=0-*');
        const from = Number(match?.[1] ?? 0);
        const askedTo = match?.[2] === '*' ? Number.POSITIVE_INFINITY : Number(match?.[2]);
        const to = Math.min(askedTo, from + this.maxValueRange - 1, values.length - 1);
        const end = to >= values.length - 1 ? '*' : String(to);
        values = values.slice(from, to + 1);
        name = `${attribute.name};range=${from}-${end}`;
      }
      parts.push(seq(0x30, octets(name), seq(0x31, ...values.map((v) => octets(v)))));
    }
    this.send(connection, id, seq(0x64, octets(entry.dn), seq(0x30, ...parts)));
  }

  private modifyOp(connection: Connection, id: number, op: Node): void {
    this.stats.modifies += 1;
    const [dnNode, changesNode] = children(op);
    const dn = text(dnNode);
    const entry = this.entry(dn);
    if (!entry) {
      this.send(connection, id, this.result(0x67, RESULT.noSuchObject));
      return;
    }
    const self = connection.boundDn !== null && normalizeDn(connection.boundDn) === normalizeDn(dn);
    const changes = (changesNode ? children(changesNode) : []).map((change) => {
      const [opNode, modification] = children(change);
      const [typeNode, valuesNode] = modification ? children(modification) : [];
      return {
        operation: toInt(opNode),
        type: text(typeNode),
        values: valuesNode ? children(valuesNode).map((v) => v.value) : [],
      };
    });
    const touchesPassword = changes.some((c) => /^(unicodepwd|userpassword)$/i.test(c.type));
    if (!this.isAdmin(connection) && !(self && touchesPassword)) {
      this.send(connection, id, this.result(0x67, RESULT.insufficientAccessRights));
      return;
    }
    if (touchesPassword) {
      // Active Directory takes passwords only over an encrypted connection.
      if (this.flavour === 'active_directory' && !connection.secure) {
        this.send(
          connection,
          id,
          this.result(
            0x67,
            RESULT.unwillingToPerform,
            '0000001F: SvcErr: DSID-031A12D2, problem 5003 (WILL_NOT_PERFORM)',
          ),
        );
        return;
      }
      const decode = (v: Buffer) =>
        this.flavour === 'active_directory'
          ? v.toString('utf16le').replace(/^"|"$/g, '')
          : v.toString('utf8');
      const removed = changes.find((c) => c.operation === 1);
      const added = changes.find((c) => c.operation === 0 || c.operation === 2);
      // A person changing their own password names the old one (delete) and the new (add);
      // the service account resets with a replace.
      if (!this.isAdmin(connection)) {
        const old = removed?.values[0];
        if (!old || decode(old) !== this.passwords.get(normalizeDn(dn))) {
          this.send(connection, id, this.result(0x67, RESULT.constraintViolation, 'old password'));
          return;
        }
      }
      const next = added?.values[0];
      if (!next) {
        this.send(connection, id, this.result(0x67, RESULT.constraintViolation, 'new password'));
        return;
      }
      this.passwords.set(normalizeDn(dn), decode(next));
      this.stamp(entry);
      this.send(connection, id, this.result(0x67, RESULT.success));
      return;
    }
    for (const change of changes) {
      const key = change.type.toLowerCase();
      const current = entry.attributes.get(key)?.values ?? [];
      const same = (a: Buffer, b: Buffer) => equalValues(key, a, b);
      if (change.operation === 0) {
        const added = change.values.filter((v) => !current.some((c) => same(c, v)));
        this.setValues(entry, entry.attributes.get(key)?.name ?? change.type, [
          ...current,
          ...added,
        ]);
      } else if (change.operation === 1) {
        if (
          change.values.length > 0 &&
          !change.values.every((v) => current.some((c) => same(c, v)))
        ) {
          this.send(connection, id, this.result(0x67, RESULT.noSuchAttribute));
          return;
        }
        const left =
          change.values.length === 0
            ? []
            : current.filter((c) => !change.values.some((v) => same(c, v)));
        this.setValues(entry, entry.attributes.get(key)?.name ?? change.type, left);
      } else {
        this.setValues(entry, entry.attributes.get(key)?.name ?? change.type, change.values);
      }
    }
    this.stamp(entry);
    this.send(connection, id, this.result(0x67, RESULT.success));
  }

  private async extended(
    connection: Connection,
    id: number,
    op: Node,
    rest?: Buffer,
  ): Promise<void> {
    const parts = children(op);
    const name = text(parts.find((p) => p.tag === 0x80));
    const value = parts.find((p) => p.tag === 0x81)?.value;
    if (name === START_TLS) {
      if (this.transport !== 'starttls' || connection.secure || !this.options.tls) {
        this.send(connection, id, this.result(0x78, RESULT.unwillingToPerform, 'no StartTLS here'));
        this.resume(connection, connection.socket, rest);
        return;
      }
      this.send(connection, id, this.result(0x78, RESULT.success, '', [octets(START_TLS, 0x8a)]));
      const secure = new tls.TLSSocket(connection.socket, {
        isServer: true,
        key: this.options.tls.key,
        cert: this.options.tls.cert,
      });
      secure.on('error', () => secure.destroy());
      this.sockets.add(secure);
      secure.on('close', () => this.sockets.delete(secure));
      const upgraded: Connection = {
        socket: secure,
        boundDn: null,
        secure: true,
        pages: new Map(),
      };
      this.listen(upgraded, secure);
      return;
    }
    if (name === PASSWORD_MODIFY) {
      const fields = value ? children(readNode(value, 0)?.node as Node) : [];
      const identity = text(fields.find((f) => f.tag === 0x80)) || connection.boundDn || '';
      const oldPassword = fields.find((f) => f.tag === 0x81)?.value.toString('utf8');
      const newPassword = fields.find((f) => f.tag === 0x82)?.value.toString('utf8');
      const self =
        connection.boundDn !== null && normalizeDn(identity) === normalizeDn(connection.boundDn);
      if (!self && !this.isAdmin(connection)) {
        this.send(connection, id, this.result(0x78, RESULT.insufficientAccessRights));
        return;
      }
      if (!this.isAdmin(connection) && oldPassword !== this.passwords.get(normalizeDn(identity))) {
        this.send(connection, id, this.result(0x78, RESULT.unwillingToPerform, 'old password'));
        return;
      }
      if (!newPassword) {
        this.send(
          connection,
          id,
          this.result(0x78, RESULT.unwillingToPerform, 'generated passwords are not offered'),
        );
        return;
      }
      this.passwords.set(normalizeDn(identity), newPassword);
      this.send(connection, id, this.result(0x78, RESULT.success));
      return;
    }
    this.send(connection, id, this.result(0x78, RESULT.unwillingToPerform, 'unknown operation'));
  }

  private resume(connection: Connection, socket: net.Socket, rest?: Buffer): void {
    this.listen(connection, socket);
    if (rest && rest.length > 0) socket.emit('data', rest);
  }
}
