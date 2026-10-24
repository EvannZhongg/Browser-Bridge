import { deadline } from './actionability.js';
import { boundedRead } from './outcomes.js';
import { capturePage } from './fetch.js';
import { waitFor } from './wait.js';
import { httpUrl } from './page-url.js';

export function createFetchPages(api, cdp, value, navigation, network, sessions, pointer, observations, { queued, attach, currentClaim, forget }) {
  const temporaryTabs = new Map();
  async function closeTemporary(tabId) {
    try { await api.tabs.remove(tabId); }
    catch (error) {
      // A closed tab is already clean; otherwise retain ownership for later cleanup.
      let tab;
      try { tab = await api.tabs.get(tabId); }
      catch (lookup) { if (!/No tab with id|Invalid tab ID/i.test(lookup.message)) throw error; }
      if (tab) throw error;
    }
    temporaryTabs.delete(tabId);
    if (currentClaim(tabId)) forget(tabId);
  }

  async function fetchPage(owner, args, cap, checkConnection) {
    const url = httpUrl(args.url), timeout = args.timeout_ms ?? 15000, waitUntil = args.wait_until ?? 'load';
    const end = Date.now() + timeout, cleanupReserve = Math.min(250, Math.floor(timeout / 10));
    const budget = deadline(timeout, 'fetch', end - cleanupReserve);
    const handle = crypto.randomUUID(), temporary = { owner, handle };
    const creation = api.tabs.create({ url: 'about:blank', active: false }).then(tab => {
      temporaryTabs.set(tab.id, temporary);
      return tab;
    });
    let tab;
    try { tab = await budget.run(() => creation); }
    catch (error) {
      // A late tabs.create response must not start navigation or leak its tab.
      creation.then(created => queued(created.id, () => closeTemporary(created.id))).catch(() => {});
      throw error;
    }
    return await queued(tab.id, async () => {
      let failure;
      try {
        checkConnection();
        await attach(tab.id, owner, { tab_handle: handle }, tab, budget);
        const claim = currentClaim(tab.id);
        const checkControl = () => {
          checkConnection();
          if (currentClaim(tab.id) !== claim) throw new Error('Tab control ended during fetch; capture discarded');
        };
        const metadata = (satisfied, reason, readyState) => ({ wait_until: waitUntil, wait_satisfied: satisfied,
          degraded: !satisfied, degraded_reason: reason, ready_state: readyState, document_changed: !!temporary.document_changed });
        const httpFailure = response => {
          if ((args.format ?? 'text') === 'json') throw new Error(`HTTP ${response.status}: navigation produced an error page without a readable JSON document`);
          return { url: httpUrl(response.url), contentType: response.contentType, format: args.format ?? 'text', body: '',
            body_source: response.empty_body ? 'http_response' : 'unavailable', ...(!response.empty_body ? { body_unavailable: true } : {}),
            capture_truncated: false, status: response.status, ok: response.status >= 200 && response.status < 300,
            ...metadata(false, 'http_error_response', null), navigation_error: response.error };
        };
        checkControl();
        if (budget.remaining() < 100) throw new Error('Fetch preparation timed out; no navigation was dispatched');
        const readReserve = Math.min(2000, Math.floor(budget.remaining() / 3));
        const waitEnd = Date.now() + budget.remaining() - readReserve;
        const waitBudget = deadline(timeout, 'wait', waitEnd);
        let satisfied = false, reason = null, waitedDocument;
        try {
          const navigationResult = await navigation.navigate(tab.id, url, { wait_until: waitUntil === 'network_idle' ? 'load' : waitUntil,
            timeout_ms: Math.max(100, waitBudget.remaining()) });
          waitedDocument = JSON.stringify([navigationResult.document.frameId, navigationResult.document.loaderId]);
          checkControl();
          if (waitUntil === 'network_idle') await waitFor(cdp, value, sessions, network, pointer, tab.id, { condition: 'network_idle', budget: waitBudget });
          satisfied = true;
        } catch (error) {
          checkControl();
          if (error.navigation_error === 'net::ERR_HTTP_RESPONSE_CODE_FAILURE') {
            const response = network.failedDocument(tab.id, observations.mainFrame(tab.id));
            if (response) return httpFailure(response);
            throw error;
          }
          if (error.code === 'NAVIGATION_TIMEOUT' || (waitUntil === 'network_idle' && waitBudget.remaining() === 0)) reason = 'wait_timeout';
          else if (error.navigation_error === 'net::ERR_ABORTED' && temporary.document) reason = 'navigation_interrupted';
          else throw error;
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          checkControl();
          const version = observations.version(tab.id);
          try {
            const { frameTree } = await budget.run(() => cdp(tab.id, 'Page.getFrameTree'));
            const response = frameTree.frame.unreachableUrl && network.failedDocument(tab.id, frameTree.frame.id);
            if (response && response.url === frameTree.frame.unreachableUrl) return httpFailure(response);
            httpUrl(frameTree.frame.url);
            const { executionContextId } = await budget.run(() => cdp(tab.id, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'browser-attach-fetch' }));
            const result = value(await budget.run(() => cdp(tab.id, 'Runtime.evaluate', { contextId: executionContextId, returnByValue: true, userGesture: false,
              expression: `(${capturePage.toString()})(${JSON.stringify(args.format ?? 'text')},${cap})` })));
            checkControl();
            if (observations.version(tab.id) !== version) throw Object.assign(new Error('Document changed during fetch capture'), { code: 'FETCH_DOCUMENT_CHANGED' });
            httpUrl(result.url);
            const status = network.documentStatus(tab.id, frameTree.frame);
            if (satisfied && waitedDocument !== JSON.stringify([frameTree.frame.id, frameTree.frame.loaderId])) { satisfied = false; reason = 'document_changed'; }
            return { ...result, status, ok: status == null ? null : status >= 200 && status < 300,
              ...metadata(satisfied, reason, result.ready_state) };
          } catch (error) {
            checkControl();
            const changing = observations.version(tab.id) !== version || error.code === 'FETCH_DOCUMENT_CHANGED' || /context.*(destroyed|not found)|cannot find context|no frame with given id|inspected target navigated/i.test(error.message);
            if (!changing || attempt === 2) throw error;
            await budget.run(() => new Promise(resolve => setTimeout(resolve, 25)));
          }
        }
      } catch (error) { failure = error; throw error; }
      finally {
        try { await boundedRead(() => closeTemporary(tab.id), Math.max(1, end - Date.now())); }
        catch (error) { throw new Error(`${failure ? failure.message + '; ' : ''}Fetch temporary tab ${tab.id} could not be closed: ${error.message}. Cleanup will be retried on disconnect.`); }
      }
    });
  }


  function event(source, method, params) {
    const mainNavigation = !source.sessionId && method === 'Page.frameNavigated' && params.frame && !params.frame.parentId;
    const temporary = temporaryTabs.get(source.tabId);
    if (mainNavigation && temporary && params.frame.loaderId) {
      const document = JSON.stringify([params.frame.id, params.frame.loaderId]);
      if (!temporary.firstDocument && /^https?:/.test(params.frame.url || '') && !params.frame.unreachableUrl) temporary.firstDocument = document;
      if (temporary.firstDocument) {
        temporary.document = document;
        temporary.document_changed ||= document !== temporary.firstDocument;
      }
    }
  }
  return { read: fetchPage, close: closeTemporary, event,
    has: tabId => temporaryTabs.has(tabId), entries: () => temporaryTabs.entries(),
    removed: tabId => temporaryTabs.delete(tabId),
  };
}
