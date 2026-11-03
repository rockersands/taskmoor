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

/**
 * A guard that leads the named hosts to a loopback server, so a provider that lives on public
 * hosts (Google's: `GOOGLE_HOSTS`) can be spoken to over its own https addresses with no network.
 * Any other host is refused, as `loopbackOutbound` refuses names.
 */
export function routedOutbound(hosts: readonly string[], target: string): OutboundGuard {
  const loopback = loopbackOutbound();
  const routed = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!hosts.includes(url.hostname)) throw new Error(`tests reach no such host: ${url.hostname}`);
    return loopback.fetch(new Request(`${target}${url.pathname}${url.search}`, request));
  };
  return { ...loopback, fetch: routed as typeof fetch };
}
