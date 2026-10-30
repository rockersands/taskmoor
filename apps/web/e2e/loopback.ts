import { networkInterfaces } from 'node:os';

/**
 * The address that listens on both loopback addresses where the machine has IPv6, since a
 * name under localhost may resolve to either; on a machine without IPv6 (some containers)
 * listening on "::" fails, and names under localhost resolve to 127.0.0.1 only.
 */
export function anyLoopback(): '::' | '0.0.0.0' {
  const ipv6 = Object.values(networkInterfaces()).some((list) =>
    (list ?? []).some((a) => a.family === 'IPv6' && a.internal),
  );
  return ipv6 ? '::' : '0.0.0.0';
}
