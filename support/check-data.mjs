// Fails when a tracked file looks like database data: a database, backup or export file by its name,
// or a SQLite database by its first bytes. Run by `pnpm check` and CI; the repository holds code only.
import { execFileSync } from 'node:child_process';
import { openSync, readSync, closeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_PATTERNS = Object.freeze([
  /\.db$/i, /\.db-wal$/i, /\.db-shm$/i, /\.sqlite3?$/i, /\.tar\.gz$/i,
  /(^|\/)backup-[^/]*\//i, /-export[^/]*\.json$/i, /(^|\/)northstar-data[^/]*/i,
]);
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

function startsWithSqliteMagic(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(SQLITE_MAGIC.length);
    return readSync(fd, head, 0, head.length, 0) === head.length && head.equals(SQLITE_MAGIC);
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}

// paths are relative to root; returns [{ path, reason }].
export function findDataFiles(paths, root) {
  const found = [];
  for (const path of paths) {
    const pattern = DATA_PATTERNS.find((item) => item.test(path) || item.test(basename(path)));
    if (pattern) found.push({ path, reason: `name matches ${pattern}` });
    else if (startsWithSqliteMagic(join(root, path))) found.push({ path, reason: 'it is a SQLite database' });
  }
  return found;
}

export function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const found = findDataFiles(trackedFiles(root), root);
  if (found.length) {
    for (const item of found) console.error(`Data file in the repository: ${item.path} (${item.reason}).`);
    console.error('Remove these files from git. Database data must never be committed.');
    process.exit(1);
  }
  console.log('No database, backup or export files are tracked.');
}
