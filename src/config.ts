import { readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Auth, demoAuth, type AuthConfig } from './security.js';
export async function configuration(name: string, port: number) {
  const demo = process.env.DEMO === '1',
    baseUrl = process.env.BASE_URL ?? `http://127.0.0.1:${port}`,
    url = new URL(baseUrl);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('BASE_URL must be an origin');
  if (!demo && url.protocol !== 'https:')
    throw new Error('Configured mode requires an HTTPS external origin and trusted TLS proxy');
  let auth: Auth,
    tokens: Record<string, string> = {};
  if (demo) {
    const d = await demoAuth(name);
    auth = d.auth;
    tokens = d.tokens;
  } else {
    const file = process.env.AUTH_CONFIG;
    if (!file) throw new Error('AUTH_CONFIG is required');
    if (statSync(file).mode & 0o022)
      throw new Error('AUTH_CONFIG must not be group or world writable');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as AuthConfig;
    if (new URL(raw.issuer).protocol !== 'https:' || raw.audience !== url.origin)
      throw new Error('Issuer and resource audience must be HTTPS origins');
    auth = new Auth(raw);
  }
  const key = process.env.AUDIT_KEY ?? (demo ? randomBytes(32).toString('hex') : '');
  if (Buffer.byteLength(key) < 32) throw new Error('Stable random AUDIT_KEY is required');
  const db = process.env.DB_PATH ?? (demo ? ':memory:' : '.data/state.sqlite');
  if (demo && db !== ':memory:' && !process.env.AUDIT_KEY)
    throw new Error('Persistent demo data requires a stable audit key');
  return {
    demo,
    baseUrl,
    auth,
    tokens,
    key,
    db,
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? port),
  };
}
