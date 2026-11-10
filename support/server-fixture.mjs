import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// Fixed ports in 30000–39999 overlap Linux's ephemeral range, where parallel test clients can hold them.
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// A busy machine running many test files at once can take several seconds to start a server, so the
// wait is generous. A server that does not start in time is killed: a live child process would keep
// the test file from ever exiting, and the whole run would hang instead of failing.
export const START_TIMEOUT_MS = Number(process.env.TEST_SERVER_START_MS) || 20_000;

export async function startServer(dataDir, port, env = {}, { timeoutMs = START_TIMEOUT_MS, script = 'server.mjs' } = {}) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, AUTH_DISABLED: 'true', ...env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error(`Server did not start within ${timeoutMs} ms.${stderr ? `\n${stderr.trim()}` : ''}`), { child }));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('Northstar is ready')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited with ${code}.${stderr ? `\n${stderr.trim()}` : ''}`));
    });
  });
  return child;
}

export function stopServer(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}
