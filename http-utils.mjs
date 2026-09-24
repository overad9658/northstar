export function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export async function readJson(req, maxLength = 100_000) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxLength) throw new Error('Request is too large.');
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new Error('Invalid JSON.');
  }
}
