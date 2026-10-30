// A small HTTP client for the Northstar API. It never logs or returns request headers, and
// scrubs the token from anything it reports, so a failure cannot leak the credential.

export class NorthstarApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function parseBaseUrl(value = 'http://127.0.0.1:3000') {
  let url;
  try { url = new URL(value); } catch { throw new Error('NORTHSTAR_URL must be a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('NORTHSTAR_URL must use http or https.');
  if (url.username || url.password) throw new Error('NORTHSTAR_URL must not contain credentials; use NORTHSTAR_TOKEN.');
  return url.origin;
}

export function createClient({ baseUrl, token, fetchImpl = globalThis.fetch }) {
  const redact = (text) => (token ? String(text).split(token).join('[redacted]') : String(text));

  async function request(method, path, { query, body } = {}) {
    const url = new URL(path, baseUrl);
    for (const [name, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        redirect: 'error',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new NorthstarApiError(0, redact(`Northstar is unreachable at ${baseUrl}: ${error?.cause?.code || error?.name || 'network error'}`));
    }
    const text = await response.text();
    const isJson = (response.headers.get('content-type') || '').includes('application/json');
    let data = text;
    if (isJson && text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!response.ok) {
      const message = typeof data === 'object' && data?.error ? data.error : `Request failed with HTTP ${response.status}.`;
      throw new NorthstarApiError(response.status, redact(message));
    }
    return response.status === 204 ? null : data;
  }

  return { request, redact };
}
