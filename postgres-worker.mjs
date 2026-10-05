import { workerData } from 'node:worker_threads';

const { port, signal, connectionString } = workerData;
let client;
let startupError;
try {
  const { default: pg } = await import('pg');
  // Counts, sums, and score calculations must retain the numeric API used by SQLite.
  for (const oid of [20, 1700]) pg.types.setTypeParser(oid, Number);
  client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  client.on('error', (error) => { startupError = error; });
  await client.connect();
} catch (error) { startupError = error; }

port.on('message', async ({ sql, params, close }) => {
  let response;
  try {
    if (close) {
      if (client) await client.end();
      response = { result: null };
    } else {
      if (startupError) throw startupError;
      const result = await client.query(sql, params);
      const last = Array.isArray(result) ? result.at(-1) : result;
      response = { result: { rows: last.rows, rowCount: last.rowCount } };
    }
  } catch (error) {
    response = { error: { code: error.code, message: error.code === '23505' ? `UNIQUE constraint: ${error.message}` : error.message } };
  }
  port.postMessage(response);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
