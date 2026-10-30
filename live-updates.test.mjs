import assert from 'node:assert/strict';
import test from 'node:test';
import { liveUpdates } from './public/live-updates.js';

function fakePage() {
  const timers = [];
  const listeners = {};
  const page = {
    dialogOpen: false,
    focused: null,
    win: { scrollY: 0, scrollTo(x, y) { this.scrollY = y; } },
    doc: {
      visibilityState: 'visible',
      querySelector: (selector) => (selector === 'dialog[open]' && page.dialogOpen ? {} : null),
      get activeElement() { return page.focused; },
      addEventListener: (name, callback) => { listeners[name] = callback; },
    },
    setTimer: (callback, ms) => timers.push({ callback, ms }),
    async runTimers() { const due = timers.splice(0); for (const timer of due) await timer.callback(); return due; },
    listeners,
  };
  return page;
}

class FakeEventSource {
  static CLOSED = 2;
  static last = null;
  constructor(url) { this.url = url; this.readyState = 1; FakeEventSource.last = this; }
  close() { this.readyState = FakeEventSource.CLOSED; }
}

test('live updates refresh only the kinds a page shows, and wait while the viewer is editing', async () => {
  const page = fakePage();
  const refreshed = [];
  const live = liveUpdates(['kanban', 'projects'], async (kinds) => { refreshed.push(kinds); page.win.scrollY = 0; }, { ...page, EventSourceImpl: FakeEventSource });
  assert.equal(FakeEventSource.last.url, '/api/events');

  page.win.scrollY = 480;
  FakeEventSource.last.onmessage({ data: JSON.stringify({ version: 2, kinds: ['teams'] }) });
  FakeEventSource.last.onmessage({ data: JSON.stringify({ version: 3, kinds: ['kanban'] }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(refreshed, [['kanban']]);
  assert.equal(page.win.scrollY, 480);

  page.dialogOpen = true;
  await live.notify(['projects']);
  await live.notify(['kanban']);
  assert.equal(refreshed.length, 1);
  assert.equal((await page.runTimers()).length, 1);
  assert.equal(refreshed.length, 1);
  page.dialogOpen = false;
  page.focused = { matches: () => true, closest: () => ({}) };
  await page.runTimers();
  assert.equal(refreshed.length, 1);
  page.focused = null;
  await page.runTimers();
  assert.deepEqual(refreshed[1].sort(), ['kanban', 'projects']);

  let busy = true;
  const held = [];
  const second = liveUpdates(['teams'], async (kinds) => held.push(kinds), { ...page, EventSourceImpl: FakeEventSource, busy: () => busy });
  await second.notify(['teams']);
  assert.deepEqual(held, []);
  busy = false;
  await page.runTimers();
  assert.deepEqual(held, [['teams']]);
});

test('live updates fall back to polling the version while the tab is visible', async () => {
  const page = fakePage();
  let version = 10;
  let fetches = 0;
  const fetchImpl = async (url) => { fetches += 1; assert.equal(url, '/api/version'); return { ok: true, json: async () => ({ version }) }; };
  const refreshed = [];
  liveUpdates(['projects', 'teams'], async (kinds) => refreshed.push(kinds), { ...page, EventSourceImpl: FakeEventSource, fetchImpl });
  FakeEventSource.last.readyState = FakeEventSource.CLOSED;
  FakeEventSource.last.onerror();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1);
  assert.deepEqual(refreshed, []);

  version = 11;
  const [tick] = await page.runTimers();
  assert.equal(tick.ms, 10_000);
  assert.deepEqual(refreshed, [['projects', 'teams']]);

  page.doc.visibilityState = 'hidden';
  version = 12;
  await page.runTimers();
  assert.equal(fetches, 2);
  page.doc.visibilityState = 'visible';
  await page.listeners.visibilitychange();
  assert.equal(fetches, 3);
  assert.equal(refreshed.length, 2);

  const noStreams = fakePage();
  let polled = false;
  liveUpdates(['teams'], async () => {}, { ...noStreams, EventSourceImpl: undefined, fetchImpl: async () => { polled = true; return { ok: false }; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polled, true);
});
