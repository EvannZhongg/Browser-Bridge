// Browser operations live here; the WebSocket transport never exposes raw CDP.
import { createVisuals } from './visuals.js';
import { createClickVisuals } from './click-visuals.js';
import { renderAX, snapshotPage } from './snapshot.js';
import { createNavigation } from './navigation.js';
import { createClick, clickOptions } from './click.js';
import { createInput, inputMode } from './input.js';
import { createEvaluations } from './evaluate.js';
import { targetOptions, resolveSelector } from './locator.js';
import { readText } from './text.js';
import { createDiagnostics } from './diagnostics.js';
import { createSessions } from './sessions.js';
import { NAVIGATION_OBSERVATION_TIMEOUT_MS } from './limits.js';
import { deadline } from './actionability.js';
import { validateSteps } from './batch.js';

export function createController(api, notify = () => {}) {
  const claims = new Map();
  const snapshots = new Map();
  const documents = new Map();
  const frameStates = new Map();
  const queues = new Map();
  const dialogs = new Map();
  const fileChoosers = new Map();
  const dialogWaiters = new Map();
  const visuals = createVisuals(api);
  const clickVisuals = createClickVisuals(api);
  const navigation = createNavigation(cdp);
  const diagnostics = createDiagnostics();
  const sessions = createSessions(cdp, invalidateFrame, (tabId, sessionId) => diagnostics.detach(tabId, sessionId));
  const mouse = createClick(cdp, value, viewport, position, sessions, tabId => api.tabs.get(tabId), windowId => api.windows.get(windowId));
  const input = createInput(cdp, value, sessions);
  const evaluations = createEvaluations(cdp);

  function queued(tabId, operation) {
    const result = (queues.get(tabId) || Promise.resolve()).catch(() => {}).then(operation);
    queues.set(tabId, result);
    const done = () => { if (queues.get(tabId) === result) queues.delete(tabId); };
    result.then(done, done);
    return result;
  }

  function httpUrl(url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('Only http(s) pages without URL credentials can be controlled');
    }
    return parsed.href;
  }

  async function cdp(target, method, params = {}) {
    if (typeof target === 'number') target = { tabId: target };
    const { tabId } = target;
    if (!method.startsWith('Input.') && method !== 'Runtime.callFunctionOn' && method !== 'Runtime.evaluate' && method !== 'Page.navigate' && method !== 'DOM.setFileInputFiles') {
      return await api.debugger.sendCommand(target, method, params);
    }
    // Input handlers may open a modal and prevent the CDP response from returning.
    // Free the tab queue so the next tool can observe and resolve that modal.
    let rejectDialog;
    const dialog = new Promise((resolve, reject) => { rejectDialog = reject; });
    const waiters = dialogWaiters.get(tabId) || new Set();
    dialogWaiters.set(tabId, waiters);
    waiters.add(rejectDialog);
    try {
      return await Promise.race([api.debugger.sendCommand(target, method, params), dialog]);
    } finally {
      waiters.delete(rejectDialog);
      if (waiters.size === 0) dialogWaiters.delete(tabId);
    }
  }

  function value(result) {
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  async function getObject(tabId, ref, budget) {
    const node = snapshots.get(tabId)?.refs.get(ref);
    if (!node) throw new Error('Element ref is stale or unknown. Take a new browser_snapshot.');
    const target = sessions.target(tabId, node.frameId);
    if (target.sessionId !== node.sessionId) throw new Error('Frame session changed; take a new browser_snapshot.');
    const resolved = await budget.run(() => cdp(target, 'DOM.resolveNode', { backendNodeId: node.backendNodeId, objectGroup: 'browser-attach' }));
    if (!resolved.object?.objectId) throw new Error('Element no longer exists. Take a new browser_snapshot.');
    return { ...node, target, objectId: resolved.object.objectId };
  }

  async function viewport(tabId) {
    return value(await cdp(tabId, 'Runtime.evaluate', {
      expression: '({width: innerWidth, height: innerHeight, scroll_x: scrollX, scroll_y: scrollY, device_pixel_ratio: devicePixelRatio})', returnByValue: true,
    }));
  }

  function position(view, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= view.width || y >= view.height) {
      throw new Error(`Position must be inside the viewport (${view.width} x ${view.height} CSS pixels)`);
    }
    return { x, y };
  }

  async function release(tabId) {
    if (!claims.has(tabId)) return;
    // Forget only after detach; a failed detach must not silently grant another owner.
    try { await clickVisuals.remove(tabId, dialogs.has(tabId)); await visuals.remove(tabId); }
    finally { await api.debugger.detach({ tabId }); }
    claims.delete(tabId);
    evaluations.forget(tabId);
    snapshots.delete(tabId);
    documents.delete(tabId);
    frameStates.delete(tabId);
    dialogs.delete(tabId);
    fileChoosers.delete(tabId);
    diagnostics.forget(tabId);
    sessions.forget(tabId);
    notify({ type: 'detached', tab_id: tabId });
  }

  async function releaseMatching(predicate) {
    const targets = [...claims.entries()].filter(([, claim]) => predicate(claim));
    const outcomes = await Promise.allSettled(targets.map(([tabId]) => queued(tabId, () => release(tabId))));
    return { released: outcomes.filter(item => item.status === 'fulfilled').length,
      errors: outcomes.filter(item => item.status === 'rejected').map(item => String(item.reason)) };
  }

  function forget(tabId) {
    evaluations.forget(tabId);
    navigation.cancel(tabId);
    mouse.cancel(tabId);
    input.cancel(tabId);
    visuals.forget(tabId);
    clickVisuals.forget(tabId);
    claims.delete(tabId);
    snapshots.delete(tabId);
    documents.delete(tabId);
    frameStates.delete(tabId);
    dialogs.delete(tabId);
    fileChoosers.delete(tabId);
    diagnostics.forget(tabId);
    sessions.forget(tabId);
    notify({ type: 'detached', tab_id: tabId });
  }
  api.debugger.onDetach.addListener(source => { if (!source.sessionId) forget(source.tabId); });
  api.debugger.onEvent.addListener((source, method, params = {}) => {
    sessions.event(source, method, params);
    if (!sessions.has(source)) return;
    diagnostics.event(source, method, params);
    if (!source.sessionId) navigation.event(source.tabId, method, params);
    mouse.event(source.tabId, method, params, source.sessionId);
    input.event(source.tabId, method, params, source.sessionId);
    const frames = frameStates.get(source.tabId);
    if (method === 'Page.frameAttached') frames?.parents.set(params.frameId, params.parentFrameId);
    const mainNavigation = !source.sessionId && method === 'Page.frameNavigated' && params.frame && !params.frame.parentId;
    if (mainNavigation && frames) {
      frames.mainId = params.frame.id;
      frames.parents.clear(); frames.versions.clear(); frames.sessions.clear();
    }
    if (method === 'Page.frameNavigated' && params.frame?.parentId) frames?.parents.set(params.frame.id, params.frame.parentId);
    const sameDocumentMain = method === 'Page.navigatedWithinDocument' && params.frameId === frames?.mainId;
    if ((!source.sessionId && method === 'DOM.documentUpdated') || mainNavigation || sameDocumentMain) {
      evaluations.forget(source.tabId);
      documents.set(source.tabId, (documents.get(source.tabId) || 0) + 1);
      snapshots.delete(source.tabId);
      fileChoosers.delete(source.tabId);
    } else if (source.sessionId && method === 'DOM.documentUpdated') {
      for (const [frame, session] of frameStates.get(source.tabId)?.sessions || []) if (session === source.sessionId) invalidateFrame(source.tabId, frame);
    } else if (method === 'Page.frameNavigated' || method === 'Page.navigatedWithinDocument' || method === 'Page.frameDetached') {
      invalidateFrame(source.tabId, params.frame?.id || params.frameId);
    }
    if (method === 'Page.fileChooserOpened' && claims.has(source.tabId)) {
      if (params.backendNodeId) fileChoosers.set(source.tabId, {
        sessionId: source.sessionId, backendNodeId: params.backendNodeId, mode: params.mode, frame_id: params.frameId,
      });
    }
    if (mainNavigation) clickVisuals.navigated(source.tabId);
    if (method === 'Page.javascriptDialogOpening') {
      dialogs.set(source.tabId, { sessionId: source.sessionId, type: params.type, message: params.message, default_prompt: params.defaultPrompt, default_button: null });
      snapshots.delete(source.tabId);
      for (const reject of dialogWaiters.get(source.tabId) || []) {
        reject(new Error('The action opened a JavaScript dialog. It may already have executed; use browser_snapshot and browser_handle_dialog before continuing.'));
      }
    }
    if (method === 'Page.javascriptDialogClosed') dialogs.delete(source.tabId);
  });
  api.tabs.onRemoved.addListener(forget);
  api.tabs.onUpdated.addListener((tabId, change) => {
    // A subframe reload can also set the TAB status to loading. CDP main-frame
    // events identify document changes; a status-only update carries no identity.
    if (change.url) {
      evaluations.forget(tabId);
      documents.set(tabId, (documents.get(tabId) || 0) + 1);
      snapshots.delete(tabId); fileChoosers.delete(tabId);
    }
  });

  function invalidateFrame(tabId, frameId) {
    const frames = frameStates.get(tabId);
    if (!frames || !frameId) return;
    const affected = new Set([frameId]);
    // Descendant documents disappear with their parent, even without individual events.
    let size;
    do {
      size = affected.size;
      for (const [id, parent] of frames.parents) if (affected.has(parent)) affected.add(id);
    } while (size !== affected.size);
    const state = snapshots.get(tabId);
    for (const id of affected) {
      frames.versions.set(id, (frames.versions.get(id) || 0) + 1);
      if (state) omitFrame(state, id, 'Frame navigated or detached after observation');
    }
    if (affected.has(fileChoosers.get(tabId)?.frame_id)) fileChoosers.delete(tabId);
  }

  function omitFrame(state, frameId, reason) {
    if (state.invalidFrames.has(frameId)) return;
    state.invalidFrames.add(frameId);
    for (const [ref, node] of state.refs) if (node.frameId === frameId) state.refs.delete(ref);
    state.totalNodes -= state.entries.filter(entry => entry.frameId === frameId && entry.node).length;
    state.metadata.omitted_frames.push({ frame_id: frameId, reason });
  }

  async function snapshot(tabId, args = {}, budget) {
    const send = (...params) => budget ? budget.run(() => cdp(...params)) : cdp(...params);
    if (args.cursor != null) {
      const state = snapshots.get(tabId);
      if (!state) throw new Error('Snapshot cursor is stale or unknown. Take a new browser_snapshot.');
      return snapshotPage(state, args);
    }
    snapshots.delete(tabId);
    const documentVersion = documents.get(tabId);
    const versions = new Map(frameStates.get(tabId)?.versions);
    await (budget ? budget.run(() => sessions.settle(tabId)) : sessions.settle(tabId));
    for (const target of sessions.targets(tabId)) await send(target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach' });
    const frames = await (budget ? budget.run(() => sessions.frames(tabId, send)) : sessions.frames(tabId, send));
    const mainId = frameStates.get(tabId).mainId;
    for (const frame of frames) if (frame.parentId) frameStates.get(tabId).parents.set(frame.id, frame.parentId);
    const knownFrames = new Set(frames.map(frame => frame.id));
    const token = crypto.randomUUID().slice(0, 8);
    const refs = new Map(), entries = [], omittedFrames = [];
    for (const frame of frames) {
      let nodes;
      let target;
      try {
        target = sessions.target(tabId, frame.id);
        frameStates.get(tabId).sessions.set(frame.id, target.sessionId);
        ({ nodes } = await send(target, 'Accessibility.getFullAXTree', { frameId: frame.id }));
      }
      catch (error) {
        if (frame.id === mainId) throw error;
        omittedFrames.push({ frame_id: frame.id, url: frame.url, reason: error.message });
        continue;
      }
      // Report cross-process frames that are missing from Page.getFrameTree.
      for (const node of nodes) {
        if (!/^iframe$/i.test(node.role?.value || '') || !node.backendDOMNodeId) continue;
        const { node: owner } = await send(target, 'DOM.describeNode', { backendNodeId: node.backendDOMNodeId, depth: 0 });
        const childId = owner.frameId || owner.contentDocument?.frameId;
        if (!childId) continue;
        frameStates.get(tabId)?.parents.set(childId, frame.id);
        sessions.rememberParent(tabId, childId, frame.id);
        if (knownFrames.has(childId)) continue;
        const attributes = owner.attributes || [], srcIndex = attributes.indexOf('src');
        const url = srcIndex >= 0 ? new URL(attributes[srcIndex + 1], frame.url).href : 'about:blank';
        knownFrames.add(childId); frames.push({ id: childId, url });
      }
      entries.push({ node: false, frameId: frame.id, line: `Frame ${frame.id} ${frame.url}` });
      entries.push(...renderAX(nodes, token, refs, frame.id, target.sessionId));
    }
    const metadata = value(await send(tabId, 'Runtime.evaluate', {
      expression: '({title: document.title, url: location.href})', returnByValue: true,
    }));
    const state = { id: token, refs, entries, invalidFrames: new Set(), totalNodes: entries.filter(entry => entry.node).length,
      metadata: { title: metadata.title, url: metadata.url, viewport: await (budget ? budget.run(() => viewport(tabId)) : viewport(tabId)), omitted_frames: omittedFrames } };
    if (documentVersion !== documents.get(tabId)) throw new Error('Document changed while reading the snapshot. Take a new browser_snapshot.');
    for (const frame of frames) if (versions.get(frame.id) !== frameStates.get(tabId)?.versions.get(frame.id)) {
      omitFrame(state, frame.id, 'Frame changed while reading the snapshot; take a new snapshot to observe it');
    }
    const page = snapshotPage(state, args);
    snapshots.set(tabId, state);
    return page;
  }

  async function action(tabId, command, args) {
    // Reading buffered diagnostics does not require a responsive renderer.
    if (command === 'logs') return diagnostics.read(tabId, args);
    if (command === 'handle_dialog') {
      if (typeof args.accept !== 'boolean') throw new Error('accept must be a boolean');
      const dialog = dialogs.get(tabId);
      await cdp({ tabId, ...(dialogs.get(tabId)?.sessionId ? { sessionId: dialogs.get(tabId).sessionId } : {}) }, 'Page.handleJavaScriptDialog', { accept: args.accept,
        ...(args.prompt_text != null ? { promptText: String(args.prompt_text) } : {}) });
      dialogs.delete(tabId);
      snapshots.delete(tabId);
      return { handled: true, dialog: dialog ?? null, accepted: args.accept, observe_again: true };
    }
    if (dialogs.has(tabId)) {
      if (command === 'snapshot') return { dialog: dialogs.get(tabId), note: 'Use browser_handle_dialog to accept or dismiss this dialog.' };
      if (command !== 'release_tab') throw new Error('A JavaScript dialog is open. Observe browser_snapshot and use browser_handle_dialog.');
    }
    if (command === 'snapshot') return await snapshot(tabId, args);
    if (command === 'batch') {
      validateSteps(args.steps);
      const budget = deadline(args.timeout_ms ?? 15000), results = [];
      const claim = claims.get(tabId), documentVersion = documents.get(tabId);
      for (const [index, step] of args.steps.entries()) {
        try {
          if (claims.get(tabId) !== claim) throw new Error('Tab control ended during batch; observe before continuing');
          if (documents.get(tabId) !== documentVersion) throw new Error('Document changed during batch; observe before continuing');
          httpUrl((await budget.run(() => api.tabs.get(tabId))).url);
          const { action: command, ...inputArgs } = step;
          results.push(await action(tabId, command, { ...inputArgs, budget }));
        } catch (error) {
          return { completed: false, results, failed_step: index, error: error.message,
            application_result: 'not_checked', observe_again: true };
        }
      }
      return { completed: true, results, application_result: 'not_checked', observe_again: true };
    }
    if (command === 'evaluate') {
      if (args.cursor == null) snapshots.delete(tabId);
      return await evaluations.read(tabId, args);
    }
    if (command === 'read_text') {
      return await readText(cdp, value, tabId, args);
    }
    if (command === 'screenshot') {
      const view = await viewport(tabId);
      const clip = args.full_page ? await fullPageClip(tabId) : null;
      const includeIndicators = args.include_indicators === true;
      const hiddenError = includeIndicators ? null : await clickVisuals.visible(tabId, false);
      if (hiddenError) throw new Error(`Could not hide click feedback for a clean screenshot: ${hiddenError}`);
      try {
        // Render an explicit target surface without activating its tab or window.
        const captureClip = clip || { x: view.scroll_x, y: view.scroll_y, width: view.width, height: view.height, scale: 1 };
        let timer;
        let result;
        try {
          result = await Promise.race([
            cdp(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true,
              captureBeyondViewport: true, optimizeForSpeed: true, clip: captureClip }),
            new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(
              'Screenshot did not finish within 5 seconds. An inactive or occluded Chromium page may not render. Use browser_activate_tab before requesting another screenshot, or use DOM/AX.'
            )), 5000); }),
          ]);
        } finally { clearTimeout(timer); }
        return { ...result, capture: { scope: clip ? 'full_page' : 'viewport', viewport: view,
          css_width: clip?.width ?? view.width, css_height: clip?.height ?? view.height,
          image_origin_css: { x: clip ? 0 : view.scroll_x, y: clip ? 0 : view.scroll_y },
          click_coordinate_space: 'viewport_css_pixels', agent_indicators_included: includeIndicators } };
      } finally { await clickVisuals.visible(tabId, true); }
    }
    if (command === 'release_tab') { await release(tabId); return { released: true }; }
    if (command === 'navigate') {
      const url = httpUrl(args.url);
      evaluations.forget(tabId);
      snapshots.delete(tabId);
      fileChoosers.delete(tabId);
      const result = await navigation.navigate(tabId, url, args);
      const budget = deadline(NAVIGATION_OBSERVATION_TIMEOUT_MS, 'observation');
      for (let attempt = 0; attempt < 2; attempt++) try {
        if (args.include_snapshot === false) {
          const metadata = value(await budget.run(() => cdp(tabId, 'Runtime.evaluate', {
            expression: '({title: document.title, url: location.href})', returnByValue: true,
          })));
          return { ...result, ...metadata };
        }
        return { ...result, ...await snapshot(tabId, {}, budget) };
      } catch (error) {
        snapshots.delete(tabId);
        if (attempt === 0 && budget.remaining() > 100 && /context.*(destroyed|not found)|cannot find context|document (changed|updated)|inspected target navigated|no frame with given id/i.test(error.message)) {
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }
        return { ...result, observation_error: error.message, observe_again: true };
      }
    }
    // Resolve the ref before consuming it; every input invalidates the whole observation.
    if (command === 'click' || command === 'fill') inputMode(args);
    if (command === 'click' || command === 'fill') targetOptions(args, { coordinates: command === 'click' && inputMode(args) !== 'dom' });
    if (command === 'click') clickOptions(args);
    if (['click', 'fill', 'press_key', 'scroll'].includes(command)) args = { ...args, budget: args.budget || deadline(args.timeout_ms) };
    // Check before any renderer preparation or ref invalidation. A rejected
    // inactive native click is known not to have dispatched, unlike a lost
    // receipt after input. DOM mode remains an explicit separate operation.
    if (command === 'click' && inputMode(args) === 'native') await mouse.assertReady(tabId, args.budget);
    // Reusable selectors permit many actions without a snapshot. Release the
    // previous operation's remote wrappers before resolving this one. Refs store
    // backend ids, not object handles; this cannot change their identity.
    if (args.budget) for (const target of sessions.targets(tabId)) {
      await args.budget.run(() => cdp(target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach' }));
    }
    const node = args.selector ? await resolveSelector(cdp, value, sessions, tabId, args, args.budget || deadline(30000)) :
      args.ref ? await getObject(tabId, args.ref, args.budget || deadline(30000)) : null;
    snapshots.delete(tabId);
    if (command === 'upload_file') {
      if (!Array.isArray(args.files) || args.files.length > 100 || args.files.some(file => typeof file !== 'string' || !file || file.includes('\0'))) {
        throw new Error('files must contain at most 100 valid absolute file paths; [] clears selection');
      }
      const chooser = fileChoosers.get(tabId);
      let target = node;
      if (!target) {
        if (!chooser) throw new Error('No pending file chooser. Supply a fresh file-input/label ref, or click the upload button first.');
        const resolved = await cdp({ tabId, ...(chooser.sessionId ? { sessionId: chooser.sessionId } : {}) }, 'DOM.resolveNode', { backendNodeId: chooser.backendNodeId, objectGroup: 'browser-attach' });
        if (!resolved.object?.objectId) throw new Error('File chooser input no longer exists. Observe again.');
        target = { objectId: resolved.object.objectId, target: { tabId, ...(chooser.sessionId ? { sessionId: chooser.sessionId } : {}) } };
      }
      const resolved = await cdp(target.target, 'Runtime.callFunctionOn', {
        objectId: target.objectId, arguments: [{ value: args.files.length }],
        functionDeclaration: `function(count) {
          const input = this.tagName === 'LABEL' ? this.control : this;
          if (!input || input.tagName !== 'INPUT' || input.type !== 'file') throw new Error('Ref is not a file input or associated label');
          if (!input.isConnected) throw new Error('File input is detached');
          if (input.matches(':disabled')) throw new Error('File input is disabled');
          if (input.webkitdirectory) throw new Error('Directory upload is unsupported; use a regular file input');
          if (count > 1 && !input.multiple) throw new Error('Single-file input cannot accept multiple files');
          return input;
        }`, objectGroup: 'browser-attach',
      });
      if (resolved.exceptionDetails) value(resolved);
      if (!resolved.result?.objectId) throw new Error('Could not resolve the file input');
      if (args.files.length === 0) {
        // Chromium's native empty-path assignment does not emit input/change.
        // Like Playwright's empty payload path, explicitly clear and notify the app.
        value(await cdp(target.target, 'Runtime.callFunctionOn', { objectId: resolved.result.objectId, returnByValue: true,
          functionDeclaration: `function() {
            this.value = '';
            const Event = this.ownerDocument.defaultView.Event;
            this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }` }));
      } else {
        // Native CDP assignment emits input/change and preserves actual file metadata.
        await cdp(target.target, 'DOM.setFileInputFiles', { objectId: resolved.result.objectId, files: args.files });
      }
      fileChoosers.delete(tabId);
      return { files_set: args.files.length, cleared: args.files.length === 0, observe_again: true };
    }
    if (command === 'click') {
      if (inputMode(args) === 'dom') return await input.domClick(tabId, node, args);
      const result = await mouse.click(tabId, node, args);
      // Keep click feedback out of the input dispatch/verification path.
      void clickVisuals.click(tabId, result.clicked.x, result.clicked.y).catch(() => {});
      return result;
    }
    if (command === 'fill') return await input.fill(tabId, node, args);
    if (command === 'press_key') return await input.pressKey(tabId, args.key, args);
    if (command === 'scroll') {
      const mode = args.mode ?? 'dom';
      if (!['dom', 'wheel'].includes(mode)) throw new Error('scroll mode must be dom or wheel');
      if (!Number.isFinite(args.delta_y) || !Number.isFinite(args.delta_x ?? 0)) throw new Error('Scroll deltas must be finite');
      const budget = args.budget;
      const view = await budget.run(() => viewport(tabId));
      const point = position(view, args.x ?? view.width / 2, args.y ?? view.height / 2);
      budget.dispatch();
      if (mode === 'wheel') {
        // Root-widget routing respects ancestor overlays and OOPIF boundaries.
        // A protocol acknowledgement does not prove a page handler ran or scrolled.
        await budget.run(() => cdp(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel', ...point, deltaX: args.delta_x ?? 0, deltaY: args.delta_y,
          button: 'none', buttons: 0, modifiers: 0,
        }));
        return { dispatched: true, method: 'native_wheel', at: point, coordinate_space: 'viewport_css_pixels',
          application_result: 'not_checked', observe_again: true };
      }
      const result = value(await budget.run(() => cdp(tabId, 'Runtime.evaluate', { returnByValue: true,
        expression: `(${scrollAtPoint.toString()})(${point.x},${point.y},${args.delta_x ?? 0},${args.delta_y})` })));
      return { ...result, observe_again: true };
    }
    throw new Error(`Unknown operation: ${command}`);
  }

  async function fullPageClip(tabId) {
    const { cssContentSize } = await cdp(tabId, 'Page.getLayoutMetrics');
    if (cssContentSize.width * cssContentSize.height > 40000000) throw new Error('Full-page capture exceeds 40 million pixels; use viewport capture');
    return { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
  }

  async function execute(owner, command, args) {
    if (command === 'open_tab') {
      const url = httpUrl(args.url);
      if (args.active != null && typeof args.active !== 'boolean') throw new Error('active must be a boolean');
      const tab = await api.tabs.create({ url, active: args.active ?? false });
      return { opened: true, tab_id: tab.id, window_id: tab.windowId, active: tab.active,
        note: 'List tabs after loading, then claim tab_id with optional exact URL/title guards before controlling this tab.' };
    }
    if (command === 'list_tabs') {
      const tabs = await api.tabs.query({});
      return { tabs: tabs.map(tab => ({ tab_id: tab.id, window_id: tab.windowId, title: tab.title || '', url: tab.url || '',
        active: tab.active, group_id: tab.groupId, controllable: /^https?:\/\//.test(tab.url || '') })) };
    }
    if (command === 'release_owner') return await releaseMatching(claim => claim.owner === owner);
    const tabId = args.tab_id;
    if (!Number.isInteger(tabId)) throw new Error('Invalid tab ID');
    return await queued(tabId, async () => {
      if (command === 'claim_tab') {
        const tab = await api.tabs.get(tabId);
        if ((args.expected_url != null && tab.url !== args.expected_url) || (args.expected_title != null && tab.title !== args.expected_title)) throw new Error('Tab title/URL changed. List tabs again or omit optional identity guards to claim by tab_id.');
        httpUrl(tab.url);
        const existing = claims.get(tabId);
        if (existing) {
          if (existing.owner === owner && existing.handle === args.tab_handle) return { claimed: true };
          throw new Error('Tab is already controlled by another session');
        }
        await api.debugger.attach({ tabId }, '1.3');
        try {
          diagnostics.start(tabId);
          await sessions.start(tabId);
          const { frameTree } = await cdp(tabId, 'Page.getFrameTree');
          const state = { mainId: frameTree.frame.id, parents: new Map(), versions: new Map(), sessions: new Map() };
          const remember = tree => {
            if (tree.frame.parentId) state.parents.set(tree.frame.id, tree.frame.parentId);
            (tree.childFrames || []).forEach(remember);
          };
          remember(frameTree); frameStates.set(tabId, state);
          claims.set(tabId, { owner, handle: args.tab_handle });
          let visualWarning;
          try { await visuals.install(tabId); }
          catch (error) { visualWarning = error.message; }
          return { claimed: true, activation_requested: false, title: tab.title, url: tab.url,
            ...(visualWarning ? { visual_warning: visualWarning } : {}) };
        } catch (error) {
          diagnostics.forget(tabId);
          sessions.forget(tabId);
          await api.debugger.detach({ tabId });
          throw error;
        }
      }
      const claim = claims.get(tabId);
      if (!claim || claim.owner !== owner || claim.handle !== args.tab_handle) throw new Error('Tab is not claimed by this connection');
      if (command === 'activate_tab') {
        if (args.focus_window != null && typeof args.focus_window !== 'boolean') throw new Error('focus_window must be a boolean');
        const tab = await api.tabs.update(tabId, { active: true });
        if (args.focus_window ?? true) {
          await api.windows.update(tab.windowId, { focused: true });
          // Explicit activation also restores the renderer focus, which can be
          // lost when a focused iframe navigates even if its tab stays active.
          await cdp(tabId, 'Page.bringToFront');
        }
        return { activated: true, window_focus_requested: args.focus_window ?? true, tab_id: tabId, window_id: tab.windowId };
      }
      if (command === 'close_tab') {
        await api.tabs.remove(tabId);
        if (claims.has(tabId)) forget(tabId);
        return { closed: true, tab_id: tabId };
      }
      if (command === 'release_tab') return await action(tabId, command, args);
      httpUrl((await api.tabs.get(tabId)).url);
      const result = await action(tabId, command, args);
      // A batch can stop because its tab closed. Preserve the partial results
      // instead of losing them to a metadata lookup on the vanished tab.
      if (command === 'batch') return { ...result, tab_id: tabId };
      const tab = await api.tabs.get(tabId);
      const chooser = fileChoosers.get(tabId);
      return { ...result, ...(chooser ? { file_chooser: { pending: true, mode: chooser.mode, frame_id: chooser.frame_id,
        note: 'Use browser_upload_file without ref; files: [] cancels the selection.' } } : {}),
        tab_id: tabId, title: result.title ?? tab.title, url: result.url ?? tab.url, active: tab.active };
    });
  }

  return { execute, releaseAll: () => releaseMatching(() => true), claimedCount: () => claims.size };
}

function scrollAtPoint(x, y, dx, dy) {
  let doc = document;
  let element = doc.elementFromPoint(x, y);
  const enteredShadowHosts = new Set();
  while (element) {
    if (element.tagName === 'IFRAME') {
      const frame = element;
      const rect = frame.getBoundingClientRect();
      try { doc = frame.contentDocument; } catch { doc = null; }
      if (!doc) throw new Error('Cross-origin iframe scrolling is unavailable; scroll the outer page or use the website controls.');
      x -= rect.left + frame.clientLeft; y -= rect.top + frame.clientTop;
      element = doc.elementFromPoint(x, y);
      continue;
    }
    if (element.shadowRoot && !enteredShadowHosts.has(element)) {
      enteredShadowHosts.add(element);
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (inner && inner !== element) { element = inner; continue; }
    }
    const style = doc.defaultView.getComputedStyle(element);
    const canX = /auto|scroll|overlay/.test(style.overflowX) && element.scrollWidth > element.clientWidth &&
      ((dx > 0 && element.scrollLeft < element.scrollWidth - element.clientWidth) || (dx < 0 && element.scrollLeft > 0));
    const canY = /auto|scroll|overlay/.test(style.overflowY) && element.scrollHeight > element.clientHeight &&
      ((dy > 0 && element.scrollTop < element.scrollHeight - element.clientHeight) || (dy < 0 && element.scrollTop > 0));
    if (canX || canY) break;
    const parent = element.parentElement || element.getRootNode().host;
    if (!parent) { element = doc.scrollingElement; break; }
    element = parent;
  }
  if (!element) element = doc.scrollingElement;
  const before = { x: element.scrollLeft, y: element.scrollTop };
  element.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  const after = { x: element.scrollLeft, y: element.scrollTop };
  return { scrolled: before.x !== after.x || before.y !== after.y, before, after,
    method: 'dom_scroll', scope: element === doc.scrollingElement ? 'document' : 'element' };
}
