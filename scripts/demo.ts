import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { environment } from './environment.js';
const e = await environment();
const headers = (role: string) => ({
  host: new URL('http://127.0.0.1:4410').host,
  authorization: 'Bearer ' + e.tokens[role],
});
async function call(path: string, role: string, body?: unknown) {
  const response = await e.app.inject({
    method: body === undefined ? 'GET' : 'POST',
    url: path,
    headers: headers(role),
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: response.statusCode, body: response.json() };
}
async function planAndApprove(data: unknown) {
  const p = await call('/api/plans', 'requester', data);
  assert.equal(p.status, 201);
  const reviewed = await call('/api/plans/' + p.body.id + '/review', 'reviewer', {
    digest: p.body.digest,
    approve: true,
  });
  assert.equal(reviewed.status, 200);
  return p.body;
}
try {
  const draft = (
    await call('/api/plans', 'requester', { employeeId: 'worker-003', action: 'offboard' })
  ).body;
  const unapproved = await call('/api/plans/' + draft.id + '/execute', 'operator', {
    digest: draft.digest,
    key: 'demo-offboard',
  });
  assert.equal(unapproved.status, 409);
  const selfReview = await call('/api/plans/' + draft.id + '/review', 'requester', {
    digest: draft.digest,
    approve: true,
  });
  assert.equal(selfReview.status, 403);
  assert.equal(
    (
      await call('/api/plans/' + draft.id + '/review', 'reviewer', {
        digest: draft.digest,
        approve: true,
      })
    ).status,
    200,
  );
  await call('/api/demo/fault', 'operator', { provider: 'collaboration', unavailable: true });
  const partial = await call('/api/plans/' + draft.id + '/execute', 'operator', {
    digest: draft.digest,
    key: 'demo-offboard',
  });
  assert.equal(partial.body.status, 'blocked');
  await call('/api/demo/fault', 'operator', { provider: 'collaboration', unavailable: false });
  const completed = await call('/api/plans/' + draft.id + '/execute', 'operator', {
    digest: draft.digest,
    key: 'demo-offboard',
  });
  assert.equal(completed.body.status, 'completed');
  await call('/api/plans/' + draft.id + '/execute', 'operator', {
    digest: draft.digest,
    key: 'demo-offboard',
  });
  for (const alias of ['directory', 'collaboration'])
    assert.equal(e.remote.get<{ n: number }>(alias, 'writes', 'count')!.n, 1);
  const onboard = await planAndApprove({ employeeId: 'worker-002', action: 'onboard' });
  assert.equal(
    (
      await call('/api/plans/' + onboard.id + '/execute', 'operator', {
        digest: onboard.digest,
        key: 'demo-onboard',
      })
    ).body.status,
    'completed',
  );
  const move = await planAndApprove({
    employeeId: 'worker-002',
    action: 'change-role',
    department: 'engineering',
  });
  assert.equal(
    (
      await call('/api/plans/' + move.id + '/execute', 'operator', {
        digest: move.digest,
        key: 'demo-role-change',
      })
    ).body.status,
    'completed',
  );
  const output = {
    scope: 'real HTTP against the local SCIM subset, synthetic identities',
    unapprovedStatus: unapproved.status,
    selfReviewStatus: selfReview.status,
    partialStatus: partial.body.status,
    resumedStatus: completed.body.status,
    verifiedProviders: completed.body.result.steps.map(
      (s: { provider: string; status: string }) => ({ provider: s.provider, status: s.status }),
    ),
    offboardWritesPerProvider: 1,
    manualTasksRemain: completed.body.result.manualTasks.length,
    onboarding: 'verified',
    roleChange: 'verified',
    auditIntegrity: e.store.verify(),
  };
  if (process.argv.includes('--write'))
    writeFileSync('evidence/demo.json', JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output, null, 2));
} finally {
  await e.close();
}
