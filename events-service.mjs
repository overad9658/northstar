import { createHash } from 'node:crypto';

export const EVENT_KINDS = Object.freeze(['projects', 'kanban', 'teams']);
const HEARTBEAT_MS = 25_000;

// Change notifications for open pages. Events say only which kinds changed, never what, and each
// audience (admins, read-only viewers) is compared against what it can see: a change to a hidden
// project produces no event and no version bump for read-only viewers.
// The emitter is in-process, so it covers one server; several servers on one PostgreSQL database
// would need LISTEN/NOTIFY to share it.
export function createEventsService({ projects, kanban, teams }) {
  const snapshots = {
    projects: (includeHidden) => projects.list({ includeHidden }),
    kanban: (includeHidden) => kanban.list({ includeHidden }),
    teams: (includeHidden) => teams.list({ includeHidden }),
  };
  const fingerprint = (kind, includeHidden) => createHash('sha256').update(JSON.stringify(snapshots[kind](includeHidden))).digest('hex');
  // Versions start at the boot time so they keep increasing across restarts.
  const start = Date.now();
  const audiences = new Map([true, false].map((includeHidden) => [includeHidden, {
    version: start,
    fingerprints: Object.fromEntries(EVENT_KINDS.map((kind) => [kind, fingerprint(kind, includeHidden)])),
    clients: new Set(),
  }]));

  function send(res, version, kinds) {
    res.write(`id: ${version}\ndata: ${JSON.stringify({ version, kinds })}\n\n`);
  }

  return {
    version: (includeHidden) => audiences.get(Boolean(includeHidden)).version,

    // Call after a write has committed; compares fingerprints, so a request that changed nothing visible is silent.
    publish(kinds = EVENT_KINDS) {
      for (const [includeHidden, audience] of audiences) {
        const changed = kinds.filter((kind) => {
          const next = fingerprint(kind, includeHidden);
          if (next === audience.fingerprints[kind]) return false;
          audience.fingerprints[kind] = next;
          return true;
        });
        if (!changed.length) continue;
        audience.version += 1;
        for (const res of audience.clients) send(res, audience.version, changed);
      }
    },

    subscribe(req, res, { includeHidden, lastEventId }) {
      const audience = audiences.get(Boolean(includeHidden));
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 5000\n\n');
      // A reconnect that missed events cannot know which kinds changed: tell it to refresh everything.
      if (lastEventId && Number(lastEventId) !== audience.version) send(res, audience.version, [...EVENT_KINDS]);
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
      heartbeat.unref();
      audience.clients.add(res);
      const close = () => { clearInterval(heartbeat); audience.clients.delete(res); };
      req.on('close', close);
      res.on('close', close);
    },

    close() {
      for (const audience of audiences.values()) {
        for (const res of audience.clients) res.end();
        audience.clients.clear();
      }
    },
  };
}
