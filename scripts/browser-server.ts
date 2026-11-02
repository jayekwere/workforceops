import { mkdirSync, writeFileSync } from 'node:fs';
import { environment } from './environment.js';
const e = await environment();
mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/tokens.json', JSON.stringify(e.tokens), { mode: 0o600 });
await e.app.listen({ port: 4410, host: '127.0.0.1' });
