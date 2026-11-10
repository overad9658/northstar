import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DATA_PATTERNS, findDataFiles, trackedFiles } from '../support/check-data.mjs';

test('the data check catches a planted database, backups, exports and SQLite files by their bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'northstar-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  await mkdir(join(root, 'backup-2026'), { recursive: true });
  await mkdir(join(root, 'public'), { recursive: true });
  const files = {
    'app.mjs': 'export const ok = true;\n',
    'public/page.json': '{}',
    'planted.db': 'not even a real database',
    'data.sqlite3': '',
    'backup-2026/notes.txt': 'a backup folder',
    'board-export-2026.json': '{}',
    'archive.tar.gz': '',
    'innocent.png': Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(84)]),
  };
  for (const [path, body] of Object.entries(files)) await writeFile(join(root, path), body);
  // -f: the repository's own .gitignore would refuse some of these; a planted file can still be forced in.
  git('add', '-f', '.');

  const found = findDataFiles(trackedFiles(root), root).map((item) => item.path).sort();
  assert.deepEqual(found, ['archive.tar.gz', 'backup-2026/notes.txt', 'board-export-2026.json', 'data.sqlite3', 'innocent.png', 'planted.db']);
  assert.match(findDataFiles(['innocent.png'], root)[0].reason, /SQLite database/);
});

test('this repository tracks no data files, and .gitignore keeps them out', async () => {
  const root = new URL('../', import.meta.url).pathname;
  assert.deepEqual(findDataFiles(trackedFiles(root), root), []);
  const ignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
  for (const pattern of ['*.db', '*.db-wal', '*.db-shm', '*.sqlite', '*.sqlite3', '*.tar.gz', 'backup-*/', '*-export*.json', 'northstar-data*']) {
    assert.ok(ignore.split('\n').includes(pattern), pattern);
  }
  assert.ok(DATA_PATTERNS.length >= 8);
  const run = spawnSync(process.execPath, ['support/check-data.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
