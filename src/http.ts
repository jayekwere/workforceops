import Fastify, { type FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError, z } from 'zod';
import { Auth, Fault, Limiter, type Identity, requireRole } from './security.js';
import { Store } from './store.js';
import type { Approvals } from './approvals.js';
declare module 'fastify' {
  interface FastifyRequest {
    identity: Identity;
  }
}
export function secureApp(
  auth: Auth,
  store: Store,
  baseUrl: string,
  webRoot = resolve('dist/web'),
  requestLimit = 120,
) {
  const base = new URL(baseUrl);
  const app = Fastify({
    logger: false,
    bodyLimit: 262144,
    requestTimeout: 10000,
    connectionTimeout: 8000,
    trustProxy: false,
    routerOptions: { maxParamLength: 100 },
  });
  app.decorateRequest('identity');
  const ips = new Limiter(requestLimit * 4),
    subjects = new Limiter(requestLimit);
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      )
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (base.protocol === 'https:') reply.header('strict-transport-security', 'max-age=31536000');
    ips.take(req.ip);
    if (
      req.headers.host !== base.host ||
      (req.headers.origin && req.headers.origin !== base.origin)
    )
      throw new Fault(403, 'untrusted_origin');
    if (req.url.startsWith('/api/')) {
      try {
        req.identity = await auth.verify(req.headers.authorization);
        subjects.take(req.identity.subject);
      } catch (e) {
        if (e instanceof Fault && e.status === 401) reply.header('www-authenticate', 'Bearer');
        throw e;
      }
    }
  });
  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof Fault) return reply.status(e.status).send({ error: e.code });
    const code = typeof e === 'object' && e !== null && 'statusCode' in e ? e.statusCode : 0;
    if (e instanceof ZodError || code === 400)
      return reply.status(400).send({ error: 'invalid_request' });
    if (code === 413) return reply.status(413).send({ error: 'payload_too_large' });
    if (code === 415) return reply.status(415).send({ error: 'unsupported_media_type' });
    return reply.status(500).send({ error: 'internal_error' });
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/api/me', async (req) => req.identity);
  app.get('/api/audit', async (req) => {
    requireRole(req.identity, 'viewer', 'reviewer', 'operator');
    return { integrity: store.verify(), events: store.audits(req.identity.tenant) };
  });
  for (const [url, file, type] of [
    ['/', 'index.html', 'text/html'],
    ['/app.js', 'app.js', 'application/javascript'],
    ['/style.css', 'style.css', 'text/css'],
  ])
    app.get(url!, async (_req, reply) =>
      reply.type(type!).send(readFileSync(resolve(webRoot, file!))),
    );
  return app;
}
export const idParam = (req: FastifyRequest) =>
  z.object({ id: z.string().uuid() }).parse(req.params).id;
export const ExecuteSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    key: z.string().regex(/^[a-zA-Z0-9-]{8,100}$/),
  })
  .strict();
export function planRoutes<T>(app: ReturnType<typeof secureApp>, book: Approvals<T>) {
  app.get('/api/plans', async (req) => ({ plans: book.list(req.identity) }));
  app.get('/api/plans/:id', async (req) => book.get(req.identity, idParam(req)));
  app.post('/api/plans/:id/review', async (req) => {
    const { digest, approve } = z
      .object({ digest: z.string().length(64), approve: z.boolean() })
      .strict()
      .parse(req.body);
    return book.review(req.identity, idParam(req), digest, approve);
  });
}
