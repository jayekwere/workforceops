import { demoAuth } from '../src/security.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
import { createScimLab, ScimClient } from '../src/scim.js';
import { seedCatalog, employees } from '../src/catalog.js';
import { policies } from '../src/workforce.js';
export async function environment(baseUrl = 'http://127.0.0.1:4410') {
  const { auth, tokens } = await demoAuth('workforceops'),
    store = new Store(':memory:', 'k'.repeat(32));
  const remote = new Store(':memory:', 's'.repeat(32)),
    secrets = { directory: 'd'.repeat(32), collaboration: 'c'.repeat(32) },
    lab = createScimLab(remote, secrets);
  seedCatalog(store);
  for (const alias of Object.keys(secrets))
    for (const e of employees.filter((e) => e.id !== 'worker-002'))
      lab.seed(alias, {
        externalId: e.id,
        userName: e.email,
        displayName: e.name,
        active: true,
        roles: [...policies.roles[e.department]],
      });
  await lab.app.listen({ port: 0, host: '127.0.0.1' });
  const address = lab.app.server.address();
  if (!address || typeof address === 'string') throw new Error('Lab bind failed');
  const providers = Object.keys(secrets).map(
    (alias) =>
      new ScimClient(
        {
          alias,
          tenant: 'sandbox',
          endpoint: `http://127.0.0.1:${address.port}/${alias}/scim/v2`,
          token: secrets[alias as keyof typeof secrets],
          mode: 'local-scim',
        },
        true,
      ),
  );
  const { app, service } = createApp({ auth, store, baseUrl, providers, faults: lab.faults });
  return {
    app,
    service,
    store,
    auth,
    tokens,
    remote,
    lab,
    providers,
    close: async () => {
      await app.close();
      await lab.app.close();
      store.close();
      remote.close();
    },
  };
}
