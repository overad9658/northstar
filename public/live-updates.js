// Keeps a page current with changes made elsewhere (another tab, a teammate, the API).
// The server sends which kinds changed; the page re-fetches only those. A refresh waits
// while the viewer is mid-edit (a dialog is open, a form field has focus, or the page
// reports it is busy), so nothing they are doing is lost.
const POLL_MS = 10_000;
const RETRY_MS = 1_000;

export function editingInProgress(doc) {
  if (doc.querySelector('dialog[open]')) return true;
  const active = doc.activeElement;
  return Boolean(active?.matches?.('input, textarea, select') && active.closest?.('form'));
}

export function liveUpdates(kinds, refresh, {
  busy = () => false,
  win = globalThis.window,
  doc = globalThis.document,
  EventSourceImpl = globalThis.EventSource,
  fetchImpl = (...args) => globalThis.fetch(...args),
  setTimer = (callback, ms) => setTimeout(callback, ms),
} = {}) {
  const pending = new Set();
  let running = false;
  let waiting = false;
  let version = null;
  let polling = false;

  async function flush() {
    waiting = false;
    if (!pending.size || running) return;
    if (busy() || editingInProgress(doc)) {
      waiting = true;
      setTimer(flush, RETRY_MS);
      return;
    }
    const changed = [...pending];
    pending.clear();
    running = true;
    const scroll = win.scrollY;
    try { await refresh(changed); } catch { /* the next change or poll tries again */ }
    finally { running = false; }
    if (win.scrollY !== scroll) win.scrollTo(0, scroll);
    if (pending.size) await flush();
  }

  function notify(changed) {
    for (const kind of changed) if (kinds.includes(kind)) pending.add(kind);
    if (pending.size && !waiting && !running) return flush();
  }

  async function poll() {
    if (doc.visibilityState === 'hidden') return;
    try {
      const response = await fetchImpl('/api/version', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      const next = (await response.json()).version;
      // Polling cannot tell which kinds changed, so refresh all of this page's.
      if (version !== null && next !== version) await notify(kinds);
      version = next;
    } catch { /* offline: try on the next tick */ }
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    const tick = async () => { await poll(); setTimer(tick, POLL_MS); };
    doc.addEventListener('visibilitychange', () => (doc.visibilityState === 'visible' ? poll() : undefined));
    void tick();
  }

  if (typeof EventSourceImpl !== 'function') startPolling();
  else {
    const source = new EventSourceImpl('/api/events');
    source.onmessage = (event) => {
      try { void notify(JSON.parse(event.data).kinds || []); } catch { /* malformed event: ignore */ }
    };
    // EventSource retries dropped connections on its own; CLOSED means the server refused
    // the stream (auth, a proxy without streaming), so fall back to polling.
    source.onerror = () => { if (source.readyState === EventSourceImpl.CLOSED) { source.close(); startPolling(); } };
  }
  return { notify, flush };
}
