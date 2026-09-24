import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase, transaction } from './database.mjs';

test('openDatabase creates the current schema and records its version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'northstar-schema-'));
  const db = openDatabase(join(directory, 'northstar.db'));
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name);
    assert.ok(tables.includes('projects'));
    assert.ok(tables.includes('planning_sessions'));
    assert.ok(tables.includes('planning_votes'));
    assert.ok(tables.includes('teams'));
    assert.ok(tables.includes('users'));
    assert.ok(tables.includes('auth_sessions'));
    assert.ok(db.prepare('PRAGMA table_info(projects)').all().some((column) => column.name === 'hidden_from_read_only'));
    assert.ok(db.prepare('PRAGMA table_info(planning_sessions)').all().some((column) => column.name === 'guest_access'));
    assert.ok(db.prepare('PRAGMA table_info(projects)').all().some((column) => column.name === 'blocked_note'));
    assert.ok(db.prepare('PRAGMA table_info(projects)').all().some((column) => column.name === 'archive_note'));
    assert.ok(db.prepare('PRAGMA table_info(projects)').all().some((column) => column.name === 'restore_note'));
    const defaultTeam = db.prepare('SELECT name, capacity FROM teams').get();
    assert.equal(defaultTeam.name, 'Platform');
    assert.equal(defaultTeam.capacity, 0);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('transaction rolls back changes when its callback fails', () => {
  const db = openDatabase(':memory:');
  try {
    assert.throws(() => transaction(db, () => {
      db.prepare('UPDATE portfolio_settings SET total_capacity = 10 WHERE id = 1').run();
      throw new Error('stop');
    }), /stop/);
    assert.equal(db.prepare('SELECT total_capacity FROM portfolio_settings WHERE id = 1').get().total_capacity, 0);
  } finally {
    db.close();
  }
});
