import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { openDatabase } from './database.mjs';
import { json } from './http-utils.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
const port = Number(process.env.PORT || 3000);
mkdirSync(dataDir, { recursive: true });

const db = openDatabase(join(dataDir, 'northstar.db'));
const api = createApi(db);

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (await api(req, res, url)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = resolve(publicDir, `.${pathname}`);
  const relativePath = relative(publicDir, filePath);
  if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) {
    return json(res, 403, { error: 'Forbidden.' });
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'content-type': mime[extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { json(res, 404, { error: 'Not found.' }); }
});

server.listen(port, '0.0.0.0', () => console.log(`Northstar is ready at http://localhost:${port}`));
function shutdown() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
