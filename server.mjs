import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { databaseConfig, openDatabase } from './database.mjs';
import { json } from './http-utils.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
const port = Number(process.env.PORT || 3000);
const dbConfig = databaseConfig();
if (dbConfig.client === 'sqlite') mkdirSync(dataDir, { recursive: true });

const db = openDatabase(join(dataDir, 'northstar.db'), dbConfig);
const api = createApi(db);

// Northstar's pages load only their own scripts, styles and images; inline scripts and style attributes are refused.
const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
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
    const type = mime[extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...(type.startsWith('text/html') ? { 'content-security-policy': contentSecurityPolicy } : {}) });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { json(res, 404, { error: 'Not found.' }); }
});

server.listen(port, '0.0.0.0', () => console.log(`Northstar is ready at http://localhost:${port}`));
function shutdown() { api.close(); server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
