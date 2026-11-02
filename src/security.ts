import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createLocalJWKSet,
  jwtVerify,
  generateKeyPair,
  exportJWK,
  SignJWT,
  type JSONWebKeySet,
} from 'jose';
import { z } from 'zod';
export class Fault extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const Text = z.string().min(1).max(160);
export const IdentitySchema = z
  .object({
    subject: Text,
    tenant: Id,
    roles: z
      .array(z.enum(['requester', 'reviewer', 'operator', 'viewer']))
      .min(1)
      .max(4),
  })
  .strict();
export type Identity = z.infer<typeof IdentitySchema>;
export function requireRole(actor: Identity, ...roles: Identity['roles']) {
  if (!roles.some((r) => actor.roles.includes(r))) throw new Fault(403, 'forbidden');
}
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object')
    return (
      '{' +
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
        .join(',') +
      '}'
    );
  return JSON.stringify(v) ?? 'null';
}
export const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
export const mac = (key: string, v: unknown) =>
  createHmac('sha256', key).update(canonical(v)).digest('hex');
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export interface AuthConfig {
  issuer: string;
  audience: string;
  jwks: JSONWebKeySet;
  identities: Identity[];
}
export class Auth {
  private keys;
  private registry: Map<string, Identity>;
  constructor(readonly config: AuthConfig) {
    if (
      !config.issuer ||
      !config.audience ||
      !config.jwks.keys.length ||
      config.jwks.keys.some((k) => 'd' in k || k.kty === 'oct')
    )
      throw new Error('Public asymmetric verification configuration required');
    this.keys = createLocalJWKSet(config.jwks);
    const ids = z.array(IdentitySchema).min(1).max(1000).parse(config.identities);
    this.registry = new Map(ids.map((i) => [i.subject, Object.freeze(i)]));
    if (this.registry.size !== ids.length) throw new Error('Duplicate subject');
  }
  async verify(header: string | undefined): Promise<Identity> {
    if (!header?.startsWith('Bearer ') || header.length > 8192)
      throw new Fault(401, 'invalid_token');
    try {
      const { payload, protectedHeader } = await jwtVerify(header.slice(7), this.keys, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ['ES256', 'RS256'],
        requiredClaims: ['sub', 'iat', 'exp', 'jti'],
        maxTokenAge: '15m',
        clockTolerance: 2,
      });
      if (
        protectedHeader.typ !== 'at+jwt' ||
        typeof payload.jti !== 'string' ||
        !payload.jti ||
        payload.exp! - payload.iat! > 900
      )
        throw new Error('Token contract');
      const who = this.registry.get(payload.sub!);
      if (!who) throw new Error('Unregistered subject');
      return who;
    } catch {
      throw new Fault(401, 'invalid_token');
    }
  }
}
export async function demoAuth(audience: string) {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const key = { ...(await exportJWK(publicKey)), kid: 'ephemeral-demo', alg: 'ES256', use: 'sig' };
  const identities: Identity[] = ['requester', 'reviewer', 'operator', 'viewer'].map((role) => ({
    subject: 'demo-' + role,
    tenant: 'sandbox',
    roles: [role as Identity['roles'][number]],
  }));
  identities.push({
    subject: 'demo-outsider',
    tenant: 'isolated',
    roles: ['requester', 'reviewer', 'operator', 'viewer'],
  });
  const issuer = 'https://issuer.invalid/demo';
  const tokens = Object.fromEntries(
    await Promise.all(
      identities.map(async (i) => [
        i.subject.replace('demo-', ''),
        await new SignJWT({})
          .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: key.kid })
          .setIssuer(issuer)
          .setAudience(audience)
          .setSubject(i.subject)
          .setJti(randomUUID())
          .setIssuedAt()
          .setExpirationTime('15m')
          .sign(privateKey),
      ]),
    ),
  );
  return {
    auth: new Auth({ issuer, audience, jwks: { keys: [key] }, identities }),
    tokens,
    privateKey,
  };
}
export class Limiter {
  private values = new Map<string, { n: number; until: number }>();
  constructor(
    private limit = 120,
    private window = 60000,
    private capacity = 4096,
  ) {}
  take(key: string, now = Date.now()) {
    for (const [k, v] of this.values) if (v.until <= now) this.values.delete(k);
    let v = this.values.get(key);
    if (!v) {
      if (this.values.size >= this.capacity) throw new Fault(429, 'rate_limited');
      v = { n: 0, until: now + this.window };
      this.values.set(key, v);
    }
    if (++v.n > this.limit) throw new Fault(429, 'rate_limited');
  }
}
