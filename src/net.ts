import { Fault } from './security.js';
export function fixedUrl(raw: string, allowLocal = false) {
  const u = new URL(raw);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !(
      u.protocol === 'https:' ||
      (allowLocal && u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname))
    )
  )
    throw new Error('Fixed HTTPS endpoint required');
  return u;
}
export async function boundedJson(
  url: URL,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    fetcher?: typeof fetch;
    timeout?: number;
  } = {},
) {
  const response = await (options.fetcher ?? fetch)(url, {
    method: options.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...options.headers,
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeout ?? 3000),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!response.ok)
    throw new Fault(
      response.status === 404 ? 404 : response.status === 412 ? 409 : 502,
      response.status === 412 ? 'remote_version_changed' : 'upstream_unavailable',
    );
  if (response.status === 204) return { data: null, etag: response.headers.get('etag') };
  if (!response.headers.get('content-type')?.toLowerCase().includes('json'))
    throw new Fault(502, 'upstream_contract_invalid');
  const reader = response.body?.getReader();
  if (!reader) throw new Fault(502, 'upstream_contract_invalid');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 262144) throw new Fault(502, 'upstream_response_too_large');
      chunks.push(value);
    }
  } catch {
    await reader.cancel();
    throw new Fault(502, 'upstream_contract_invalid');
  }
  try {
    return {
      data: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      etag: response.headers.get('etag'),
    };
  } catch {
    throw new Fault(502, 'upstream_contract_invalid');
  }
}
