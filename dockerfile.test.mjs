import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The image copies the filtered build context. Walk every relative import reachable from
// server.mjs, and every file it loads by URL, to check the ignore rules include them.
const root = dirname(fileURLToPath(import.meta.url));

function reachableModules(entry) {
  const seen = new Set();
  const pending = [entry];
  const patterns = [/from\s+'(\.[^']+)'/g, /import\(\s*'(\.[^']+)'\s*\)/g, /new URL\(\s*'(\.[^']+)',\s*import\.meta\.url\s*\)/g];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.m?js$/.test(file) || !existsSync(join(root, file))) continue;
    const source = readFileSync(join(root, file), 'utf8');
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        pending.push(relative(root, normalize(join(root, dirname(file), match[1]))));
      }
    }
  }
  return [...seen];
}

test('the filtered Docker context includes every file the server loads', () => {
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY \. \.\/$/m);
  const ignore = readFileSync(join(root, '.dockerignore'), 'utf8').trim().split(/\r?\n/);
  assert.equal(ignore[0], '*');
  for (const rule of ['!package.json', '!pnpm-lock.yaml', '!*.mjs', '!public/', '!public/**', '!docs/', '!docs/*.md', '!mcp/', '!mcp/README.md']) {
    assert.ok(ignore.includes(rule), `${rule} is missing from .dockerignore`);
  }
  assert.ok(ignore.indexOf('*.test.mjs') > ignore.indexOf('!*.mjs'), 'tests must be excluded after root modules are included');
  const modules = reachableModules('server.mjs');
  assert.ok(modules.includes('postgres-worker.mjs'), 'the walk follows worker URLs');
  for (const file of modules) assert.ok(existsSync(join(root, file)), `${file} is imported but missing`);
  const included = (file) => (/^[^/]+\.mjs$/.test(file) && !file.endsWith('.test.mjs'))
    || file.startsWith('public/')
    || /^docs\/[^/]+\.md$/.test(file)
    || file === 'mcp/README.md';
  assert.deepEqual(modules.filter((file) => !included(file)), []);
});
