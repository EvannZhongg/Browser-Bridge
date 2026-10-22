const CAPTURE_CHARS = 1000000;

export function fetchOptions(args) {
  if (!Number.isInteger(args.max_chars ?? 20000) || (args.max_chars ?? 20000) < 1 || (args.max_chars ?? 20000) > 100000) throw new Error('max_chars must be 1..100000');
  if (args.cursor != null) {
    if (typeof args.cursor !== 'string' || !args.cursor || ['url', 'format', 'wait_until', 'timeout_ms'].some(key => args[key] != null)) throw new Error('Cursor continuation accepts only browser_id, cursor and max_chars');
    return;
  }
  const url = new URL(args.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('fetch requires an HTTP(S) URL without credentials');
  if (!['text', 'html', 'json'].includes(args.format ?? 'text')) throw new Error('format must be text, html or json');
  if (!['load', 'network_idle'].includes(args.wait_until ?? 'load')) throw new Error('wait_until must be load or network_idle');
  if (!Number.isInteger(args.timeout_ms ?? 15000) || (args.timeout_ms ?? 15000) < 100 || (args.timeout_ms ?? 15000) > 30000) throw new Error('timeout_ms must be 100..30000');
}

// Executed in an isolated world. Read the rendered main document, never a second request.
export function capturePage(format, cap) {
  if (!/^https?:$/.test(location.protocol)) throw new Error('Final document is outside HTTP(S) scope');
  let body = format === 'html' ? document.documentElement.outerHTML : format === 'json'
    ? (document.querySelector('pre') || document.body)?.textContent || '' : document.body?.innerText || '';
  if (format === 'json') {
    if (body.length > cap) throw new Error('JSON document exceeds the 1000000 character capture limit');
    body = JSON.stringify(JSON.parse(body));
    if (body.length > cap) throw new Error('JSON document exceeds the 1000000 character capture limit');
  }
  return { url: location.href, title: document.title, contentType: document.contentType, format,
    body: body.slice(0, cap), capture_truncated: body.length > cap };
}

// One bounded immutable capture per owner; closing the temporary tab does not expire it.
export function createFetches(read) {
  const results = new Map();
  async function fetch(owner, args) {
    fetchOptions(args);
    let state;
    if (args.cursor != null) {
      state = results.get(owner);
      if (!state?.result || state.cursor !== args.cursor) throw new Error('Fetch cursor is stale or belongs to another connection; a new fetch replaces the previous capture');
    } else {
      state = { offset: 0 };
      results.set(owner, state);
      try {
        const result = await read(owner, args, CAPTURE_CHARS, () => {
          if (results.get(owner) !== state) throw new Error('Fetch connection ended; capture discarded');
        });
        if (results.get(owner) !== state) throw new Error('Fetch connection ended; capture discarded');
        state.result = result;
      } catch (error) { if (results.get(owner) === state) results.delete(owner); throw error; }
    }
    const { body, ...metadata } = state.result;
    const end = Math.min(body.length, state.offset + (args.max_chars ?? 20000));
    const chunk = body.slice(state.offset, end);
    state.offset = end;
    state.cursor = end < body.length ? crypto.randomUUID() : null;
    const result = { ...metadata, body: chunk, truncated: end < body.length || metadata.capture_truncated, next_cursor: state.cursor };
    if (!state.cursor) results.delete(owner);
    return result;
  }
  return { fetch, forget: owner => results.delete(owner), clear: () => results.clear() };
}
