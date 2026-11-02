import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { configuration } from './config.js';
import { Store } from './store.js';
import { ScimClient, createScimLab } from './scim.js';
import { createApp } from './app.js';
import { EmployeeSchema, policies } from './workforce.js';
import { seedCatalog, employees } from './catalog.js';
const c = await configuration('workforceops', 4410),
  store = new Store(c.db, c.key);
let closeLab: () => Promise<void> = async () => {};
let clients: ScimClient[] = [];
let faults;
if (c.demo) {
  if (c.db !== ':memory:') throw new Error('Local SCIM demo requires ephemeral core storage');
  seedCatalog(store);
  const providerStore = new Store(':memory:', randomBytes(32).toString('hex'));
  const tokens: Record<string, string> = {
    directory: randomBytes(32).toString('hex'),
    collaboration: randomBytes(32).toString('hex'),
  };
  const lab = createScimLab(providerStore, tokens);
  for (const provider of ['directory', 'collaboration'])
    for (const e of employees.filter((e) => e.id !== 'worker-002'))
      lab.seed(provider, {
        externalId: e.id,
        userName: e.email,
        displayName: e.name,
        active: true,
        roles: [...policies.roles[e.department]],
      });
  await lab.app.listen({ port: 0, host: '127.0.0.1' });
  const address = lab.app.server.address();
  if (!address || typeof address === 'string') throw new Error('Lab bind failed');
  clients = ['directory', 'collaboration'].map(
    (alias) =>
      new ScimClient(
        {
          alias,
          tenant: 'sandbox',
          endpoint: `http://127.0.0.1:${address.port}/${alias}/scim/v2`,
          token: tokens[alias]!,
          mode: 'local-scim',
        },
        true,
      ),
  );
  faults = lab.faults;
  closeLab = async () => {
    await lab.app.close();
    providerStore.close();
  };
} else {
  if (!process.env.PROVIDER_CONFIG || !process.env.EMPLOYEE_CATALOG)
    throw new Error('PROVIDER_CONFIG and EMPLOYEE_CATALOG required');
  const providers = z
    .array(
      z
        .object({
          alias: z.string().regex(/^[a-z0-9-]{1,64}$/),
          tenant: z.string().regex(/^[a-z0-9-]{1,64}$/),
          endpoint: z.url(),
          tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
        })
        .strict(),
    )
    .min(1)
    .max(10)
    .parse(JSON.parse(readFileSync(process.env.PROVIDER_CONFIG, 'utf8')));
  if (new Set(providers.map((p) => p.tenant + ':' + p.alias)).size !== providers.length)
    throw new Error('Duplicate provider');
  clients = providers.map((p) => {
    const token = process.env[p.tokenEnv];
    if (!token || token.length < 16) throw new Error('Dedicated provider credential required');
    return new ScimClient({ ...p, token, mode: 'external-scim' });
  });
  for (const e of z
    .array(EmployeeSchema)
    .max(200)
    .parse(JSON.parse(readFileSync(process.env.EMPLOYEE_CATALOG, 'utf8'))))
    if (!store.get(e.tenant, 'employee', e.id)) store.put(e.tenant, 'employee', e.id, e);
}
const { app } = createApp({
  auth: c.auth,
  store,
  baseUrl: c.baseUrl,
  providers: clients,
  ...(faults ? { faults } : {}),
});
await app.listen({ port: c.port, host: c.host });
console.log(`WorkforceOps listening at ${c.baseUrl}`);
if (c.demo)
  console.log('Ephemeral demo tokens (15 minutes):\n' + JSON.stringify(c.tokens, null, 2));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app
      .close()
      .then(closeLab)
      .then(() => {
        store.close();
        process.exit(0);
      });
  });
