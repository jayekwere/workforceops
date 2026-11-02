import { z } from 'zod';
import { secureApp, planRoutes, idParam, ExecuteSchema } from './http.js';
import { Auth, requireRole, Fault } from './security.js';
import { Store } from './store.js';
import { Workforce } from './workforce.js';
import type { ScimClient, LabFault } from './scim.js';
export function createApp(o: {
  auth: Auth;
  store: Store;
  baseUrl: string;
  providers: ScimClient[];
  webRoot?: string;
  faults?: Record<string, LabFault>;
}) {
  const app = secureApp(o.auth, o.store, o.baseUrl, o.webRoot),
    service = new Workforce(o.store, o.providers);
  planRoutes(app, service.book);
  app.get('/api/employees', async (req) => ({ employees: service.employees(req.identity) }));
  app.post('/api/plans', async (req, reply) =>
    reply.status(201).send(await service.plan(req.identity, req.body)),
  );
  app.post('/api/plans/:id/execute', async (req) => {
    const body = ExecuteSchema.parse(req.body);
    return service.execute(req.identity, idParam(req), body.digest, body.key);
  });
  app.post('/api/plans/:id/cancel', async (req) => service.cancel(req.identity, idParam(req)));
  app.post('/api/plans/:id/manual-task', async (req) =>
    service.manualTask(req.identity, idParam(req), req.body),
  );
  app.post('/api/plans/:id/reconcile', async (req) =>
    service.reconcile(req.identity, idParam(req)),
  );
  app.get('/api/drift', async (req) => service.drift(req.identity));
  app.get('/api/overview', async (req) => {
    requireRole(req.identity, 'viewer', 'operator', 'reviewer', 'requester');
    const plans = service.book.list(req.identity);
    return {
      employees: service.employees(req.identity),
      plans,
      providers: o.providers
        .filter((p) => p.config.tenant === req.identity.tenant)
        .map((p) => ({ alias: p.config.alias, mode: p.config.mode, fingerprint: p.fingerprint })),
      audit: o.store.audits(req.identity.tenant, 30),
      integrity: o.store.verify(),
    };
  });
  if (o.faults)
    app.post('/api/demo/fault', async (req) => {
      requireRole(req.identity, 'operator');
      const b = z
        .object({
          provider: z.enum(['directory', 'collaboration']),
          unavailable: z.boolean(),
          loseAcknowledgement: z.boolean().default(false),
        })
        .strict()
        .parse(req.body);
      const provider = o.providers.find(
        (p) =>
          p.config.alias === b.provider &&
          p.config.tenant === req.identity.tenant &&
          p.config.mode === 'local-scim',
      );
      if (!provider || !Object.hasOwn(o.faults!, b.provider))
        throw new Fault(403, 'demo_provider_not_authorized');
      // Commit the audit before changing process-local lab state. A full audit fails closed.
      o.store.tx(() => o.store.audit(req.identity, 'demo.fault-changed', 'completed', b));
      o.faults![b.provider] = {
        unavailable: b.unavailable,
        loseAcknowledgement: b.loseAcknowledgement,
      };
      return { scope: 'local-scim-contract-service', ...b };
    });
  return { app, service };
}
