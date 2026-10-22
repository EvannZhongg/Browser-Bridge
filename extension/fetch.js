const CAPTURE_CHARS = 1000000, MAX_CAPTURES = 4;

export function fetchOptions(args) {
  if (!Number.isInteger(args.max_chars ?? 20000) || (args.max_chars ?? 20000) < 1 || (args.max_chars ?? 20000) > 100000) throw new Error('max_chars must be 1..100000');
  if (args.cursor != null) {
    if (typeof args.cursor !== 'string' || !args.cursor || ['url', 'format', 'wait_until', 'timeout_ms'].some(key => args[key] != null)) throw new Error('Cursor continuation accepts only browser_id, cursor and max_chars');
    return;
  }
  const url = new URL(args.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('fetch requires an HTTP(S) URL without credentials');
  if (!['text', 'html', 'json'].includes(args.format ?? 'text')) throw new Error('format must be text, html or json');
  if (!['commit', 'domcontentloaded', 'load', 'network_idle'].includes(args.wait_until ?? 'load')) throw new Error('wait_until must be commit, domcontentloaded, load or network_idle');
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
  return { url: location.href, ...(document.title ? { title: document.title } : {}), contentType: document.contentType, format,
    ready_state: document.readyState, body_source: 'rendered_document',
    ...(format === 'html' ? { dom: 'rendered' } : {}),
    body: body.slice(0, cap), capture_truncated: body.length > cap };
}

// Cursors identify immutable captures, not URLs whose content may have changed.
export function createFetches(read) {
  const results = new Map();
  async function fetch(owner, args) {
    fetchOptions(args);
    let captures = results.get(owner), state;
    if (args.cursor != null) {
      state = captures && [...captures.values()].find(item => item.result && item.cursor === args.cursor);
      if (!state) throw new Error('Fetch cursor is stale, evicted or belongs to another connection');
      captures.delete(state.id); captures.set(state.id, state);
    } else {
      if (!captures) { captures = new Map(); results.set(owner, captures); }
      state = { id: crypto.randomUUID(), offset: 0, format: args.format ?? 'text' };
      captures.set(state.id, state);
      const checkConnection = () => {
        if (results.get(owner) !== captures || captures.get(state.id) !== state) throw new Error('Fetch connection ended or capture evicted; capture discarded');
      };
      try {
        const result = await read(owner, args, CAPTURE_CHARS, checkConnection);
        checkConnection();
        state.result = result;
      } catch (error) {
        captures.delete(state.id);
        if (!captures.size && results.get(owner) === captures) results.delete(owner);
        throw error;
      }
    }
    const { body, ...metadata } = state.result;
    const end = state.format === 'json' ? body.length : Math.min(body.length, state.offset + (args.max_chars ?? 20000));
    const chunk = body.slice(state.offset, end);
    state.offset = end;
    state.cursor = end < body.length ? crypto.randomUUID() : null;
    const result = { ...metadata, body: chunk, truncated: end < body.length || metadata.capture_truncated, next_cursor: state.cursor };
    if (!state.cursor) {
      captures.delete(state.id);
      if (!captures.size) results.delete(owner);
    } else {
      captures.delete(state.id); captures.set(state.id, state);
      while (captures.size > MAX_CAPTURES) captures.delete(captures.keys().next().value);
    }
    return result;
  }
  return { fetch, forget(owner) { results.get(owner)?.clear(); results.delete(owner); }, clear() {
    for (const captures of results.values()) captures.clear();
    results.clear();
  } };
}
