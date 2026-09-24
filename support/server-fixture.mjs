import { spawn } from 'node:child_process';

export async function startServer(dataDir, port, env = {}) {
  const child = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, AUTH_DISABLED: 'true', ...env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start.')), 5000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Northstar is ready')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited with ${code}.`));
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
