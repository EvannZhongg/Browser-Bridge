import { deadline, inspectTarget } from './actionability.js';
import { queryElement, targetOptions, resolveSelector, resolveFrame } from './locator.js';

export function waitOptions(args) {
  if (!['attached', 'visible', 'actionable', 'text', 'url', 'network_idle'].includes(args.condition)) throw new Error('Unknown wait condition');
  const element = ['attached', 'visible', 'actionable', 'text'].includes(args.condition);
  if (element) {
    targetOptions(args);
    if (!args.selector) throw new Error('Element waits require a reusable selector');
  } else if (args.selector != null || args.ref != null || args.frame_id != null || args.frame != null || args.nth != null || args.selector_type != null) throw new Error('This wait condition does not use an element target');
  if (args.condition === 'text' && (Number(typeof args.expected === 'string') + Number(typeof args.previous === 'string') !== 1)) throw new Error('text wait requires exactly one of expected (substring) or previous (full prior text)');
  if (args.condition === 'url' && typeof args.expected !== 'string') throw new Error('url wait requires expected text (substring)');
  if (args.condition !== 'text' && args.previous != null) throw new Error('previous is only valid for text waits');
  if (args.condition === 'network_idle' && (!Number.isInteger(args.idle_ms ?? 500) || (args.idle_ms ?? 500) < 100 || (args.idle_ms ?? 500) > 10000)) throw new Error('idle_ms must be 100..10000');
}

export async function waitFor(cdp, value, sessions, diagnostics, mouse, tabId, args) {
  waitOptions(args);
  const budget = args.budget || deadline(args.timeout_ms ?? 5000, 'wait');
  let current = 'not observed', previous;
  const description = `${args.condition}${args.selector ? ` selector=${JSON.stringify(args.selector)}` : ''}${args.expected != null ? ` expected substring=${JSON.stringify(args.expected)}` : ''}${args.previous != null ? ` text different from=${JSON.stringify(args.previous).slice(0, 500)}` : ''}`;
  try {
    while (true) {
      if (args.condition === 'network_idle') {
        current = diagnostics.networkStatus(tabId);
        if (!current.tracking_overflow && current.inflight === 0 && current.idle_ms >= (args.idle_ms ?? 500)) return { satisfied: true, condition: args.condition, current };
      } else if (args.condition === 'url') {
        current = value(await budget.run(() => cdp(tabId, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true })));
        if (current.includes(args.expected)) return { satisfied: true, condition: args.condition, current };
      } else {
        try {
          const frameId = await resolveFrame(cdp, value, sessions, tabId, args, budget);
          const target = sessions.target(tabId, frameId);
          const { executionContextId } = await budget.run(() => cdp(target, 'Page.createIsolatedWorld', { frameId, worldName: 'browser-attach-locator' }));
          current = value(await budget.run(() => cdp(target, 'Runtime.evaluate', { contextId: executionContextId, returnByValue: true,
            expression: `(${inspectWait.toString()})((${queryElement.toString()}),(${inspectTarget.toString()}),${JSON.stringify(args)})` })));
          const stable = current?.ready && previous?.ready && JSON.stringify(current) === JSON.stringify(previous);
          if (current?.satisfied && (args.condition !== 'actionable' || stable)) {
            if (args.condition === 'actionable') {
              try {
                const node = await resolveSelector(cdp, value, sessions, tabId, args, budget);
                try {
                  await mouse.prepare(tabId, node, { budget, scroll: false });
                  current = { ...current, state: 'actionable' };
                } finally {
                  await budget.run(() => cdp(node.target, 'Runtime.releaseObjectGroup', { objectGroup: 'browser-attach' }));
                }
              } catch (error) {
                if (!/covers|no visible click point|detached before resolution/i.test(error.message)) throw error;
                current = { satisfied: false, reason: error.message };
              }
            }
            if (current.satisfied) return { satisfied: true, condition: args.condition, current };
          }
          previous = current;
        } catch (error) {
          if (!/context.*(destroyed|not found)|cannot find context|no frame with given id|inspected target navigated/i.test(error.message)) throw error;
          current = 'document/frame changing'; previous = null;
        }
      }
      await budget.run(() => new Promise(resolve => setTimeout(resolve, 50)));
    }
  } catch (error) {
    throw Object.assign(new Error(`Wait for ${description} failed: ${error.message}; current=${JSON.stringify(current)}`), { input_dispatched: false });
  }
}

export function inspectWait(query, inspect, args) {
  const element = query(args.selector, args.selector_type ?? 'css', args.nth, true);
  if (!element) return { satisfied: false, state: 'absent' };
  if (args.condition === 'attached') return { satisfied: true, state: 'attached' };
  if (args.condition === 'text') {
    const text = element.textContent || '';
    return { satisfied: args.previous != null ? text !== args.previous : text.includes(args.expected), text: text.slice(0, 500) };
  }
  const bounds = inspect.call(element);
  if (args.condition === 'visible') return { ...bounds,
    // Visibility is independent of disabled/inert state.
    satisfied: element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && element.ownerDocument.defaultView.getComputedStyle(element).visibility === 'visible' };
  return { ...bounds, satisfied: !!bounds.ready };
}
