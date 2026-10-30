import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseMarkdown, renderMarkdown, safeHref } from './public/markdown.js';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

// A minimal document: enough DOM to render into, and innerHTML throws so any use of it fails the test.
function fakeDocument() {
  const element = (tag) => {
    const node = { tag, attributes: {}, children: [], text: '' };
    Object.defineProperty(node, 'textContent', { get: () => node.text || node.children.map((child) => child.textContent ?? child.text).join(''), set: (value) => { node.text = String(value); node.children = []; } });
    Object.defineProperty(node, 'innerHTML', { set: () => { throw new Error('innerHTML must not be used'); } });
    node.setAttribute = (name, value) => { node.attributes[name] = String(value); };
    node.appendChild = (child) => { node.children.push(child); return child; };
    return node;
  };
  return { createElement: element, createDocumentFragment: () => element('#fragment'), createTextNode: (text) => ({ tag: '#text', text: String(text) }) };
}

const all = (node, tag) => [...(node.tag === tag ? [node] : []), ...(node.children || []).flatMap((child) => all(child, tag))];

test('docs renderer shows HTML as text and only links http(s) and in-page anchors', () => {
  const source = [
    '# Title <img src=x onerror=alert(1)>',
    '',
    'Hello <img src=x onerror="alert(1)"> and <script>alert(2)</script>.',
    '',
    '[bad](javascript:alert(1)) [bad2](JaVaScRiPt:alert(1)) [data](data:text/html,<b>x</b>) [proto](//evil.example) [rel](sso.md)',
    '',
    '[site](https://example.com/a?b=1) [here](#title)',
    '',
    '```html',
    '<script>alert(3)</script>',
    '```',
  ].join('\n');
  const { fragment, headings } = renderMarkdown(source, fakeDocument());
  assert.deepEqual(all(fragment, 'img'), []);
  assert.deepEqual(all(fragment, 'script'), []);
  const text = fragment.textContent;
  assert.match(text, /Hello <img src=x onerror="alert\(1\)"> and <script>alert\(2\)<\/script>\./);
  assert.match(text, /bad bad2 data proto rel/);

  const links = all(fragment, 'a').filter((link) => link.attributes.class !== 'heading-anchor');
  assert.deepEqual(links.map((link) => link.attributes.href), ['https://example.com/a?b=1', '#title']);
  assert.equal(links[0].attributes.rel, 'noopener noreferrer');
  assert.equal(links[0].attributes.target, '_blank');
  assert.equal(links[1].attributes.target, undefined);
  assert.equal(all(fragment, 'code')[0].textContent, '<script>alert(3)</script>');
  assert.equal(all(fragment, 'code')[0].attributes.class, 'language-html');
  assert.deepEqual(headings, [{ level: 1, id: 'title-img-srcx-onerroralert1', text: 'Title <img src=x onerror=alert(1)>' }]);

  for (const href of ['javascript:alert(1)', ' javascript:alert(1)', 'vbscript:x', 'data:text/html,x', 'file:///etc/passwd', '//evil.example', 'docs/api.md', '#a"b']) {
    assert.equal(safeHref(href), null, href);
  }
});

test('docs renderer handles headings, lists, tables and inline code', () => {
  const blocks = parseMarkdown([
    '## Setup', '', '## Setup', '',
    '- **one** item', '  continued', '- `two`', '',
    '1. first', '2. second', '',
    '| Method | Body |', '| --- | --- |', '| `POST` | `{ "scope": "read" \\| "write" }` |', '',
    'A paragraph', 'over two lines.',
  ].join('\n'));
  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'heading', 'list', 'list', 'table', 'paragraph']);
  assert.deepEqual(blocks.slice(0, 2).map((block) => block.id), ['setup', 'setup-2']);
  assert.equal(blocks[2].ordered, false);
  assert.deepEqual(blocks[2].items[0], [{ type: 'strong', children: [{ type: 'text', text: 'one' }] }, { type: 'text', text: ' item continued' }]);
  assert.equal(blocks[3].ordered, true);
  assert.deepEqual(blocks[4].rows[0][1], [{ type: 'code', text: '{ "scope": "read" | "write" }' }]);
  assert.deepEqual(blocks[5].children, [{ type: 'text', text: 'A paragraph over two lines.' }]);
});

test('the shipped docs render with a table of contents', async () => {
  for (const path of ['docs/api.md', 'mcp/README.md']) {
    const { headings } = renderMarkdown(await readFile(path, 'utf8'), fakeDocument());
    assert.ok(headings.filter((heading) => heading.level === 2).length >= 2, path);
  }
  const { headings } = renderMarkdown(await readFile('docs/api.md', 'utf8'), fakeDocument());
  assert.ok(headings.some((heading) => heading.id === 'authentication'));
});

test('GET /api/docs/:name serves only the allowlisted docs to signed-in users', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-docs-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: 'legacy-token' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, headers = {}, method = 'GET') => fetch(`${base}${path}`, { method, headers });

  assert.equal((await send('/api/docs/api')).status, 401);
  assert.equal((await send('/api/docs/api', { authorization: 'Bearer legacy-token' })).status, 401);

  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }),
  });
  const cookie = { cookie: setup.headers.get('set-cookie').split(';', 1)[0] };
  const viewer = await fetch(`${base}/api/users`, {
    method: 'POST', headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'viewer', password: 'another long passphrase', role: 'read_only' }),
  });
  assert.equal(viewer.status, 201);
  const viewerLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'viewer', password: 'another long passphrase' }),
  });
  const viewerCookie = { cookie: viewerLogin.headers.get('set-cookie').split(';', 1)[0] };

  for (const [name, path] of [['api', 'docs/api.md'], ['mcp', 'mcp/README.md']]) {
    for (const session of [cookie, viewerCookie]) {
      const response = await send(`/api/docs/${name}`, session);
      assert.equal(response.status, 200, name);
      assert.match(response.headers.get('content-type'), /^text\/markdown/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(await response.text(), await readFile(path, 'utf8'));
    }
  }

  for (const path of [
    '/api/docs/sso', '/api/docs/', '/api/docs/api/', '/api/docs/API', '/api/docs/__proto__', '/api/docs/constructor',
    '/api/docs/..%2f..%2fpackage.json', '/api/docs/%2e%2e%2fserver.mjs', '/api/docs/api%2f..%2f..%2fserver.mjs',
    '/api/docs/..%5c..%5cpackage.json', '/api/docs/%2fetc%2fpasswd', '/api/docs/mcp%00',
  ]) assert.equal((await send(path, cookie)).status, 404, path);
  assert.equal((await send('/api/docs/api', cookie, 'POST')).status, 405);

  const page = await send('/docs.html');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline/);
});
