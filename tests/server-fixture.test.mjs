import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer } from '../support/server-fixture.mjs';

// A server that never says it is ready used to stay alive after the start timeout, which kept its
// test file from exiting and hung the whole run. It must now be killed and the start must fail.
test('a server that does not start in time is killed, so the test file can exit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'northstar-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, 'silent-server.mjs');
  await writeFile(script, 'setInterval(() => {}, 1000);\n');

  const error = await startServer(dir, await freePort(), {}, { timeoutMs: 300, script }).then(() => null, (reason) => reason);
  assert.match(error?.message ?? '', /did not start within 300 ms/);
  const [code, signal] = error.child.exitCode === null && error.child.signalCode === null ? await once(error.child, 'exit') : [error.child.exitCode, error.child.signalCode];
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
});
