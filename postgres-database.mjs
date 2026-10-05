import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

const identityTables = ['projects', 'teams', 'users', 'project_moves', 'planning_sessions', 'planning_votes'];
const timestampSql = "to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')";

// Translate the application's fixed SQL statements; values always remain bound parameters.
export function postgresSql(sql) {
  let translated = sql
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
    .replace(/\b(username|name) TEXT NOT NULL COLLATE NOCASE/g, '$1 CITEXT NOT NULL')
    .replace(/\bteam TEXT/g, 'team CITEXT')
    .replace(/\bexpires_at INTEGER/g, 'expires_at BIGINT')
    .replace(/\s+COLLATE NOCASE/g, '')
    .replace(/BEGIN IMMEDIATE/g, 'BEGIN')
    .replace(/datetime\('now',\s*\?\)/g, "to_char(clock_timestamp() AT TIME ZONE 'UTC' + ?::interval, 'YYYY-MM-DD HH24:MI:SS')")
    .replace(/\bCURRENT_TIMESTAMP\b/g, `(${timestampSql})`)
    .replace(/\bAS ([a-zA-Z_][a-zA-Z_0-9]*)/g, (match, alias) => /[A-Z]/.test(alias) ? `AS "${alias}"` : match);
  translated = translated.split(';').map((statement) => {
    if (!/INSERT OR IGNORE INTO/.test(statement)) return statement;
    return statement.replace('INSERT OR IGNORE INTO', 'INSERT INTO') + ' ON CONFLICT DO NOTHING';
  }).join(';');
  let parameter = 0;
  return translated.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, (token) => token === '?' ? `$${++parameter}` : token);
}

export function openPostgresDatabase(connectionString) {
  if (!/^postgres(?:ql)?:\/\//.test(connectionString || '')) throw new Error('A PostgreSQL connection URL is required.');
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  // A dedicated worker lets the existing synchronous services keep their transaction boundaries.
  const worker = new Worker(new URL('./postgres-worker.mjs', import.meta.url), {
    workerData: { connectionString, port: port2, signal }, transferList: [port2],
  });
  let closed = false;
  worker.on('error', () => { closed = true; });

  function request(message) {
    if (closed) throw new Error('PostgreSQL connection is closed.');
    Atomics.store(signal, 0, 0);
    port1.postMessage(message);
    if (Atomics.wait(signal, 0, 0, 30_000) === 'timed-out') {
      closed = true;
      port1.close();
      void worker.terminate();
      throw new Error('PostgreSQL operation timed out; connection closed.');
    }
    const response = receiveMessageOnPort(port1)?.message;
    if (!response) throw new Error('PostgreSQL worker did not return a response.');
    if (response.error) {
      const error = new Error(response.error.message);
      error.code = response.error.code;
      throw error;
    }
    return response.result;
  }

  const db = {
    dialect: 'postgres',
    exec(sql) { request({ sql: postgresSql(sql), params: [] }); },
    prepare(sql) {
      function query(params, run = false) {
        let text = sql;
        // SQLite's explicit NULL identity values request a generated ID during legacy restores.
        if (/INSERT INTO teams \(id,/.test(text) && params[0] === null) {
          text = text.replace(/VALUES \(\?/, 'VALUES (DEFAULT');
          params = params.slice(1);
        }
        text = postgresSql(text);
        const table = /^\s*INSERT INTO (\w+)/i.exec(text)?.[1];
        if (run && identityTables.includes(table) && !/\bRETURNING\b/i.test(text)) text += ' RETURNING id';
        return request({ sql: text, params });
      }
      return {
        all: (...params) => query(params).rows,
        get: (...params) => query(params).rows[0],
        run: (...params) => {
          const result = query(params, true);
          return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
        },
      };
    },
    resetSequences() {
      for (const table of identityTables.filter((name) => name !== 'users')) {
        db.exec(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${table}`);
      }
    },
    close() {
      if (closed) return;
      try { request({ close: true }); }
      finally { closed = true; port1.close(); void worker.terminate(); }
    },
  };
  try { db.exec('SELECT 1'); }
  catch (error) { closed = true; port1.close(); void worker.terminate(); throw error; }
  return db;
}
