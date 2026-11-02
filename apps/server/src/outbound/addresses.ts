import { BlockList, isIP } from 'node:net';
import { parseRange } from '../network/allowlist';

/**
 * What an outbound request may not reach (M1-118; ASVS 5.2.6, 12.6.1; ADR-110): addresses of
 * this machine, of the networks behind it and of cloud metadata services, IPv4 and IPv6, with
 * every form that carries an IPv4 address inside an IPv6 one (mapped, compatible, NAT64, 6to4)
 * judged by the IPv4 address it carries.
 */
export type RefusedReason =
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'cgnat'
  | 'link_local'
  | 'unique_local'
  | 'multicast'
  | 'metadata'
  | 'reserved';

/** Cloud metadata and instance services, named before the ranges that hold them. */
const METADATA = new Set([
  '169.254.169.254',
  '169.254.169.253',
  '169.254.170.2',
  '100.100.100.200',
  'fd00:ec2::254',
]);

const IPV4: readonly [string, number, RefusedReason][] = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link_local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'reserved'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'reserved'],
  ['198.51.100.0', 24, 'reserved'],
  ['203.0.113.0', 24, 'reserved'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const IPV6: readonly [string, number, RefusedReason][] = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['64:ff9b:1::', 48, 'private'],
  ['100::', 64, 'reserved'],
  ['2001::', 32, 'reserved'],
  ['2001:db8::', 32, 'reserved'],
  ['fc00::', 7, 'unique_local'],
  ['fe80::', 10, 'link_local'],
  ['fec0::', 10, 'private'],
  ['ff00::', 8, 'multicast'],
];

const lists = new Map<RefusedReason, BlockList>();
for (const [address, prefix, reason] of IPV4) {
  const list = lists.get(reason) ?? new BlockList();
  list.addSubnet(address, prefix, 'ipv4');
  lists.set(reason, list);
}
for (const [address, prefix, reason] of IPV6) {
  const list = lists.get(reason) ?? new BlockList();
  list.addSubnet(address, prefix, 'ipv6');
  lists.set(reason, list);
}

/** An address without brackets or zone, lower case. */
export function plainAddress(text: string): string {
  return text
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase();
}

/** The 16 bytes of an IPv6 address (any spelling `isIP` accepts), or null. */
export function ipv6Bytes(text: string): Uint8Array | null {
  const address = plainAddress(text);
  if (isIP(address) !== 6) return null;
  // A dotted IPv4 address at the end is the last two groups.
  const hex = address.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, a, b, c, d) =>
    [((Number(a) << 8) | Number(b)).toString(16), ((Number(c) << 8) | Number(d)).toString(16)].join(
      ':',
    ),
  );
  const [left = '', right] = hex.split('::');
  const groups = (s: string) => (s === '' ? [] : s.split(':').map((g) => Number.parseInt(g, 16)));
  const leftGroups = groups(left);
  const rightGroups = right === undefined ? [] : groups(right);
  const middle = 8 - leftGroups.length - rightGroups.length;
  const all = [...leftGroups, ...new Array<number>(Math.max(0, middle)).fill(0), ...rightGroups];
  const bytes = new Uint8Array(16);
  all.slice(0, 8).forEach((group, i) => {
    bytes[i * 2] = (group >> 8) & 0xff;
    bytes[i * 2 + 1] = group & 0xff;
  });
  return bytes;
}

const dottedOf = (bytes: Uint8Array, from: number) =>
  Array.from(bytes.subarray(from, from + 4)).join('.');

/**
 * The IPv4 address an IPv6 address carries, when it is one of the forms that hand traffic to
 * IPv4: mapped (`::ffff:a.b.c.d`), compatible (`::a.b.c.d`), NAT64 (`64:ff9b::/96`) and 6to4
 * (`2002::/16`). Null otherwise.
 */
