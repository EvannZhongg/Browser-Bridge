// Deliberately a page expression API, not a raw CDP transport.
export async function evaluatePage(cdp, tabId, args) {
  const timeout = args.timeout_ms ?? 10000, maxChars = args.max_chars ?? 20000;
  if (typeof args.expression !== 'string' || !args.expression.trim() || args.expression.length > 100000)
    throw new Error('expression must contain 1..100000 characters of JavaScript');
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) throw new Error('timeout_ms must be 100..30000');
  if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 100000) throw new Error('max_chars must be 1000..100000');
  let timer;
  try {
    const response = await Promise.race([
      cdp(tabId, 'Runtime.evaluate', {
        expression: `(async () => { const result = await (\n${args.expression}\n); return (${serializeEvaluation.toString()})(result, ${maxChars}); })()`,
        awaitPromise: true, returnByValue: true, userGesture: false, timeout,
      }),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(
        'JavaScript evaluation timed out. It may still run or have changed the page; observe before continuing. Do not replay automatically.'
      )), timeout); }),
    ]);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    if (!response.result?.value || typeof response.result.value.truncated !== 'boolean') throw new Error('Invalid evaluation result');
    return { ...response.result.value, scope: 'main_frame', observe_again: true };
  } catch (error) {
    throw new Error(`Evaluation failed; page effects may already have occurred. ${String(error.message).slice(0, 12000)}`);
  } finally { clearTimeout(timer); }
}

// Runs in the page. Bound traversal before transferring the result across CDP.
// Preserve ordinary JSON; explicitly mark values that JSON cannot represent.
export function serializeEvaluation(value, maxChars) {
  const seen = new WeakSet();
  let nodes = 0, chars = 0, truncated = false;
  const mark = type => ({ $type: type });
  function visit(item, depth) {
    if (++nodes > 1000 || depth > 8 || chars > maxChars) { truncated = true; return mark('truncated'); }
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) && !Object.is(item, -0) ? item : { $type: 'number', value: String(Object.is(item, -0) ? '-0' : item) };
    if (typeof item === 'string') {
      const text = item.slice(0, Math.max(0, maxChars - chars));
      chars += text.length;
      if (text.length !== item.length) truncated = true;
      return text;
    }
    if (typeof item === 'bigint') return { $type: 'bigint', value: visit(String(item), depth + 1) };
    if (typeof item !== 'object') return mark(typeof item);
    if (seen.has(item)) return mark('circular_or_repeated');
    seen.add(item);
    if (item instanceof Date) return { $type: 'date', value: String(item) };
    if (item instanceof Error) return { $type: 'error', name: visit(item.name, depth + 1), message: visit(item.message, depth + 1) };
    if (Array.isArray(item)) {
      const output = [];
      // Do not copy a sparse index into an array with an unbounded length.
      for (let i = 0; i < item.length && nodes < 1000 && chars < maxChars && depth < 8; i++) {
        const property = Object.getOwnPropertyDescriptor(item, String(i));
        output.push(!property ? visit(undefined, depth + 1) : 'value' in property ? visit(property.value, depth + 1) : (nodes++, mark('accessor')));
      }
      if (output.length < item.length) truncated = true;
      return output;
    }
    const output = Object.create(null);
    for (const key in item) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
      if (nodes >= 1000 || chars + key.length > maxChars || depth >= 8) { truncated = true; break; }
      chars += key.length;
      const property = Object.getOwnPropertyDescriptor(item, key);
      const result = property && 'value' in property ? visit(property.value, depth + 1) : (nodes++, mark('accessor'));
      Object.defineProperty(output, key, { value: result, enumerable: true, configurable: true, writable: true });
    }
    return output;
  }
  const result = visit(value, 0);
  const json = JSON.stringify(result);
  // Escaped strings and property names also count toward the transfer budget.
  if (json.length > maxChars) return { serialized_preview: json.slice(0, maxChars), truncated: true };
  return { value: result, truncated };
}
