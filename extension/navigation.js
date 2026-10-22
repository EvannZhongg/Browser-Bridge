import { NAVIGATION_MAX_TIMEOUT_MS } from './limits.js';

// Lifecycle events can precede the Page.navigate reply. Keep them until its loader is known.
export function createNavigation(cdp) {
  const pending = new Map();
  function event(tabId, method, params) { pending.get(tabId)?.event(method, params); }
  function cancel(tabId, reason) { pending.get(tabId)?.cancel(reason); }
  async function navigate(tabId, url, { wait_until = 'domcontentloaded', timeout_ms = 15000, direction } = {}) {
    if (!['commit', 'domcontentloaded', 'load'].includes(wait_until)) throw new Error('wait_until must be commit, domcontentloaded or load');
    if (!Number.isInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > NAVIGATION_MAX_TIMEOUT_MS) throw new Error('timeout_ms must be 100..40000');
    const end = Date.now() + timeout_ms;
    async function prepare(method) {
      const remaining = end - Date.now(); let timer;
      try {
        if (remaining <= 0) throw new Error('Navigation preparation timed out; no navigation was dispatched');
        return await Promise.race([cdp(tabId, method), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Navigation preparation timed out; no navigation was dispatched')), remaining); })]);
      } finally { clearTimeout(timer); }
    }
    let entry, mainId;
    if (direction != null) {
      if (!['back', 'forward'].includes(direction) || url != null) throw new Error('Provide URL or direction=back/forward, never both');
      const history = await prepare('Page.getNavigationHistory');
      entry = history.entries[history.currentIndex + (direction === 'back' ? -1 : 1)];
      if (!entry) throw new Error(`No ${direction} history entry; no navigation was dispatched`);
      const destination = new URL(entry.url);
      if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) throw new Error('History entry is outside supported HTTP(S) scope; no navigation was dispatched');
      mainId = (await prepare('Page.getFrameTree')).frameTree.frame.id;
    }
    let result, currentDocument, completedDocument, resolveDone, rejectDone, timer;
    const events = [];
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    function check() {
      if (!result) return;
      if (direction) {
        const commit = events.find(e => e.method === 'Page.frameNavigated' && e.frame.id === mainId && !e.frame.parentId || e.method === 'Page.navigatedWithinDocument' && e.frameId === mainId);
        if (!commit) return;
        const same = commit.method === 'Page.navigatedWithinDocument';
        if (same || wait_until === 'commit' || commit.type === 'BackForwardCacheRestore' || events.some(e => e.method === 'Page.lifecycleEvent' && e.frameId === mainId && e.loaderId === commit.frame?.loaderId && e.name === (wait_until === 'load' ? 'load' : 'DOMContentLoaded'))) {
          result = { frameId: mainId, ...(same ? {} : { loaderId: commit.frame.loaderId || 'history' }) }; resolveDone(result);
        }
        return;
      }
      // A client-side redirect can replace the loader before the original reply.
      const current = currentDocument || result;
      if (wait_until === 'commit' || !current.loaderId || events.some(event =>
        event.frameId === current.frameId && event.loaderId === current.loaderId &&
        event.name === (wait_until === 'load' ? 'load' : 'DOMContentLoaded'))) {
        completedDocument ??= current;
        resolveDone(result);
      }
    }
    pending.set(tabId, {
      event(method, params) {
        if (!direction && method === 'Page.frameNavigated' && !params.frame.parentId && params.frame.loaderId) currentDocument = { frameId: params.frame.id, loaderId: params.frame.loaderId };
        if (['Page.lifecycleEvent', 'Page.frameNavigated', 'Page.navigatedWithinDocument'].includes(method)) { events.push({ method, ...params }); check(); }
      },
      cancel(reason) { rejectDone(reason || new Error('Tab detached during navigation; outcome is unknown.')); },
    });
    timer = setTimeout(() => rejectDone(Object.assign(new Error(`Navigation did not reach ${wait_until} within ${timeout_ms} ms. It may still be loading; observe the tab before another action.`), { code: 'NAVIGATION_TIMEOUT' })), Math.max(0, end - Date.now()));
    try {
      // Attach rejection handlers immediately, including when the deadline wins first.
      const command = cdp(tabId, direction ? 'Page.navigateToHistoryEntry' : 'Page.navigate', direction ? { entryId: entry.id } : { url }).then(reply => {
        if (reply.errorText) throw Object.assign(new Error(`Navigation failed: ${reply.errorText}`), { code: 'NAVIGATION_FAILED', navigation_error: reply.errorText });
        if (reply.isDownload) throw new Error('Navigation started a download instead of a document.');
        result = direction ? {} : reply; check(); return done;
      });
      await Promise.race([command, done]);
      const document = completedDocument || result;
      return { navigated_to: entry?.url || url, ...(direction ? { direction } : {}), wait_until, same_document: !result.loaderId,
        document: { frameId: document.frameId, loaderId: document.loaderId } };
    } finally { clearTimeout(timer); pending.delete(tabId); }
  }
  return { event, cancel, navigate };
}
