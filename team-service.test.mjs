import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from './database.mjs';
import { createProjectService } from './project-service.mjs';
import { createTeamService } from './team-service.mjs';

test('teams manage names and enforce capacity against their projects', () => {
  const db = openDatabase(':memory:');
  try {
    const teams = createTeamService(db);
    const projects = createProjectService(db);
    const platform = teams.list()[0];
    teams.update(platform.id, { capacity: 5 });
    projects.create({ name: 'Migration', team: 'Platform', capacity: 3, impact: 4, urgency: 4, confidence: 5, effort: 5 });
    assert.throws(() => teams.update(platform.id, { capacity: 2 }), /3 people currently assigned/);
    const renamed = teams.update(platform.id, { name: 'Core Platform' });
    assert.equal(renamed.name, 'Core Platform');
    assert.equal(projects.list()[0].team, 'Core Platform');
    const design = teams.create({ name: 'Design', capacity: 4 });
    assert.equal(design.available, 4);
    teams.delete(design.id);
    assert.throws(() => teams.delete(platform.id), /has projects/);
  } finally {
    db.close();
  }
});