export function embeddedIpv4(text: string): string | null {
  const b = ipv6Bytes(text);
  if (!b) return null;
  const zeros = (from: number, to: number) => b.subarray(from, to).every((x) => x === 0);
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return dottedOf(b, 12);
  if (zeros(0, 12)) {
    // :: and ::1 are IPv6's own unspecified and loopback addresses.
    if (zeros(12, 15) && (b[15] === 0 || b[15] === 1)) return null;
    return dottedOf(b, 12);
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) {
    return dottedOf(b, 12);
  }
  if (b[0] === 0x20 && b[1] === 0x02) return dottedOf(b, 2);
  return null;
}

/** Why an address may not be reached, or null when it is a public one. */
export function refusedReason(text: string): RefusedReason | null {
  const address = plainAddress(text);
  const version = isIP(address);
  if (version === 0) return 'reserved';
  if (version === 6) {
    const inner = embeddedIpv4(address);
    if (inner !== null) return refusedReason(inner);
  }
  const canonical = version === 6 ? canonicalIpv6(address) : address;
  if (METADATA.has(canonical)) return 'metadata';
  const family = version === 4 ? 'ipv4' : 'ipv6';
  for (const [reason, list] of lists) {
    if (list.check(address, family)) return reason;
  }
  return null;
}

/** The shortest spelling of an IPv6 address (for the metadata names). */
function canonicalIpv6(address: string): string {
  const b = ipv6Bytes(address);
  if (!b) return address;
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2)
    groups.push(((b[i] as number) * 256 + (b[i + 1] as number)).toString(16));
  // The longest run of zero groups becomes `::`.
  let best = { at: -1, length: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > best.length && j - i > 1) best = { at: i, length: j - i };
    i = j;
  }
  if (best.at < 0) return groups.join(':');
  const left = groups.slice(0, best.at).join(':');
  const right = groups.slice(best.at + best.length).join(':');
  return `${left}::${right}`;
}

/**
 * The operator's allow list (`TASKMOOR_OUTBOUND_ALLOW`): host names (`hooks.corp.example`),
 * every host below a domain (`*.corp.example`), addresses and CIDR ranges, IPv4 or IPv6,
 * separated by commas or spaces. A named host is reached at whatever it resolves to; an
 * address or range lets any host that resolves into it through.
 */
export interface OutboundAllow {
  hosts: ReadonlySet<string>;
  domains: readonly string[];
  ranges: BlockList;
  /** The entries as given, for the start-up log and the ADR's examples. */
  entries: readonly string[];
}

export class OutboundAllowError extends Error {}

export function parseOutboundAllow(text: string | undefined): OutboundAllow {
  const hosts = new Set<string>();
  const domains: string[] = [];
  const ranges = new BlockList();
  const entries: string[] = [];
  for (const raw of (text ?? '').split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    entries.push(entry);
    const range = parseRange(entry);
    if (range) {
      ranges.addSubnet(range.address, range.prefix, range.family);
      continue;
    }
    const name = entry.startsWith('*.') ? entry.slice(2) : entry;
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
        name,
      )
    ) {
      throw new OutboundAllowError(`not a host name, address or CIDR range: ${raw}`);
    }
    if (entry.startsWith('*.')) domains.push(name);
    else hosts.add(name);
  }
  return { hosts, domains, ranges, entries };
}

/** Whether the operator named this host (exactly, or under an allowed domain). */
export function hostAllowed(allow: OutboundAllow, host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return allow.hosts.has(name) || allow.domains.some((d) => name === d || name.endsWith(`.${d}`));
}

/** Whether the operator allowed this address by an address or range. */
export function addressAllowed(allow: OutboundAllow, text: string): boolean {
  const address = plainAddress(text);
  const version = isIP(address);
  if (version === 0) return false;
  if (allow.ranges.check(address, version === 4 ? 'ipv4' : 'ipv6')) return true;
  const inner = version === 6 ? embeddedIpv4(address) : null;
  return inner !== null && allow.ranges.check(inner, 'ipv4');
}
