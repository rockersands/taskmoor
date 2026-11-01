import type { FastifyInstance } from 'fastify';

/**
 * Response headers every answer gets unless its route set its own (M1-118; ASVS 14.4):
 *
 * - `X-Content-Type-Options: nosniff`, so no answer is read as another type (14.4.4);
 * - `Referrer-Policy: same-origin`: addresses inside the tracker (ticket keys, searches) never
 *   go to other sites in the Referer header (14.4.6);
 * - `Strict-Transport-Security` for a year on an instance served over HTTPS (the one that sets
 *   Secure cookies), so browsers never fall back to plain HTTP (14.4.5);
 * - API answers in JSON are marked `Content-Disposition: attachment`, so a browser that opens
 *   one directly never renders it as a page (14.4.2), and `Cache-Control: no-store` unless the
 *   route chose its own caching, so no browser or proxy keeps a copy (8.1.1, 8.2.1). Programs
 *   and `fetch` ignore the disposition.
 */
export function securityHeaders(app: FastifyInstance, options: { https: boolean }): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (!reply.hasHeader('x-content-type-options'))
      reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('referrer-policy')) reply.header('referrer-policy', 'same-origin');
    if (options.https && !reply.hasHeader('strict-transport-security')) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    const type = String(reply.getHeader('content-type') ?? '');
    if (
      (request.url.startsWith('/api/') || request.url.startsWith('/rest/')) &&
      /^application\/(?:[\w.+-]+\+)?json/.test(type) &&
      !reply.hasHeader('content-disposition')
    ) {
      reply.header('content-disposition', 'attachment; filename="api.json"');
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    }
    return payload;
  });
}
