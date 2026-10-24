import { boundedRead } from './outcomes.js';

export function createDialogs(sendCommand, cancelNavigation, invalidate, isControlled) {
  const dialogs = new Map(), policies = new Map(), waiters = new Map();

  async function send(target, method, params = {}) {
    if (typeof target === 'number') target = { tabId: target };
    const { tabId } = target;
    if (!method.startsWith('Input.') && !['Runtime.callFunctionOn', 'Runtime.evaluate', 'Page.navigate', 'DOM.setFileInputFiles'].includes(method)) {
      return await sendCommand(target, method, params);
    }
    // A page modal can prevent the CDP response from returning. Release the
    // operation so the next request can observe and handle that same dialog.
    let rejectDialog;
    const dialog = new Promise((resolve, reject) => { rejectDialog = reject; });
    const pending = waiters.get(tabId) || new Set();
    waiters.set(tabId, pending); pending.add(rejectDialog);
    try { return await Promise.race([sendCommand(target, method, params), dialog]); }
    finally { pending.delete(rejectDialog); if (!pending.size) waiters.delete(tabId); }
  }

  function willHandle(tabId) {
    const policy = policies.get(tabId);
    return !!policy && policy.policy !== 'ask' && policy.messages.length < 10;
  }

  function event(source, method, params) {
    const tabId = source.tabId;
    if (method === 'Page.javascriptDialogClosed') { dialogs.delete(tabId); return; }
    if (method !== 'Page.javascriptDialogOpening') return;
    const policy = policies.get(tabId), automatic = willHandle(tabId);
    const opened = { sessionId: source.sessionId, type: params.type, message: params.message, default_prompt: params.defaultPrompt, default_button: null };
    dialogs.set(tabId, opened);
    invalidate(tabId, 'dialog_opened');
    const message = { ...opened, policy: policy?.policy || 'ask', accepted: automatic ? policy.policy === 'accept' : null };
    for (let item = policy; item; item = item.parent) item.messages.push(message);
    if (automatic) {
      const handling = send(source, 'Page.handleJavaScriptDialog', { accept: policy.policy === 'accept', ...(params.type === 'prompt' ? { promptText: params.defaultPrompt || '' } : {}) });
      policy.handling = handling;
      handling.then(() => {
        message.handled = true;
        if (dialogs.get(tabId) === opened) dialogs.delete(tabId);
        if (params.type === 'beforeunload' && policy.policy === 'dismiss') cancelNavigation(tabId, new Error('Navigation cancelled by dismissed beforeunload'));
      }, error => {
        message.handled = false; message.error = error.message;
        for (const reject of waiters.get(tabId) || []) reject(Object.assign(new Error(`Automatic dialog handling failed: ${error.message}. Outcome is unknown.`), { outcome_unknown: true }));
      });
    } else {
      for (const reject of waiters.get(tabId) || []) reject(Object.assign(new Error('The action opened a JavaScript dialog. It may already have executed; use browser_snapshot and browser_handle_dialog before continuing.'), { outcome_unknown: true }));
    }
  }

  async function handle(tabId, args) {
    if (typeof args.accept !== 'boolean') throw new Error('accept must be a boolean');
    const dialog = dialogs.get(tabId);
    await send({ tabId, ...(dialog?.sessionId ? { sessionId: dialog.sessionId } : {}) }, 'Page.handleJavaScriptDialog', { accept: args.accept,
      ...(args.prompt_text != null ? { promptText: String(args.prompt_text) } : {}) });
    dialogs.delete(tabId); invalidate(tabId, 'dialog_handled');
    return { handled: true, dialog: dialog ?? null, accepted: args.accept, observe_again: true };
  }

  return { send, event, handle, willHandle,
    has: tabId => dialogs.has(tabId), get: tabId => dialogs.get(tabId),
    forget(tabId) { dialogs.delete(tabId); policies.delete(tabId); },
    enter(tabId, policy) {
      if (policy != null && !['ask', 'accept', 'dismiss'].includes(policy)) throw new Error('dialog_policy must be ask, accept or dismiss');
      const parent = policies.get(tabId), state = { policy: policy ?? parent?.policy ?? 'ask', messages: [], parent };
      policies.set(tabId, state); return state;
    },
    async settle(state) { if (state.handling) await boundedRead(() => state.handling, 500); },
    exit(tabId, state) { if (state.parent && isControlled(tabId)) policies.set(tabId, state.parent); else policies.delete(tabId); },
  };
}
