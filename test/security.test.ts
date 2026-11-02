import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Auth,
  demoAuth,
  canonical,
  digest,
  Fault,
  Limiter,
  equal,
  type Identity,
} from '../src/security.js';
import { Store } from '../src/store.js';
import { Approvals } from '../src/approvals.js';
import { secureApp } from '../src/http.js';
import { boundedJson, fixedUrl } from '../src/net.js';
let demo: Awaited<ReturnType<typeof demoAuth>>;
before(async () => {
  demo = await demoAuth('security-test');
});
const requester: Identity = { subject: 'requester', tenant: 'sandbox', roles: ['requester'] },
  reviewer: Identity = { subject: 'reviewer', tenant: 'sandbox', roles: ['reviewer'] },
  operator: Identity = { subject: 'operator', tenant: 'sandbox', roles: ['operator'] };
test('signed access tokens map application permissions from the server registry', async () => {
  const actor = await demo.auth.verify('Bearer ' + demo.tokens.requester);
  assert.deepEqual(actor.roles, ['requester']);
  assert.equal(actor.tenant, 'sandbox');
});
for (const kind of [
  'issuer',
  'audience',
  'expired',
  'future',
  'lifetime',
  'subject',
  'type',
  'jti',
  'forged-privileges',
])
  test('access-token constraint: ' + kind, async () => {
    const now = Math.floor(Date.now() / 1000);
    let jwt = new SignJWT({ roles: ['operator'], tenant: 'isolated' })
      .setProtectedHeader({
        alg: 'ES256',
        kid: 'ephemeral-demo',
        typ: kind === 'type' ? 'JWT' : 'at+jwt',
      })
      .setIssuer(kind === 'issuer' ? 'https://evil.invalid' : 'https://issuer.invalid/demo')
      .setAudience(kind === 'audience' ? 'wrong' : 'security-test')
      .setSubject(kind === 'subject' ? 'unknown' : 'demo-requester')
      .setIssuedAt()
      .setExpirationTime(
        kind === 'expired' ? now - 30 : kind === 'lifetime' ? now + 1000 : now + 60,
      );
    if (kind !== 'jti') jwt = jwt.setJti('unit-test');
    if (kind === 'future') jwt = jwt.setNotBefore(now + 60);
    const token = await jwt.sign(demo.privateKey);
    if (kind === 'forged-privileges') {
      const actor = await demo.auth.verify('Bearer ' + token);
      assert.deepEqual(actor.roles, ['requester']);
      assert.equal(actor.tenant, 'sandbox');
    } else await assert.rejects(demo.auth.verify('Bearer ' + token), { code: 'invalid_token' });
  });
