import { createOutboundGuard, type OutboundGuard } from '../outbound/guard';

/**
 * An outbound guard that lets loopback through, for tests whose fake provider, identity provider
 * or webhook receiver listens on 127.0.0.1 (ADR-110). Names are never resolved over the network:
 * only `localhost` resolves, to loopback.
 */
export function loopbackOutbound(): OutboundGuard {
  return createOutboundGuard({
    allow: '127.0.0.1,::1',
    resolve: async (host) => {
      if (host === 'localhost') return [{ address: '127.0.0.1', family: 4 }];
      throw new Error(`tests resolve no names: ${host}`);
    },
  });
}
