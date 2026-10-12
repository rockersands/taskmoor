import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  context,
  defaultTextMapGetter,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { PoolStats, QueryEvent } from '@taskmoor/db';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Observability (ADR-023, OPS-011): Prometheus metrics on an internal port, OpenTelemetry traces
 * exported over OTLP only when an endpoint is configured, and the hooks that feed both from
 * HTTP requests and database statements. The server is bundled (ADR-021), so nothing here
 * relies on patching modules: requests are traced by Fastify hooks and statements by the
 * database client's query callback.
 */

/** Paths probed by orchestrators every few seconds; they are neither traced nor timed. */
const PROBES = new Set(['/health', '/ready']);

const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface Metrics {
  registry: Registry;
  http: Histogram<'method' | 'route' | 'status_code'>;
  query: Histogram<'outcome'>;
}

export interface MetricsOptions {
  version: string;
  roles: readonly string[];
  /** Connection counts of the database pool, read at every scrape. */
  pool?: () => PoolStats | undefined;
  /** The instance data directory; its `backups/last` marker gives the backup age. */
  dataDir?: string;
  /** Process metrics (CPU, memory, event loop lag); off in tests for speed. */
  processMetrics?: boolean;
}

export function createMetrics(options: MetricsOptions): Metrics {
  const registry = new Registry();
  if (options.processMetrics ?? true) collectDefaultMetrics({ register: registry });
  new Gauge({
    name: 'taskmoor_build_info',
    help: 'Version and roles of this process; always 1',
    labelNames: ['version', 'roles'],
    registers: [registry],
  }).set({ version: options.version, roles: options.roles.join(',') }, 1);
  const http = new Histogram({
    name: 'taskmoor_http_request_duration_seconds',
    help: 'HTTP request latency by route pattern',
    labelNames: ['method', 'route', 'status_code'],
    buckets: SECONDS,
    registers: [registry],
  });
  const query = new Histogram({
    name: 'taskmoor_db_query_duration_seconds',
    help: 'Database statement latency',
    labelNames: ['outcome'],
    buckets: SECONDS,
    registers: [registry],
  });
  const readPool = options.pool;
  if (readPool) {
    new Gauge({
      name: 'taskmoor_db_pool_connections',
      help: 'Database pool connections by state (total, idle, waiting callers, max)',
      labelNames: ['state'],
      registers: [registry],
      collect() {
        const stats = readPool();
        if (!stats) return;
        for (const state of ['total', 'idle', 'waiting', 'max'] as const) {
          this.set({ state }, stats[state]);
        }
      },
    });
  }
  const dataDir = options.dataDir;
  if (dataDir) {
    new Gauge({
      name: 'taskmoor_backup_age_seconds',
      help: 'Seconds since the last completed backup; absent before the first one',
      registers: [registry],
      collect() {
        const marker = join(dataDir, 'backups', 'last');
        this.reset();
        if (existsSync(marker)) this.set((Date.now() - statSync(marker).mtimeMs) / 1000);
      },
    });
  }
  return { registry, http, query };
}

export interface Tracing {
  tracer: Tracer;
  /** Flushes and stops the exporter. */
  shutdown(): Promise<void>;
}

/**
 * Starts tracing when there is somewhere to send spans: an OTLP endpoint from the standard
 * `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` variables, or an
 * exporter passed in (tests). Returns undefined otherwise, and nothing leaves the server.
 */
export function startTracing(options: {
  version: string;
  roles: readonly string[];
  env?: Record<string, string | undefined>;
  exporter?: SpanExporter;
}): Tracing | undefined {
  const env = options.env ?? process.env;
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!options.exporter && !endpoint) return undefined;
  // Context follows async work through AsyncLocalStorage, so a statement finds its request.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const processor = options.exporter
    ? new SimpleSpanProcessor(options.exporter)
    : // The exporter reads the endpoint, headers and timeout from the OTEL_* variables itself.
      new BatchSpanProcessor(new OTLPTraceExporter());
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME || 'taskmoor',
      [ATTR_SERVICE_VERSION]: options.version,
      'taskmoor.roles': options.roles.join(','),
    }),
    spanProcessors: [processor],
  });
  return {
    tracer: provider.getTracer('taskmoor-server', options.version),
    shutdown: () => provider.shutdown(),
  };
}

const propagator = new W3CTraceContextPropagator();

const routeOf = (request: FastifyRequest) => request.routeOptions.url ?? 'unmatched';

/**
 * Times every request into the metrics and, with a tracer, opens a server span that continues
 * an incoming `traceparent` and is the active context for the handler, so statements made while
 * serving the request become its children.
 */
export function instrumentApp(
  app: FastifyInstance,
  options: { metrics?: Metrics; tracer?: Tracer },
): void {
  const { metrics, tracer } = options;
  const spans = new WeakMap<FastifyRequest, Span>();
  const path = (request: FastifyRequest) => request.url.split('?')[0] ?? '';

  if (tracer) {
    app.addHook('onRequest', (request, _reply, done) => {
      if (PROBES.has(path(request))) return done();
      const parent = propagator.extract(ROOT_CONTEXT, request.headers, defaultTextMapGetter);
      const route = routeOf(request);
      const span = tracer.startSpan(
        `${request.method} ${route}`,
        {
          kind: SpanKind.SERVER,
          attributes: {
            'http.request.method': request.method,
            'http.route': route,
            'url.path': path(request),
          },
        },
        parent,
      );
      spans.set(request, span);
      context.with(trace.setSpan(parent, span), done);
    });
    app.addHook('onError', (request, _reply, error, done) => {
      spans.get(request)?.recordException(error);
      done();
    });
  }

  app.addHook('onResponse', (request, reply, done) => {
    if (!PROBES.has(path(request))) {
      const route = routeOf(request);
      metrics?.http.observe(
        { method: request.method, route, status_code: String(reply.statusCode) },
        reply.elapsedTime / 1000,
      );
      const span = spans.get(request);
      if (span) {
        span.setAttribute('http.response.status_code', reply.statusCode);
        if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      }
    }
    done();
  });
}

/**
 * The database client's query callback: times the statement and, inside a traced request,
 * records it as a client span with its SQL text (never its parameters).
 */
export function queryObserver(options: {
  metrics?: Metrics;
  tracer?: Tracer;
}): (event: QueryEvent) => void {
  return (event) => {
    options.metrics?.query.observe(
      { outcome: event.error ? 'error' : 'ok' },
      event.durationMs / 1000,
    );
    const tracer = options.tracer;
    if (!tracer) return;
    const active = context.active();
    if (!trace.getSpan(active)) return;
    const end = Date.now();
    const span = tracer.startSpan(
      'db.query',
      {
        kind: SpanKind.CLIENT,
        startTime: end - event.durationMs,
        attributes: { 'db.system.name': 'postgresql', 'db.query.text': event.sql },
      },
      active,
    );
    if (event.error) {
      span.recordException(event.error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end(end);
  };
}

/** The internal `/metrics` endpoint, on its own listener so it is never exposed with the app. */
export async function buildMetricsServer(metrics: Metrics): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get('/metrics', async (_request, reply) => {
    reply.type(metrics.registry.contentType);
    return metrics.registry.metrics();
  });
  return app;
}