test('missing, malformed, foreign, symmetric and oversized bearer tokens fail closed', async () => {
  for (const h of [undefined, '', 'Basic x', 'Bearer a.b.c', 'Bearer ' + 'x'.repeat(9000)])
    await assert.rejects(demo.auth.verify(h), { code: 'invalid_token' });
  const other = await generateKeyPair('ES256');
  const foreign = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'ephemeral-demo' })
    .setIssuer(demo.auth.config.issuer)
    .setAudience('security-test')
    .setSubject('demo-requester')
    .setIssuedAt()
    .setExpirationTime('1m')
    .setJti('foreign')
    .sign(other.privateKey);
  await assert.rejects(demo.auth.verify('Bearer ' + foreign));
  const symmetric = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .sign(new TextEncoder().encode('s'.repeat(32)));
  await assert.rejects(demo.auth.verify('Bearer ' + symmetric));
});
test('RS256 public verification works and private JWKS or duplicate registry subjects reject', async () => {
  const pair = await generateKeyPair('RS256', { extractable: true }),
    publicKey = { ...(await exportJWK(pair.publicKey)), kid: 'rsa', alg: 'RS256' };
  const auth = new Auth({ ...demo.auth.config, jwks: { keys: [publicKey] } });
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'rsa' })
    .setIssuer(demo.auth.config.issuer)
    .setAudience('security-test')
    .setSubject('demo-requester')
    .setIssuedAt()
    .setExpirationTime('1m')
    .setJti('rsa')
    .sign(pair.privateKey);
  assert.equal((await auth.verify('Bearer ' + token)).subject, 'demo-requester');
  const privateJwk = await exportJWK(pair.privateKey);
  assert.throws(() => new Auth({ ...demo.auth.config, jwks: { keys: [privateJwk] } }));
  assert.throws(
    () => new Auth({ ...demo.auth.config, jwks: { keys: [{ kty: 'oct', k: 'bad' }] } }),
  );
  assert.throws(() => new Auth({ ...demo.auth.config, identities: [requester, requester] }));
});
test('canonical request fingerprints preserve order of arrays and ignore object key order', () => {
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
  assert.equal(canonical(null), 'null');
  assert.equal(equal('a', 'é'), false);
});
test('rate buckets expire, enforce capacity and reject excess requests', () => {
  const limiter = new Limiter(2, 100, 1);
  limiter.take('a', 0);
  limiter.take('a', 1);
  assert.throws(() => limiter.take('a', 2), { code: 'rate_limited' });
  assert.throws(() => limiter.take('b', 3), { code: 'rate_limited' });
  limiter.take('b', 101);
});
test('audit edits and middle deletion fail verification; persistence and wrong-key checks work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-audit-')),
    file = join(dir, 'db'),
    key = 'k'.repeat(32);
  let store = new Store(file, key);
  try {
    store.audit(requester, 'one', 'allowed');
    store.audit(reviewer, 'two', 'approved');
    store.audit(operator, 'three', 'completed');
    assert.equal(store.verify(), true);
    store.close();
    store = new Store(file, key);
    assert.equal(store.verify(), true);
    assert.throws(() => new Store(file, 'x'.repeat(32)), /integrity/);
    const original = store.db.prepare('SELECT body FROM audit WHERE seq=1').get() as {
      body: string;
    };
    store.db.prepare("UPDATE audit SET body=json_set(body,'$.outcome','forged') WHERE seq=1").run();
    assert.equal(store.verify(), false);
    store.db.prepare('UPDATE audit SET body=? WHERE seq=1').run(original.body);
    assert.equal(store.verify(), true);
    store.db.prepare('DELETE FROM audit WHERE seq=2').run();
    assert.equal(store.verify(), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('nested transactions roll back only the failed nested savepoint', () => {
  const store = new Store(':memory:', 'k'.repeat(32));
  try {
    store.tx(() => {
      store.put('a', 'test', 'outer', { ok: true });
      assert.throws(() =>
        store.tx(() => {
          store.put('a', 'test', 'inner', { ok: false });
          throw new Fault(409, 'failure');
        }),
      );
    });
    assert.ok(store.get('a', 'test', 'outer'));
    assert.equal(store.get('a', 'test', 'inner'), undefined);
    assert.throws(() =>
      store.tx(() => {
        store.audit(requester, 'rollback', 'pending');
        throw new Error('rollback');
      }),
    );
    assert.equal(store.audits('sandbox').length, 0);
  } finally {
    store.close();
  }
});
test('independent review and execution reject self-approval even with combined roles', () => {
  const store = new Store(':memory:', 'k'.repeat(32)),
    book = new Approvals(store, 'policy');
  try {
    const p = book.plan(requester, { target: 'test' });
    const combined: Identity = { ...requester, roles: ['requester', 'reviewer', 'operator'] };
    assert.throws(() => book.review(combined, p.id, p.digest, true), {
      code: 'independent_reviewer_required',
    });
    book.review(reviewer, p.id, p.digest, true);
    assert.throws(() => book.claim(combined, p.id, p.digest, 'operation-key'), {
      code: 'independent_operator_required',
    });
    assert.throws(
      () => book.claim({ ...reviewer, roles: ['operator'] }, p.id, p.digest, 'operation-key'),
      { code: 'independent_operator_required' },
    );
    assert.throws(() => book.get({ ...operator, tenant: 'isolated' }, p.id), {
      code: 'record_not_found',
    });
  } finally {
    store.close();
  }
});
test('approval expiry, changed policy, wrong digest and rejection prevent dispatch', () => {
  let now = 100000;
  const store = new Store(':memory:', 'k'.repeat(32), () => now),
    book = new Approvals(store, 'policy');
  try {
    const p = book.plan(requester, { target: 'test' }, 100);
    assert.throws(() => book.review(reviewer, p.id, 'f'.repeat(64), true));
    book.review(reviewer, p.id, p.digest, true);
    assert.throws(
      () => new Approvals(store, 'changed').claim(operator, p.id, p.digest, 'operation-key'),
      { code: 'plan_expired_or_policy_changed' },
    );
    now += 101;
    assert.throws(() => book.claim(operator, p.id, p.digest, 'operation-key'), {
      code: 'plan_expired_or_policy_changed',
    });
    const q = book.plan(requester, {});
    book.review(reviewer, q.id, q.digest, false);
    assert.throws(() => book.claim(operator, q.id, q.digest, 'operation-two'), {
      code: 'plan_not_executable',
    });
  } finally {
    store.close();
  }
});
test('idempotency binds actor and exact operation and never claims a completed plan twice', () => {
  const store = new Store(':memory:', 'k'.repeat(32)),
    book = new Approvals(store, 'policy');
  try {
    const p = book.plan(requester, {});
    book.review(reviewer, p.id, p.digest, true);
    const first = book.claim(operator, p.id, p.digest, 'operation-key');
    assert.equal(first.claimed, true);
    book.save(operator, first.plan, 'completed', { verified: true });
    assert.equal(book.claim(operator, p.id, p.digest, 'operation-key').claimed, false);
    assert.throws(
      () =>
        book.claim({ ...operator, subject: 'another-operator' }, p.id, p.digest, 'operation-key'),
      { code: 'idempotency_conflict' },
    );
    const q = book.plan(requester, {});
    book.review(reviewer, q.id, q.digest, true);
    assert.throws(() => book.claim(operator, q.id, q.digest, 'operation-key'), {
      code: 'idempotency_conflict',
    });
  } finally {
    store.close();
  }
});
test('HTTP boundary rejects untrusted origins, hosts, tokens, oversized bodies and excess traffic', async () => {
  const store = new Store(':memory:', 'k'.repeat(32)),
    app = secureApp(demo.auth, store, 'http://127.0.0.1:4400', undefined, 2);
  app.post('/api/echo', async (req) => ({ accepted: !!req.body }));
  try {
    assert.equal(
      (await app.inject({ url: '/api/me', headers: { host: '127.0.0.1:4400' } })).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ url: '/health', headers: { host: 'evil.invalid' } })).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: '/health',
          headers: { host: '127.0.0.1:4400', origin: 'https://evil.invalid' },
        })
      ).statusCode,
      403,
    );
    const headers = { host: '127.0.0.1:4400', authorization: 'Bearer ' + demo.tokens.requester };
    const huge = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers,
      payload: { value: 'x'.repeat(300000) },
    });
    assert.equal(huge.statusCode, 413);
    assert.equal((await app.inject({ url: '/api/me', headers })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/me', headers })).statusCode, 429);
    const health = await app.inject({ url: '/health', headers: { host: '127.0.0.1:4400' } });
    assert.match(String(health.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(health.headers['access-control-allow-origin'], undefined);
  } finally {
    await app.close();
    store.close();
  }
});
test('fixed endpoint transport refuses unsafe URL shapes, redirects, oversized and malformed responses', async () => {
  for (const url of [
    'http://example.invalid',
    'https://u:p@example.invalid',
    'https://example.invalid/?secret=token',
    'https://example.invalid/#fragment',
  ])
    assert.throws(() => fixedUrl(url, true));
  assert.equal(fixedUrl('http://127.0.0.1:1234', true).hostname, '127.0.0.1');
  for (const response of [
    new Response('not-json', { headers: { 'content-type': 'application/json' } }),
    new Response('x'.repeat(300000), { headers: { 'content-type': 'application/json' } }),
    new Response('text', { headers: { 'content-type': 'text/plain' } }),
    new Response('', { status: 503 }),
  ]) {
    await assert.rejects(
      boundedJson(new URL('https://service.invalid'), { fetcher: async () => response }),
    );
  }
  let redirect = '';
  await boundedJson(new URL('https://service.invalid'), {
    fetcher: async (_url, init) => {
      redirect = init?.redirect ?? '';
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(redirect, 'error');
});

test('completed operation replay remains read-only after reopening durable state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ops-restart-')),
    file = join(directory, 'state'),
    key = 'k'.repeat(32);
  let store = new Store(file, key);
  try {
    let book = new Approvals(store, 'policy');
    const p = book.plan(requester, { target: 'bounded' });
    book.review(reviewer, p.id, p.digest, true);
    const claim = book.claim(operator, p.id, p.digest, 'durable-operation');
    book.save(operator, claim.plan, 'completed', { verified: true });
    store.close();
    store = new Store(file, key);
    book = new Approvals(store, 'policy');
    const replay = book.claim(operator, p.id, p.digest, 'durable-operation');
    assert.equal(replay.claimed, false);
    assert.equal(replay.plan.status, 'completed');
    assert.equal(store.verify(), true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed transaction start leaves the next request in a fresh immediate transaction', () => {
  const store = new Store(':memory:', 'k'.repeat(32));
  const original = store.db.exec.bind(store.db);
  let shouldFail = true;
  const statements: string[] = [];
  try {
    store.db.exec = (sql: string) => {
      statements.push(sql);
      if (shouldFail && sql === 'BEGIN IMMEDIATE') {
        shouldFail = false;
        throw new Error('Injected begin failure');
      }
      return original(sql);
    };
    assert.throws(() => store.tx(() => store.put('sandbox', 'probe', 'failed', {})));
    store.tx(() => store.put('sandbox', 'probe', 'next', { ok: true }));
    assert.equal(statements[1], 'BEGIN IMMEDIATE');
    assert.equal(store.get('sandbox', 'probe', 'failed'), undefined);
    assert.deepEqual(store.get('sandbox', 'probe', 'next'), { ok: true });
  } finally {
    store.db.exec = original;
    store.close();
  }
});
