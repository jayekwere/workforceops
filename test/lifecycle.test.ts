import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoAuth, digest, type Identity } from '../src/security.js';
import { Store } from '../src/store.js';
import { createScimLab, ScimClient, project } from '../src/scim.js';
import { createApp } from '../src/app.js';
import { seedCatalog, employees } from '../src/catalog.js';
import { policies, type Employee } from '../src/workforce.js';
const actor = (subject: string, role: Identity['roles'][number], tenant = 'sandbox'): Identity => ({
  subject,
  tenant,
  roles: [role],
});
const requester = actor('r', 'requester'),
  reviewer = actor('v', 'reviewer'),
  operator = actor('o', 'operator');
async function setup() {
  let now = Date.now();
  const store = new Store(':memory:', 'k'.repeat(32), () => now),
    remote = new Store(':memory:', 's'.repeat(32));
  seedCatalog(store);
  const secrets = { directory: 'd'.repeat(32), collaboration: 'c'.repeat(32) },
    lab = createScimLab(remote, secrets);
  for (const provider of Object.keys(secrets))
    for (const employee of employees.filter((e) => e.id !== 'worker-002'))
      lab.seed(provider, {
        externalId: employee.id,
        userName: employee.email,
        displayName: employee.name,
        active: true,
        roles: [...policies.roles[employee.department]],
      });
  await lab.app.listen({ host: '127.0.0.1', port: 0 });
  const address = lab.app.server.address();
  if (!address || typeof address === 'string') throw new Error('Bind failed');
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
  const { auth, tokens } = await demoAuth('workforceops');
  const { app, service } = createApp({
    auth,
    store,
    baseUrl: 'http://127.0.0.1:4410',
    providers,
    faults: lab.faults,
  });
  return {
    store,
    remote,
    lab,
    providers,
    app,
    service,
    tokens,
    advance: (ms: number) => {
      now += ms;
    },
    close: async () => {
      await app.close();
      await lab.app.close();
      store.close();
      remote.close();
    },
  };
}
async function approved(
  s: Awaited<ReturnType<typeof setup>>,
  employeeId = 'worker-003',
  action: 'offboard' | 'onboard' | 'change-role' = 'offboard',
) {
  const p = await s.service.plan(requester, {
    employeeId,
    action,
    ...(action === 'change-role' ? { department: 'engineering' } : {}),
  });
  s.service.book.review(reviewer, p.id, p.digest, true);
  return p;
}
test('real HTTP SCIM onboarding, role movement and offboarding verify both managed services', async () => {
  const s = await setup();
  try {
    let p = await approved(s, 'worker-002', 'onboard');
    let result = await s.service.execute(operator, p.id, p.digest, 'onboard-key');
    assert.equal(result.status, 'completed');
    for (const provider of s.providers) {
      const user = await provider.find('worker-002');
      assert.ok(user?.active);
      assert.deepEqual(user.roles.map((r) => r.value).sort(), ['reader', 'support']);
    }
    p = await approved(s, 'worker-002', 'change-role');
    result = await s.service.execute(operator, p.id, p.digest, 'move-key');
    assert.equal(result.status, 'completed');
    assert.equal(
      s.store.need<Employee>('sandbox', 'employee', 'worker-002').department,
      'engineering',
    );
    p = await approved(s, 'worker-002', 'offboard');
    result = await s.service.execute(operator, p.id, p.digest, 'offboard-key');
    assert.equal(result.status, 'completed');
    for (const provider of s.providers) {
      const user = await provider.find('worker-002');
      assert.equal(user?.active, false);
      assert.deepEqual(user?.roles, []);
    }
    assert.equal(s.store.verify(), true);
    const data = result.result as { manualTasks: unknown[] };
    assert.equal(data.manualTasks.length, 2);
  } finally {
    await s.close();
  }
});
test('partial offboarding resumes only the known blocked step after service recovery', async () => {
  const s = await setup();
  try {
    const p = await approved(s);
    s.lab.faults.collaboration!.unavailable = true;
    let result = await s.service.execute(operator, p.id, p.digest, 'partial-key');
    assert.equal(result.status, 'blocked');
    assert.equal((await s.providers[0]!.find('worker-003'))!.active, false);
    assert.equal(s.remote.get<{ n: number }>('directory', 'writes', 'count')!.n, 1);
    s.lab.faults.collaboration!.unavailable = false;
    result = await s.service.execute(operator, p.id, p.digest, 'partial-key');
    assert.equal(result.status, 'completed');
    assert.equal(s.remote.get<{ n: number }>('directory', 'writes', 'count')!.n, 1);
    assert.equal(s.remote.get<{ n: number }>('collaboration', 'writes', 'count')!.n, 1);
    const repeated = await s.service.execute(operator, p.id, p.digest, 'partial-key');
    assert.equal(repeated.status, 'completed');
    assert.equal(s.remote.get<{ n: number }>('collaboration', 'writes', 'count')!.n, 1);
  } finally {
    await s.close();
  }
});
test('lost acknowledgement stays uncertain and reconciliation reads without another write', async () => {
  const s = await setup();
  try {
    const p = await approved(s);
    s.lab.faults.directory!.loseAcknowledgement = true;
    const result = await s.service.execute(operator, p.id, p.digest, 'uncertain-key');
    assert.equal(result.status, 'uncertain');
    assert.equal(s.remote.get<{ n: number }>('directory', 'writes', 'count')!.n, 1);
    assert.equal(
      (await s.service.execute(operator, p.id, p.digest, 'uncertain-key')).status,
      'uncertain',
    );
    await assert.rejects(s.service.reconcile(operator, p.id), { code: 'reconciliation_cooldown' });
    s.advance(31000);
    const reconciled = await s.service.reconcile(operator, p.id);
    assert.equal(reconciled.status, 'blocked');
    assert.equal(s.remote.get<{ n: number }>('directory', 'writes', 'count')!.n, 1);
    s.lab.faults.directory!.loseAcknowledgement = false;
    assert.equal(
      (await s.service.execute(operator, p.id, p.digest, 'uncertain-key')).status,
      'completed',
    );
  } finally {
    await s.close();
  }
});
test('unresolved operations lock an employee against competing approved plans', async () => {
  const s = await setup();
  try {
    const first = await approved(s),
      second = await approved(s);
    s.lab.faults.directory!.loseAcknowledgement = true;
    await s.service.execute(operator, first.id, first.digest, 'lock-key-one');
    await assert.rejects(s.service.execute(operator, second.id, second.digest, 'lock-key-two'), {
      code: 'employee_has_unresolved_operation',
    });
    assert.throws(() => s.service.cancel(operator, first.id), {
      code: 'only_known_blocked_operations_can_be_cancelled',
    });
  } finally {
    await s.close();
  }
});
test('stale account versions, employee changes and expiry reject without writing', async () => {
  for (const kind of ['account', 'employee', 'expiry']) {
    const s = await setup();
    try {
      const p = await approved(s);
      if (kind === 'account') {
        const before = await s.providers[0]!.find('worker-003');
        await s.providers[0]!.write(
          { ...project(before!), displayName: 'Changed display' },
          before,
        );
      }
      if (kind === 'employee') {
        const e = s.store.need<Employee>('sandbox', 'employee', 'worker-003');
        e.name = 'Changed record';
        s.store.put('sandbox', 'employee', e.id, e);
      }
      if (kind === 'expiry') s.advance(901000);
      if (kind === 'account') {
        const result = await s.service.execute(operator, p.id, p.digest, 'stale-key');
        assert.equal(result.status, 'blocked');
        assert.equal(s.remote.get<{ n: number }>('directory', 'writes', 'count')!.n, 1);
        s.service.cancel(operator, p.id);
      } else await assert.rejects(s.service.execute(operator, p.id, p.digest, 'stale-key'));
      assert.equal(s.remote.get('collaboration', 'writes', 'count'), undefined);
    } finally {
      await s.close();
    }
  }
});
test('concurrent retries reserve a single workflow and issue one write per service', async () => {
  const s = await setup();
  try {
    const p = await approved(s);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        s.service.execute(operator, p.id, p.digest, 'concurrent-key'),
      ),
    );
    assert.ok(results.some((p) => p.status === 'completed'));
    for (const name of ['directory', 'collaboration'])
      assert.equal(s.remote.get<{ n: number }>(name, 'writes', 'count')!.n, 1);
  } finally {
    await s.close();
  }
});
test('independent identities and cross-tenant workflow access are enforced', async () => {
  const s = await setup();
  try {
    const p = await s.service.plan(requester, { employeeId: 'worker-003', action: 'offboard' });
    assert.throws(
      () => s.service.book.review({ ...requester, roles: ['reviewer'] }, p.id, p.digest, true),
      { code: 'independent_reviewer_required' },
    );
    s.service.book.review(reviewer, p.id, p.digest, true);
    await assert.rejects(
      s.service.execute({ ...reviewer, roles: ['operator'] }, p.id, p.digest, 'forbidden-key'),
      { code: 'independent_operator_required' },
    );
    await assert.rejects(
      s.service.plan(
        { ...requester, tenant: 'isolated' },
        { employeeId: 'worker-003', action: 'offboard' },
      ),
      { code: 'record_not_found' },
    );
    assert.throws(() => s.service.book.get({ ...operator, tenant: 'isolated' }, p.id), {
      code: 'record_not_found',
    });
  } finally {
    await s.close();
  }
});
test('reconciliation finds departed active accounts, entitlement drift and orphans', async () => {
  const s = await setup();
  try {
    s.lab.seed('directory', {
      externalId: 'orphan-001',
      userName: 'orphan@example.invalid',
      displayName: 'Synthetic Orphan',
      active: true,
      roles: ['admin'],
    });
    const output = await s.service.drift(actor('viewer', 'viewer'));
    assert.match(JSON.stringify(output), /departed-user-active/);
    assert.match(JSON.stringify(output), /orphaned-managed-account/);
    assert.match(JSON.stringify(output), /entitlement-drift/);
  } finally {
    await s.close();
  }
});
test('HTTP contract guards roles, tenant isolation, extra fields, fault controls and evidence', async () => {
  const s = await setup();
  const h = (role: string) => ({
    host: '127.0.0.1:4410',
    authorization: 'Bearer ' + s.tokens[role],
  });
  try {
    assert.equal(
      (await s.app.inject({ url: '/api/employees', headers: { host: '127.0.0.1:4410' } }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/plans',
          headers: h('viewer'),
          payload: { employeeId: 'worker-003', action: 'offboard' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/plans',
          headers: h('requester'),
          payload: {
            employeeId: 'worker-003',
            action: 'offboard',
            endpoint: 'http://169.254.169.254',
          },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await s.app.inject({ url: '/api/overview', headers: h('outsider') })).json().employees
        .length,
      0,
    );
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/demo/fault',
          headers: h('requester'),
          payload: { provider: 'directory', unavailable: true },
        })
      ).statusCode,
      403,
    );
    const response = await s.app.inject({ url: '/api/overview', headers: h('viewer') });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().integrity, true);
    assert.equal(JSON.stringify(response.json()).includes('d'.repeat(32)), false);
  } finally {
    await s.close();
  }
});
test('SCIM conditional updates reject stale ETags and malformed or incomplete provider responses', async () => {
  const s = await setup();
  try {
    const provider = s.providers[0]!,
      before = await provider.find('worker-001');
    await provider.write({ ...project(before!), active: false }, before);
    await assert.rejects(provider.write({ ...project(before!), active: true }, before));
    const fake = new ScimClient(
      {
        alias: 'test',
        tenant: 'sandbox',
        endpoint: 'https://service.invalid/scim/v2',
        token: 'test-token',
        mode: 'external-scim',
      },
      false,
      async () =>
        new Response(JSON.stringify({ totalResults: 2, Resources: [] }), {
          headers: { 'content-type': 'application/scim+json' },
        }),
    );
    await assert.rejects(fake.list());
  } finally {
    await s.close();
  }
});
test('manual decisions are explicit attestations and cannot close before access verification', async () => {
  const s = await setup();
  try {
    const p = await approved(s);
    assert.throws(
      () =>
        s.service.manualTask(operator, p.id, {
          index: 0,
          decision: 'completed',
          note: 'Synthetic documented review',
        }),
      { code: 'access_verification_required' },
    );
    await s.service.execute(operator, p.id, p.digest, 'manual-task-key');
    s.service.manualTask(operator, p.id, {
      index: 0,
      decision: 'completed',
      note: 'Synthetic retention decision reviewed',
    });
    const updated = s.service.manualTask(operator, p.id, {
      index: 1,
      decision: 'not-applicable',
      note: 'Synthetic lab device requires no actual shipment',
    });
    assert.equal((updated.result as { workflowComplete: boolean }).workflowComplete, true);
    assert.throws(
      () =>
        s.service.manualTask(operator, p.id, {
          index: 1,
          decision: 'completed',
          note: 'Second review must not change the record',
        }),
      { code: 'manual_task_already_reviewed' },
    );
  } finally {
    await s.close();
  }
});
test('a reconciled lease prevents a stale worker from overwriting recovered state', async () => {
  const s = await setup();
  try {
    const p = await approved(s);
    const claimed = s.service.book.claim(operator, p.id, p.digest, 'crash-lease-key').plan;
    const old = structuredClone(claimed);
    const fenced = s.service.book.fence(operator, claimed);
    s.service.book.save(operator, fenced, 'blocked', { reason: 'test crash fencing' });
    assert.throws(() => s.service.book.save(operator, old, 'executing', {}), {
      code: 'execution_lease_changed',
    });
    assert.throws(() => s.service.book.assertLease(operator, old), {
      code: 'execution_lease_changed',
    });
  } finally {
    await s.close();
  }
});
test('a crashed claim before any dispatch can be recovered without a write', async () => {
  const s = await setup();
  try {
    const p = await approved(s);
    s.service.book.claim(operator, p.id, p.digest, 'crashed-claim');
    s.advance(31000);
    const recovered = await s.service.reconcile(operator, p.id);
    assert.equal(recovered.status, 'blocked');
    assert.equal(s.remote.get('directory', 'writes', 'count'), undefined);
    assert.equal(
      (await s.service.execute(operator, p.id, p.digest, 'crashed-claim')).status,
      'completed',
    );
  } finally {
    await s.close();
  }
});
