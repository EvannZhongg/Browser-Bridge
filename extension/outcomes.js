import { deadline } from './actionability.js';
import { resolveFrame } from './locator.js';

// Observation can confirm a dialog/navigation/mutation, never absence of delivery.
export async function boundedRead(operation, ms = 300) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('observation did not respond')), ms); })]); }
  finally { clearTimeout(timer); }
}
export function installOutcomeObserver() {
  let mutations = 0;
  const observer = new MutationObserver(records => { mutations += records.length; });
  observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  const startUrl = location.href;
  let expiry = setTimeout(() => observer.disconnect(), 55000);
  return { read() { mutations += observer.takeRecords().length; return { dom_changed: mutations > 0, mutation_records: mutations, start_url: startUrl, current_url: location.href }; },
    stop() { clearTimeout(expiry); observer.disconnect(); } };
}

export function createOutcomes(cdp, value, sessions, observations, getTab, getDialog) {
  async function begin(tabId, command, args) {
    const version = observations.version(tabId), startTab = await getTab(tabId);
    const watch = ['click', 'fill', 'type', 'press_key', 'hover', 'scroll', 'select_option', 'upload_file', 'evaluate', 'navigate'].includes(command) && !(command === 'evaluate' && args.cursor != null);
    let observer, observationError, observationFrame = observations.mainFrame(tabId), observationTarget = { tabId }, observedVersion = observations.frameVersion(tabId, observationFrame);
    const startObservation = async () => { if (!watch || observer || getDialog(tabId)) return; try {
      observer = await boundedRead(async () => {
        if (args.ref) observationFrame = observations.refFrame(tabId, args.ref) || observationFrame;
        else if (args.frame || args.frame_id) observationFrame = await resolveFrame(cdp, value, sessions, tabId, args, deadline(Math.max(100, Math.min(200, args.budget?.remaining() ?? 200))), { wait: false });
        observationTarget = sessions.target(tabId, observationFrame);
        observedVersion = observations.frameVersion(tabId, observationFrame);
        const { executionContextId } = await cdp(observationTarget, 'Page.createIsolatedWorld', { frameId: observationFrame, worldName: 'browser-attach-outcome' });
        const result = await cdp(observationTarget, 'Runtime.evaluate', { contextId: executionContextId, expression: `(${installOutcomeObserver.toString()})()`, objectGroup: 'browser-attach-outcome' });
        if (!result.result?.objectId) throw new Error('DOM outcome observer could not be installed');
        return result.result.objectId;
      }, Math.min(200, args.budget?.remaining() ?? 200));
    } catch (error) { observationError = error.message; } };

    async function enrich(error, messages) {
      if (!watch || error.input_dispatched === false || !error.outcome_unknown) return false;
      let current, dom, tabError, domError = observationError;
      await Promise.allSettled([
        boundedRead(() => getTab(tabId)).then(result => { if (result) current = result; else tabError = 'Tab is unavailable'; }, error => { tabError = error.message; }),
        observer ? boundedRead(async () => {
          const result = value(await cdp(observationTarget, 'Runtime.callFunctionOn', { objectId: observer, functionDeclaration: 'function() { return this.read(); }', returnByValue: true }));
          if (typeof result?.dom_changed !== 'boolean') throw new Error('DOM outcome observation is unavailable');
          return result;
        }).then(result => { dom = result; }, error => { domError = error.message; }) : Promise.resolve(),
      ]);
      const frameChanged = observations.frameVersion(tabId, observationFrame) !== observedVersion;
      const navigationObserved = observations.version(tabId) !== version || !!current && current.url !== startTab.url;
      error.post_action = { delivery: 'unknown', frame_id: observationFrame, frame_navigation_observed: frameChanged, dialog: getDialog(tabId) || null, dialogs: messages,
        navigation_observed: navigationObserved,
        current_url: current?.url ?? null, dom_changed: dom?.dom_changed ?? null,
        observations: { tab: { available: !!current, ...(tabError ? { error: tabError } : {}) },
          dom: { available: !!dom, ...(!dom ? { error: domError || 'DOM outcome observer is unavailable' } : {}) } },
        assessment: !!getDialog(tabId) || messages.length || navigationObserved || frameChanged || dom?.dom_changed ? 'observable_effects'
          : dom && current ? 'no_observable_effects' : 'observation_unavailable',
        note: 'These observations do not prove business success or that an unchanged page received no input. Do not replay automatically.' };

      return true;
    }
    async function stop() {
      if (observer) await boundedRead(async () => {
        await cdp(observationTarget, 'Runtime.callFunctionOn', { objectId: observer, functionDeclaration: 'function() { this.stop(); }' });
        await cdp(observationTarget, 'Runtime.releaseObject', { objectId: observer });
      }, 100).catch(() => {});
    }
    return { start: startObservation, enrich, stop };
  }
  return { begin };
}
