// Browser operations live here; the WebSocket transport never exposes raw CDP.
import { createVisuals } from './visuals.js';
import { createClickVisuals } from './click-visuals.js';
import { renderAX, snapshotOptions, snapshotPage } from './snapshot.js';
import { createNavigation } from './navigation.js';
import { createClick, clickOptions, framePoint } from './click.js';
import { createInput, inputMode, selectOptions, typeOptions } from './input.js';
import { createEvaluations } from './evaluate.js';
import { targetOptions, resolveSelector, resolveFrame } from './locator.js';
import { readText } from './text.js';
import { createDiagnostics } from './diagnostics.js';
import { createSessions } from './sessions.js';
import { NAVIGATION_OBSERVATION_TIMEOUT_MS } from './limits.js';
import { deadline } from './actionability.js';
import { scrollOptions, scrollElement, findScrollText, scrollState } from './scroll.js';
import { validateSteps } from './batch.js';
import { waitFor } from './wait.js';
import { boundedRead, installOutcomeObserver } from './outcomes.js';
import { createDrag, dragOptions } from './drag.js';
import { createFetches, capturePage } from './fetch.js';

export function createController(api, notify = () => {}) {
  const claims = new Map();
  const temporaryTabs = new Map();
  const fetches = createFetches(fetchPage);
  const snapshots = new Map();
  const documents = new Map();
  const pageContexts = new Map();
  const frameStates = new Map();
  const queues = new Map();
  const dialogs = new Map();
  const dialogPolicies = new Map();
  const fileChoosers = new Map();
  const dialogWaiters = new Map();
  const visuals = createVisuals(api);
  const clickVisuals = createClickVisuals(api);
  const navigation = createNavigation(cdp);
  const diagnostics = createDiagnostics(cdp);
  const sessions = createSessions(cdp, invalidateFrame, (tabId, sessionId) => {
    diagnostics.detach(tabId, sessionId);
    for (const key of pageContexts.keys()) { const [tab, session] = JSON.parse(key); if (tab === tabId && session === sessionId) pageContexts.delete(key); }
  }, tabId => diagnostics.networkOptions(tabId));
  const mouse = createClick(cdp, value, viewport, position, sessions, tabId => api.tabs.get(tabId), windowId => api.windows.get(windowId));
  const gestures = createDrag(cdp, value, mouse, viewport);
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
    const { nodes } = await budget.run(() => cdp(target, 'Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false }));
    const current = nodes?.find(item => item.backendDOMNodeId === node.backendNodeId);
    if (!current || !!current.ignored !== !!node.ignored || current.role?.value !== node.role || String(current.name?.value || '') !== node.name) {
      throw new Error('Element ref identity changed (role/name or accessibility); take a new browser_snapshot. No input was dispatched.');
    }
    return { ...node, target, objectId: resolved.object.objectId };
  }

  async function rememberElement(tabId, target, objectId, frameId, budget) {
    const version = documents.get(tabId), claim = claims.get(tabId), frameVersion = frameStates.get(tabId)?.versions.get(frameId);
    const send = (method, params) => budget.run(() => cdp(target, method, params));
    const { node } = await send('DOM.describeNode', { objectId, depth: 0 });
    if (node.nodeType !== 1) throw new Error('Result must be a DOM element');
    const { nodes } = await send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false });
    const ax = nodes?.find(item => item.backendDOMNodeId === node.backendNodeId);
    if (!ax) throw new Error('Element accessibility identity is unavailable; observe again');
    const connected = value(await send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function() { return this.isConnected; }', returnByValue: true }));
    if (!connected) throw new Error('Element is detached; no ref was created');
    if (documents.get(tabId) !== version || claims.get(tabId) !== claim || frameStates.get(tabId)?.versions.get(frameId) !== frameVersion) throw new Error('Element document/frame/control changed; no ref was created');
    let state = snapshots.get(tabId);
    if (!state) {
      state = { id: crypto.randomUUID().slice(0, 8), refs: new Map(), entries: [], invalidFrames: new Set(), totalNodes: 0, nextCursor: null, metadata: { omitted_frames: [] } };
      snapshots.set(tabId, state);
    }
    if ((state.extraRefs || 0) >= 500) throw new Error('Element ref budget exhausted; take a new snapshot');
    state.extraRefs = (state.extraRefs || 0) + 1;
    const ref = `${state.id}:element:${state.extraRefs}`;
    state.refs.set(ref, { backendNodeId: node.backendNodeId, frameId, sessionId: target.sessionId, role: ax.role?.value, name: String(ax.name?.value || ''), ignored: !!ax.ignored });
    return { ref, frame_id: frameId, role: ax.role?.value, name: String(ax.name?.value || '') };
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
    for (const key of pageContexts.keys()) if (JSON.parse(key)[0] === tabId) pageContexts.delete(key);
    frameStates.delete(tabId);
    dialogs.delete(tabId);
    dialogPolicies.delete(tabId);
    fileChoosers.delete(tabId);
    diagnostics.forget(tabId);
    sessions.forget(tabId);
    notify({ type: 'detached', tab_id: tabId });
  }

  async function releaseMatching(predicate) {
    const targets = new Map([...claims, ...temporaryTabs].filter(([, claim]) => predicate(claim)));
    const outcomes = await Promise.allSettled([...targets].map(([tabId]) => queued(tabId, () => temporaryTabs.has(tabId) ? closeTemporary(tabId) : release(tabId))));
    return { released: outcomes.filter(item => item.status === 'fulfilled').length,
      errors: outcomes.filter(item => item.status === 'rejected').map(item => String(item.reason)) };
  }

  function forget(tabId) {
    evaluations.forget(tabId);
    navigation.cancel(tabId);
    mouse.cancel(tabId);
    gestures.cancel(tabId);
    input.cancel(tabId);
    visuals.forget(tabId);
    clickVisuals.forget(tabId);
    claims.delete(tabId);
    snapshots.delete(tabId);
    documents.delete(tabId);
    for (const key of pageContexts.keys()) if (JSON.parse(key)[0] === tabId) pageContexts.delete(key);
    frameStates.delete(tabId);
    dialogs.delete(tabId);
    dialogPolicies.delete(tabId);
    fileChoosers.delete(tabId);
    diagnostics.forget(tabId);
    sessions.forget(tabId);
    notify({ type: 'detached', tab_id: tabId });
  }
  api.debugger.onDetach.addListener(source => { if (!source.sessionId) forget(source.tabId); });
  api.debugger.onEvent.addListener((source, method, params = {}) => {
    sessions.event(source, method, params);
    const contextKey = JSON.stringify([source.tabId, source.sessionId]);
    if (method === 'Runtime.executionContextCreated' && params.context.auxData?.isDefault) pageContexts.set(JSON.stringify([source.tabId, source.sessionId, params.context.auxData.frameId]), params.context.id);
    if (method === 'Runtime.executionContextDestroyed' || method === 'Runtime.executionContextsCleared') {
      for (const [key, id] of pageContexts) if (key.startsWith(contextKey.slice(0, -1) + ',') && (method.endsWith('Cleared') || id === params.executionContextId)) pageContexts.delete(key);
    }
    if (!sessions.has(source)) return;
    diagnostics.event(source, method, params);
    if (!source.sessionId) navigation.event(source.tabId, method, params);
    const policy = dialogPolicies.get(source.tabId);
    const autoDialog = method === 'Page.javascriptDialogOpening' && policy && policy.policy !== 'ask' && policy.messages.length < 10;
    if (!autoDialog) {
      mouse.event(source.tabId, method, params, source.sessionId);
      gestures.event(source.tabId, method, params, source.sessionId);
      input.event(source.tabId, method, params, source.sessionId);
    }
    const frames = frameStates.get(source.tabId);
    if (method === 'Page.frameAttached') frames?.parents.set(params.frameId, params.parentFrameId);
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
      const openedDialog = dialogs.get(source.tabId);
      const message = { ...openedDialog, policy: policy?.policy || 'ask', accepted: autoDialog ? policy.policy === 'accept' : null };
      for (let item = policy; item; item = item.parent) item.messages.push(message);
      if (autoDialog) {
        const handling = cdp(source, 'Page.handleJavaScriptDialog', { accept: policy.policy === 'accept', ...(params.type === 'prompt' ? { promptText: params.defaultPrompt || '' } : {}) });
        policy.handling = handling;
        handling.then(() => { message.handled = true; if (dialogs.get(source.tabId) === openedDialog) dialogs.delete(source.tabId); if (params.type === 'beforeunload' && policy.policy === 'dismiss') navigation.cancel(source.tabId, new Error('Navigation cancelled by dismissed beforeunload')); }, error => { message.handled = false; message.error = error.message; for (const reject of dialogWaiters.get(source.tabId) || []) reject(new Error(`Automatic dialog handling failed: ${error.message}. Outcome is unknown.`)); });
      }
      if (!autoDialog) for (const reject of dialogWaiters.get(source.tabId) || []) {
        reject(new Error('The action opened a JavaScript dialog. It may already have executed; use browser_snapshot and browser_handle_dialog before continuing.'));
      }
    }
    if (method === 'Page.javascriptDialogClosed') dialogs.delete(source.tabId);
  });
  api.tabs.onRemoved.addListener(tabId => { temporaryTabs.delete(tabId); forget(tabId); });
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
      evaluations.forgetFrame(tabId, id);
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

  function expireCursor(tabId) {
    const state = snapshots.get(tabId);
    if (state) state.nextCursor = null;
  }

  async function snapshot(tabId, args = {}, budget) {
    const send = (...params) => budget ? budget.run(() => cdp(...params)) : cdp(...params);
    if (args.cursor != null) {
      const state = snapshots.get(tabId);
      if (!state) throw new Error('Snapshot cursor is stale or unknown. Take a new browser_snapshot.');
      return snapshotPage(state, args);
    }
    const options = snapshotOptions(args);
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
      const rendered = renderAX(nodes, token, refs, frame.id, target.sessionId, options);
      if (rendered.length || options.query == null) entries.push({ node: false, frameId: frame.id, line: `Frame ${frame.id} ${frame.url}` });
      entries.push(...rendered);
    }
    const metadata = value(await send(tabId, 'Runtime.evaluate', {
      expression: '({title: document.title, url: location.href})', returnByValue: true,
    }));
    const state = { id: token, options, refs, entries, invalidFrames: new Set(), totalNodes: entries.filter(entry => entry.node).length,
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
    if (command === 'logs') return await diagnostics.readDetails(tabId, args, sessions.targets(tabId));
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
      validateSteps(args.steps, args.start_at ?? 0);
      const budget = deadline(args.timeout_ms ?? 15000), results = [];
      const claim = claims.get(tabId), documentVersion = documents.get(tabId);
      for (let index = args.start_at ?? 0; index < args.steps.length; index++) {
        const step = args.steps[index];
        try {
          if (claims.get(tabId) !== claim) throw new Error('Tab control ended during batch; observe before continuing');
          if (documents.get(tabId) !== documentVersion) throw new Error('Document changed during batch; observe before continuing');
          httpUrl((await budget.run(() => api.tabs.get(tabId))).url);
          const { action: command, ...inputArgs } = step;
          const stepBudget = budget.child(step.timeout_ms ?? 30000, command === 'wait' ? 'wait' : 'input');
          results.push(await perform(tabId, command, { ...inputArgs, dialog_policy: step.dialog_policy ?? args.dialog_policy ?? 'ask', budget: stepBudget }));
        } catch (error) {
          return { completed: false, results, started_at: args.start_at ?? 0, failed_step: index, next_unattempted_step: index + 1 < args.steps.length ? index + 1 : null, retry_failed_step_safe: error.input_dispatched === false, error: error.message, ...(error.post_action ? { post_action: error.post_action } : {}),
            application_result: 'not_checked', observe_again: true };
        }
      }
      return { completed: true, results, application_result: 'not_checked', observe_again: true };
    }
    if (command === 'evaluate') {
      await args.observe_start?.();
      if (args.result_type != null && !['json', 'element'].includes(args.result_type)) throw new Error('result_type must be json or element');
      if (args.cursor == null) expireCursor(tabId);
      if (args.cursor != null) return await evaluations.read(tabId, args);
      const budget = deadline(args.timeout_ms ?? 10000, 'evaluation'), version = documents.get(tabId), claim = claims.get(tabId);
      const frameId = await resolveFrame(cdp, value, sessions, tabId, args, budget), target = sessions.target(tabId, frameId);
      const contextId = args.frame || args.frame_id ? pageContexts.get(JSON.stringify([tabId, target.sessionId, frameId])) : undefined;
      if ((args.frame || args.frame_id) && contextId == null) throw new Error('Page frame context is unavailable; observe again');
      let result;
      try { result = await budget.run(() => { budget.dispatch(); return evaluations.read(tabId, { ...args, evaluation_frame: frameId, target, context_id: contextId, timeout_ms: Math.max(100, Math.min(args.timeout_ms ?? 10000, budget.remaining())) }); }); }
      catch (error) { evaluations.forget(tabId); if (args.result_type === 'element') await boundedRead(() => cdp(target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach-evaluation' }), 100).catch(() => {}); throw error; }
      if (!result.element) return { ...result, frame_id: frameId, scope: args.frame || args.frame_id ? 'frame' : 'main_frame' };
      try {
      if (documents.get(tabId) !== version || claims.get(tabId) !== claim) throw new Error('Document or claim changed during evaluation; no element ref was created');
      const owner = value(await budget.run(() => cdp(target, 'Runtime.callFunctionOn', { objectId: result.element.objectId,
        functionDeclaration: 'function() { return this.nodeType === 1 && this.isConnected && this.ownerDocument === document; }', returnByValue: true })));
      if (!owner) throw new Error('Element must belong to the selected frame; use a frame locator');
      return { result_type: 'element', ...await rememberElement(tabId, target, result.element.objectId, frameId, budget), observe_again: true };
      } finally { await boundedRead(() => cdp(target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach-evaluation' }), 100).catch(() => {}); }
    }
    if (command === 'wait') return await waitFor(cdp, value, sessions, diagnostics, mouse, tabId, args);
    if (command === 'drag') {
      dragOptions(args);
      args = { ...args, budget: deadline(args.timeout_ms ?? 5000) };
      await mouse.assertReady(tabId, args.budget);
      await args.observe_start?.();
      const claim = claims.get(tabId), documentVersion = documents.get(tabId);
      for (const target of sessions.targets(tabId)) await args.budget.run(() => cdp(target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach' }));
      expireCursor(tabId);
      return await gestures.drag(tabId, args, (target, budget) => target.selector ? resolveSelector(cdp, value, sessions, tabId, target, budget) : target.ref ? getObject(tabId, target.ref, budget) : null, () => {
        if (claims.get(tabId) !== claim || documents.get(tabId) !== documentVersion) throw new Error('Tab control or document changed during drag; outcome is unknown. Observe before continuing.');
      });
    }
    if (command === 'read_text') {
      if (!args.frame && !args.frame_id) return await readText(cdp, value, tabId, args);
      const budget = deadline(5000), frameId = await resolveFrame(cdp, value, sessions, tabId, args, budget), target = sessions.target(tabId, frameId);
      const contextId = pageContexts.get(JSON.stringify([tabId, target.sessionId, frameId]));
      if (contextId == null) throw new Error('Page frame context is unavailable; observe again');
      return { ...await readText(cdp, value, target, { ...args, context_id: contextId }), scope: 'frame', frame_id: frameId };
    }
    if (command === 'screenshot') {
      const view = await viewport(tabId);
      const hasTarget = args.ref != null || args.selector != null;
      if (!hasTarget && (args.frame || args.frame_id || args.nth != null || args.selector_type)) throw new Error('Element screenshot frame/nth/type requires an element selector');
      if (hasTarget && args.full_page) throw new Error('Element target and full_page are mutually exclusive');
      const clip = hasTarget ? await elementClip(tabId, args, view) : args.full_page ? await fullPageClip(tabId) : null;
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
              'Screenshot did not finish within 5 seconds. An inactive or occluded Chromium page may not render. Use browser_tab_control action=activate before requesting another screenshot, or use DOM/AX.'
            )), 5000); }),
          ]);
        } finally { clearTimeout(timer); }
        return { ...result, capture: { scope: hasTarget ? 'element' : clip ? 'full_page' : 'viewport', viewport: view,
          css_width: clip?.width ?? view.width, css_height: clip?.height ?? view.height,
          image_origin_css: { x: clip?.x ?? view.scroll_x, y: clip?.y ?? view.scroll_y },
          click_coordinate_space: 'viewport_css_pixels', agent_indicators_included: includeIndicators } };
      } finally { await clickVisuals.visible(tabId, true); }
    }
    if (command === 'release_tab') { await release(tabId); return { released: true }; }
    if (command === 'navigate') {
      await args.observe_start?.();
      const url = args.direction != null ? undefined : httpUrl(args.url);
      if (args.direction != null && args.url != null) throw new Error('Provide url or direction, never both');
      evaluations.forget(tabId);
      snapshots.delete(tabId);
      fileChoosers.delete(tabId);
      const { document: navigationDocument, ...result } = await navigation.navigate(tabId, url, args);
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
    // Re-resolve backend identity for every action; document/frame events expire refs.
    if (command === 'click' || command === 'fill') inputMode(args);
    if (command === 'select_option') selectOptions(args);
    if (command === 'type') typeOptions(args);
    if (command === 'scroll') scrollOptions(args);
    if (['scroll', 'upload_file'].includes(command) && ['ref', 'selector', 'frame', 'frame_id', 'selector_type', 'nth'].some(key => args[key] != null)) targetOptions(args);
    if (['click', 'fill', 'type', 'hover', 'select_option'].includes(command)) targetOptions(args, { coordinates: command === 'hover' || command === 'click' && inputMode(args) !== 'dom' });
    if (command === 'click') clickOptions(args);
    if (['click', 'fill', 'type', 'press_key', 'scroll', 'hover', 'select_option', 'upload_file'].includes(command)) args = { ...args, budget: args.budget || deadline(args.timeout_ms) };
    // Check before any renderer preparation or ref invalidation. A rejected
    // inactive native click is known not to have dispatched, unlike a lost
    // receipt after input. DOM mode remains an explicit separate operation.
    if (command === 'hover' || command === 'click' && inputMode(args) === 'native') await mouse.assertReady(tabId, args.budget);
    await args.observe_start?.();
    // Reusable selectors permit many actions without a snapshot. Release the
    // previous operation's remote wrappers before resolving this one. Refs store
    // backend ids, not object handles; this cannot change their identity.
    if (args.budget) for (const target of sessions.targets(tabId)) {
      await args.budget.run(() => cdp(target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach' }));
    }
    const node = args.selector ? await resolveSelector(cdp, value, sessions, tabId, args, args.budget || deadline(30000)) :
      args.ref ? await getObject(tabId, args.ref, args.budget || deadline(30000)) : null;
    expireCursor(tabId);
    if (command === 'upload_file') {
      const send = (target, method, params) => args.budget.run(() => cdp(target, method, params));
      if (!Array.isArray(args.files) || args.files.length > 100 || args.files.some(file => typeof file !== 'string' || !file || file.includes('\0'))) {
        throw new Error('files must contain at most 100 valid absolute file paths; [] clears selection');
      }
      const chooser = fileChoosers.get(tabId);
      let target = node;
      if (!target) {
        if (!chooser) throw new Error('No pending file chooser. Supply a fresh file-input/label ref, or click the upload button first.');
        const resolved = await send({ tabId, ...(chooser.sessionId ? { sessionId: chooser.sessionId } : {}) }, 'DOM.resolveNode', { backendNodeId: chooser.backendNodeId, objectGroup: 'browser-attach' });
        if (!resolved.object?.objectId) throw new Error('File chooser input no longer exists. Observe again.');
        target = { objectId: resolved.object.objectId, target: { tabId, ...(chooser.sessionId ? { sessionId: chooser.sessionId } : {}) } };
      }
      const resolved = await send(target.target, 'Runtime.callFunctionOn', {
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
      args.budget.dispatch();
      if (args.files.length === 0) {
        // Chromium's native empty-path assignment does not emit input/change.
        // Like Playwright's empty payload path, explicitly clear and notify the app.
        value(await send(target.target, 'Runtime.callFunctionOn', { objectId: resolved.result.objectId, returnByValue: true,
          functionDeclaration: `function() {
            this.value = '';
            const Event = this.ownerDocument.defaultView.Event;
            this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }` }));
      } else {
        // Native CDP assignment emits input/change and preserves actual file metadata.
        await send(target.target, 'DOM.setFileInputFiles', { objectId: resolved.result.objectId, files: args.files });
      }
      fileChoosers.delete(tabId);
      return { files_set: args.files.length, cleared: args.files.length === 0, events_trusted: args.files.length > 0, observe_again: true };
    }
    if (command === 'click') {
      if (inputMode(args) === 'dom') return await input.domClick(tabId, node, args);
      const result = await mouse.click(tabId, node, args);
      // Keep click feedback out of the input dispatch/verification path.
      void clickVisuals.click(tabId, result.clicked.x, result.clicked.y).catch(() => {});
      return result;
    }
    if (command === 'hover') return await mouse.click(tabId, node, { ...args, hover: true });
    if (command === 'select_option') return await input.selectOption(tabId, node, args);
    if (command === 'type') return await input.typeText(tabId, node, args);
    if (command === 'fill') return await input.fill(tabId, node, args);
    if (command === 'press_key') return await input.pressKey(tabId, args.key, args);
    if (command === 'scroll' && args.until != null) {
      const { text, selector } = args.until;
      const maxSteps = args.max_steps ?? 100;
      const root = node || await resolveSelector(cdp, value, sessions, tabId, { selector: 'html' }, args.budget);
      const claim = claims.get(tabId), version = documents.get(tabId), frameVersion = frameStates.get(tabId)?.versions.get(root.frameId);
      let last;
      for (let step = 0; step <= maxSteps;) {
        if (claims.get(tabId) !== claim || documents.get(tabId) !== version || frameStates.get(tabId)?.versions.get(root.frameId) !== frameVersion) throw new Error('Document/frame/control changed during scroll search; observe before continuing');
        const found = await args.budget.run(() => cdp(root.target, 'Runtime.callFunctionOn', { objectId: root.objectId,
          functionDeclaration: findScrollText.toString(), arguments: [{ value: text }, { value: selector }], objectGroup: 'browser-attach-search' }));
        value(found);
        if (found.result?.objectId) {
          const result = await rememberElement(tabId, root.target, found.result.objectId, root.frameId, args.budget);
          await args.budget.run(() => cdp(root.target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach-search' }));
          return { found: true, ...result, scroll_steps: step, application_result: 'not_checked', observe_again: true };
        }
        if (step === maxSteps) break;
        if (last?.scrolled === false) {
          // A boundary may precede lazy loading. Observe without repeating a
          // no-op scroll until content grows, a match appears, or time runs out.
          const current = value(await args.budget.run(() => cdp(root.target, 'Runtime.callFunctionOn', { objectId: root.objectId,
            functionDeclaration: scrollState.toString(), returnByValue: true })));
          if (JSON.stringify(current) === JSON.stringify(last.after)) { await args.budget.run(() => new Promise(resolve => setTimeout(resolve, 50))); continue; }
        }
        args.budget.dispatch();
        last = value(await args.budget.run(() => cdp(root.target, 'Runtime.callFunctionOn', { objectId: root.objectId,
          functionDeclaration: scrollElement.toString(), arguments: [{ value: args.delta_x ?? 0 }, { value: args.delta_y ?? null }], returnByValue: true })));
        step++;
        await args.budget.run(() => new Promise(resolve => setTimeout(resolve, 50)));
      }
      throw new Error(`Scroll search did not find ${JSON.stringify(text)} within ${maxSteps} steps; current=${JSON.stringify(last)}. Content may still load later. Scrolling may already have occurred.`);
    }
    if (command === 'scroll') {
      const mode = args.mode ?? 'dom';
      const budget = args.budget;
      const view = await budget.run(() => viewport(tabId));
      if (node && mode === 'dom') {
        budget.dispatch();
        return { ...value(await budget.run(() => cdp(node.target, 'Runtime.callFunctionOn', { objectId: node.objectId,
          functionDeclaration: scrollElement.toString(), arguments: [{ value: args.delta_x ?? 0 }, { value: args.delta_y }], returnByValue: true }))), observe_again: true };
      }
      const point = node ? (await mouse.prepare(tabId, node, { budget })).point : position(view, args.x ?? view.width / 2, args.y ?? view.height / 2);
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

  async function perform(tabId, command, args) {
    if (args.dialog_policy != null && !['ask', 'accept', 'dismiss'].includes(args.dialog_policy)) throw new Error('dialog_policy must be ask, accept or dismiss');
    const parent = dialogPolicies.get(tabId), state = { policy: args.dialog_policy ?? parent?.policy ?? 'ask', messages: [], parent };
    dialogPolicies.set(tabId, state);
    const version = documents.get(tabId), startTab = await api.tabs.get(tabId);
    const watch = ['click', 'fill', 'type', 'press_key', 'hover', 'scroll', 'select_option', 'upload_file', 'evaluate', 'navigate'].includes(command) && !(command === 'evaluate' && args.cursor != null);
    let observer, observationFrame = frameStates.get(tabId)?.mainId, observationTarget = { tabId }, observedVersion = frameStates.get(tabId)?.versions.get(observationFrame);
    const startObservation = async () => { if (!watch || observer || dialogs.has(tabId)) return; try {
      observer = await boundedRead(async () => {
        if (args.ref) observationFrame = snapshots.get(tabId)?.refs.get(args.ref)?.frameId || observationFrame;
        else if (args.frame || args.frame_id) observationFrame = await resolveFrame(cdp, value, sessions, tabId, args, deadline(Math.max(100, Math.min(200, args.budget?.remaining() ?? 200))));
        observationTarget = sessions.target(tabId, observationFrame);
        observedVersion = frameStates.get(tabId)?.versions.get(observationFrame);
        const { executionContextId } = await cdp(observationTarget, 'Page.createIsolatedWorld', { frameId: observationFrame, worldName: 'browser-attach-outcome' });
        const result = await cdp(observationTarget, 'Runtime.evaluate', { contextId: executionContextId, expression: `(${installOutcomeObserver.toString()})()`, objectGroup: 'browser-attach-outcome' });
        return result.result?.objectId;
      }, Math.min(200, args.budget?.remaining() ?? 200));
    } catch {} };
    try {
      const result = await action(tabId, command, { ...args, observe_start: startObservation });
      if (state.handling) await boundedRead(() => state.handling, 500);
      return { ...result, ...(state.messages.length ? { dialogs: state.messages } : {}) };
    } catch (error) {
      if (error.input_dispatched == null && args.budget?.has_dispatched) error.input_dispatched = args.budget.has_dispatched();
      if (state.handling) await boundedRead(() => state.handling, 500).catch(() => {});
      if (state.messages.some(d => d.type === 'beforeunload' && d.accepted === false && d.handled) && /ERR_ABORTED|cancel/i.test(error.message)) return { navigated: false, cancelled_by_dialog: true, dialogs: state.messages, observe_again: true };
      if (watch && error.input_dispatched !== false && /outcome is unknown|may already|effects may|may have been|timed out|did not reach|may still/i.test(error.message)) {
        let current, dom;
        await Promise.allSettled([
          boundedRead(async () => { current = await api.tabs.get(tabId); }),
          observer ? boundedRead(async () => { dom = value(await cdp(observationTarget, 'Runtime.callFunctionOn', { objectId: observer, functionDeclaration: 'function() { return this.read(); }', returnByValue: true })); }) : Promise.resolve(),
        ]);
        const frameChanged = frameStates.get(tabId)?.versions.get(observationFrame) !== observedVersion;
        error.post_action = { delivery: 'unknown', frame_id: observationFrame, frame_navigation_observed: frameChanged, dialog: dialogs.get(tabId) || null, dialogs: state.messages,
          navigation_observed: documents.get(tabId) !== version || !!current && current.url !== startTab.url,
          current_url: current?.url ?? null, dom_changed: dom?.dom_changed ?? null,
          assessment: dialogs.has(tabId) || state.messages.length || documents.get(tabId) !== version || frameChanged || dom?.dom_changed ? 'observable_effects' : 'no_observable_effects',
          note: 'These observations do not prove business success or that an unchanged page received no input. Do not replay automatically.' };
        error.message += ` Post-action observation: ${JSON.stringify(error.post_action)}`;
      } else if (state.messages.length) error.message += ` Dialogs: ${JSON.stringify(state.messages)}`;
      throw error;
    } finally {
      if (parent && claims.has(tabId)) dialogPolicies.set(tabId, parent); else dialogPolicies.delete(tabId);
      if (observer) await boundedRead(async () => {
        await cdp(observationTarget, 'Runtime.callFunctionOn', { objectId: observer, functionDeclaration: 'function() { this.stop(); }' });
        await cdp(observationTarget, 'Runtime.releaseObject', { objectId: observer });
      }, 100).catch(() => {});
    }
  }

  async function elementClip(tabId, args, view) {
    targetOptions(args);
    const budget = deadline(5000);
    const node = args.selector ? await resolveSelector(cdp, value, sessions, tabId, args, budget) : await getObject(tabId, args.ref, budget);
    const { model } = await budget.run(() => cdp(node.target, 'DOM.getBoxModel', { backendNodeId: node.backendNodeId }));
    if (!model?.border) throw new Error('Element has no rendered box');
    let points = Array.from({ length: 4 }, (_, i) => ({ x: model.border[i * 2], y: model.border[i * 2 + 1] })), target = node.target;
    while (target.sessionId) {
      const parent = sessions.parent(tabId, target.sessionId);
      const owner = await budget.run(() => cdp(parent.target, 'DOM.getFrameOwner', { frameId: parent.frameId }));
      const box = await budget.run(() => cdp(parent.target, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }));
      const childView = await budget.run(() => viewport(target));
      points = points.map(p => framePoint(p, box.model.content, childView));
      target = parent.target;
    }
    const x = Math.min(...points.map(p => p.x)) + view.scroll_x, y = Math.min(...points.map(p => p.y)) + view.scroll_y;
    const width = Math.max(...points.map(p => p.x)) + view.scroll_x - x, height = Math.max(...points.map(p => p.y)) + view.scroll_y - y;
    if (width <= 0 || height <= 0 || width * height > 40000000 || x < 0 || y < 0) throw new Error('Element capture requires a positive box within the document and at most 40 million pixels');
    return { x, y, width, height, scale: 1 };
  }

  async function fullPageClip(tabId) {
    const { cssContentSize } = await cdp(tabId, 'Page.getLayoutMetrics');
    if (cssContentSize.width * cssContentSize.height > 40000000) throw new Error('Full-page capture exceeds 40 million pixels; use viewport capture');
    return { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
  }

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
    if (claims.has(tabId)) forget(tabId);
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
        const claim = claims.get(tab.id);
        const checkControl = () => {
          checkConnection();
          if (claims.get(tab.id) !== claim) throw new Error('Tab control ended during fetch; capture discarded');
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
          if (waitUntil === 'network_idle') await waitFor(cdp, value, sessions, diagnostics, mouse, tab.id, { condition: 'network_idle', budget: waitBudget });
          satisfied = true;
        } catch (error) {
          checkControl();
          if (error.navigation_error === 'net::ERR_HTTP_RESPONSE_CODE_FAILURE') {
            const response = diagnostics.failedDocument(tab.id, frameStates.get(tab.id)?.mainId);
            if (response) return httpFailure(response);
            throw error;
          }
          if (error.code === 'NAVIGATION_TIMEOUT' || (waitUntil === 'network_idle' && waitBudget.remaining() === 0)) reason = 'wait_timeout';
          else if (error.navigation_error === 'net::ERR_ABORTED' && temporary.document) reason = 'navigation_interrupted';
          else throw error;
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          checkControl();
          const version = documents.get(tab.id);
          try {
            const { frameTree } = await budget.run(() => cdp(tab.id, 'Page.getFrameTree'));
            const response = frameTree.frame.unreachableUrl && diagnostics.failedDocument(tab.id, frameTree.frame.id);
            if (response && response.url === frameTree.frame.unreachableUrl) return httpFailure(response);
            httpUrl(frameTree.frame.url);
            const { executionContextId } = await budget.run(() => cdp(tab.id, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'browser-attach-fetch' }));
            const result = value(await budget.run(() => cdp(tab.id, 'Runtime.evaluate', { contextId: executionContextId, returnByValue: true, userGesture: false,
              expression: `(${capturePage.toString()})(${JSON.stringify(args.format ?? 'text')},${cap})` })));
            checkControl();
            if (documents.get(tab.id) !== version) throw Object.assign(new Error('Document changed during fetch capture'), { code: 'FETCH_DOCUMENT_CHANGED' });
            httpUrl(result.url);
            const status = diagnostics.documentStatus(tab.id, frameTree.frame);
            if (satisfied && waitedDocument !== JSON.stringify([frameTree.frame.id, frameTree.frame.loaderId])) { satisfied = false; reason = 'document_changed'; }
            return { ...result, status, ok: status == null ? null : status >= 200 && status < 300,
              ...metadata(satisfied, reason, result.ready_state) };
          } catch (error) {
            checkControl();
            const changing = documents.get(tab.id) !== version || error.code === 'FETCH_DOCUMENT_CHANGED' || /context.*(destroyed|not found)|cannot find context|no frame with given id|inspected target navigated/i.test(error.message);
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

  async function attach(tabId, owner, args, tab, budget) {
    const run = operation => budget ? budget.run(operation) : operation();
    await run(() => api.debugger.attach({ tabId }, '1.3'));
    try {
      diagnostics.start(tabId);
      await run(() => sessions.start(tabId));
      const { frameTree } = await run(() => cdp(tabId, 'Page.getFrameTree'));
      const state = { mainId: frameTree.frame.id, parents: new Map(), versions: new Map(), sessions: new Map() };
      const remember = tree => {
        if (tree.frame.parentId) state.parents.set(tree.frame.id, tree.frame.parentId);
        (tree.childFrames || []).forEach(remember);
      };
      remember(frameTree); frameStates.set(tabId, state);
      claims.set(tabId, { owner, handle: args.tab_handle });
      let visualWarning;
      try { if (!temporaryTabs.has(tabId)) await visuals.install(tabId); }
      catch (error) { visualWarning = error.message; }
      return { claimed: true, activation_requested: false, title: tab.title, url: tab.url,
        ...(visualWarning ? { visual_warning: visualWarning } : {}) };
    } catch (error) {
      diagnostics.forget(tabId);
      sessions.forget(tabId);
      if (!temporaryTabs.has(tabId)) await api.debugger.detach({ tabId });
      throw error;
    }
  }

  async function execute(owner, command, args) {
    if (command === 'fetch') return await fetches.fetch(owner, args);
    if (command === 'open_tab') {
      const url = httpUrl(args.url);
      if (args.active != null && typeof args.active !== 'boolean') throw new Error('active must be a boolean');
      const tab = await api.tabs.create({ url, active: args.active ?? false });
      return { opened: true, tab_id: tab.id, window_id: tab.windowId, active: tab.active,
        note: 'List tabs after loading, then claim tab_id with optional exact URL/title guards before controlling this tab.' };
    }
    if (command === 'list_tabs') {
      const tabs = (await api.tabs.query({})).filter(tab => !temporaryTabs.has(tab.id));
      return { tabs: tabs.map(tab => ({ tab_id: tab.id, window_id: tab.windowId, title: tab.title || '', url: tab.url || '',
        active: tab.active, group_id: tab.groupId, controllable: /^https?:\/\//.test(tab.url || '') })) };
    }
    if (command === 'release_owner') { fetches.forget(owner); return await releaseMatching(claim => claim.owner === owner); }
    const tabId = args.tab_id;
    if (!Number.isInteger(tabId)) throw new Error('Invalid tab ID');
    return await queued(tabId, async () => {
      if (command === 'claim_tab') {
        if (temporaryTabs.has(tabId)) throw new Error('Tab is already controlled by a fetch operation');
        const tab = await api.tabs.get(tabId);
        if ((args.expected_url != null && tab.url !== args.expected_url) || (args.expected_title != null && tab.title !== args.expected_title)) throw new Error('Tab title/URL changed. List tabs again or omit optional identity guards to claim by tab_id.');
        httpUrl(tab.url);
        const existing = claims.get(tabId);
        if (existing) {
          if (existing.owner === owner && existing.handle === args.tab_handle) return { claimed: true };
          throw new Error('Tab is already controlled by another session');
        }
        return await attach(tabId, owner, args, tab);
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
      const result = await perform(tabId, command, args);
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

  return { execute, releaseAll: () => { fetches.clear(); return releaseMatching(() => true); }, claimedCount: () => claims.size };
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
