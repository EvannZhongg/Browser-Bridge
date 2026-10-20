// Lifecycle events can precede the Page.navigate reply. Keep them until its loader is known.
export function createNavigation(cdp) {
  const pending = new Map();
  function event(tabId, method, params) { pending.get(tabId)?.event(method, params); }
  function cancel(tabId) { pending.get(tabId)?.cancel(); }
  async function navigate(tabId, url, { wait_until = 'domcontentloaded', timeout_ms = 15000 } = {}) {
    if (!['commit', 'domcontentloaded', 'load'].includes(wait_until)) throw new Error('wait_until must be commit, domcontentloaded or load');
    if (!Number.isInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > 40000) throw new Error('timeout_ms must be 100..40000');
    let result, resolveDone, rejectDone, timer;
    const events = [];
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    function check() {
      if (!result) return;
      // A successful reply without loaderId denotes a same-document navigation.
      if (wait_until === 'commit' || !result.loaderId || events.some(event =>
        event.frameId === result.frameId && event.loaderId === result.loaderId &&
        event.name === (wait_until === 'load' ? 'load' : 'DOMContentLoaded'))) resolveDone(result);
    }
    pending.set(tabId, {
      event(method, params) { if (method === 'Page.lifecycleEvent') { events.push(params); check(); } },
      cancel() { rejectDone(new Error('Tab detached during navigation; outcome is unknown.')); },
    });
    timer = setTimeout(() => rejectDone(new Error(`Navigation did not reach ${wait_until} within ${timeout_ms} ms. It may still be loading; observe the tab before another action.`)), timeout_ms);
    try {
      // Attach rejection handlers immediately, including when the deadline wins first.
      const command = cdp(tabId, 'Page.navigate', { url }).then(reply => {
        if (reply.errorText) throw new Error(`Navigation failed: ${reply.errorText}`);
        if (reply.isDownload) throw new Error('Navigation started a download instead of a document.');
        result = reply; check(); return done;
      });
      await Promise.race([command, done]);
      return { navigated_to: url, wait_until, same_document: !result.loaderId };
    } finally { clearTimeout(timer); pending.delete(tabId); }
  }
  return { event, cancel, navigate };
}
