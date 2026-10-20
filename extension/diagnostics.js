const MAX_ENTRIES = 500, MAX_CHARS = 1024 * 1024;
const clip = (value, limit = 2000) => {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit - 13)}…[truncated]` : text;
};

function buffer() {
  const entries = [];
  let sequence = 0, chars = 0, droppedThrough = 0;
  return {
    add(entry) {
      const record = { seq: ++sequence, ...entry };
      const size = JSON.stringify(record).length;
      entries.push({ record, size }); chars += size;
      while (entries.length > MAX_ENTRIES || chars > MAX_CHARS) {
        const removed = entries.shift(); chars -= removed.size; droppedThrough = removed.record.seq;
      }
    },
    read(args, matches) {
      const after = args.after_seq ?? 0, limit = args.limit ?? 100, maxChars = args.max_chars ?? 24000;
      if (!Number.isSafeInteger(after) || after < 0 || after > sequence) throw new Error('after_seq must be a sequence from this claim (0 starts reading)');
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be 1..200');
      if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 100000) throw new Error('max_chars must be 1000..100000');
      const result = [];
      let next = Math.max(after, droppedThrough), used = 2;
      for (const { record, size } of entries) {
        if (record.seq <= after) continue;
        if (!matches(record)) { next = record.seq; continue; }
        if (result.length >= limit || (used + size + 1 > maxChars && result.length)) break;
        const output = size + used + 1 <= maxChars ? record : {
          seq: record.seq, truncated: true, serialized_preview: JSON.stringify(record).slice(0, Math.floor((maxChars - 150) / 6)),
        };
        result.push(output); used += JSON.stringify(output).length + 1; next = record.seq;
      }
      return { entries: result, next_seq: next, latest_seq: sequence, has_more: next < sequence,
        data_loss: after < droppedThrough, dropped_through_seq: droppedThrough };
    },
  };
}

function remoteText(arg) {
  if ('value' in arg) return clip(typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value));
  if (arg.unserializableValue) return clip(arg.unserializableValue);
  if (arg.preview?.properties?.length) return clip(`${arg.description || arg.type} {${arg.preview.properties.slice(0, 10)
    .map(property => `${clip(property.name, 100)}: ${clip(property.value ?? property.type, 100)}`).join(', ')}}`);
  return clip(arg.description || arg.type);
}

function location(frame = {}) {
  return { url: clip(frame.url), line: frame.lineNumber, column: frame.columnNumber };
}

export function createDiagnostics() {
  const tabs = new Map();
  function start(tabId) { tabs.set(tabId, { started: Date.now(), console: buffer(), network: buffer(), requests: new Map(), contexts: new Map() }); }
  function event(source, method, params) {
    const state = tabs.get(source.tabId);
    if (!state) return;
    const origin = { session_id: source.sessionId ?? null };
    const contextKey = JSON.stringify([source.sessionId, params.executionContextId ?? params.context?.id ?? params.exceptionDetails?.executionContextId]);
    if (method === 'Runtime.executionContextCreated') state.contexts.set(contextKey, params.context.auxData?.frameId);
    if (method === 'Runtime.executionContextDestroyed') state.contexts.delete(contextKey);
    if (method === 'Runtime.executionContextsCleared') for (const key of state.contexts.keys()) if (JSON.parse(key)[0] === (source.sessionId ?? null)) state.contexts.delete(key);
    const timestamp = params.timestamp ?? params.entry?.timestamp;
    if ((method.startsWith('Runtime.') || method.startsWith('Log.')) && timestamp != null && timestamp < state.started) return;
    if (method === 'Runtime.consoleAPICalled') {
      if (params.executionContextId === 0) return;
      const type = params.type;
      const level = ['warning', 'warn'].includes(type) ? 'warning' : ['error', 'assert'].includes(type) ? 'error'
        : ['debug', 'trace'].includes(type) ? 'debug' : type === 'info' ? 'info' : 'log';
      state.console.add({ ...origin, frame_id: state.contexts.get(contextKey), timestamp, source: 'console', type, level,
        text: clip((params.args || []).slice(0, 20).map(remoteText).join(' '), 8000),
        location: location(params.stackTrace?.callFrames?.[0]), execution_context_id: params.executionContextId });
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails || {};
      state.console.add({ ...origin, frame_id: state.contexts.get(contextKey), timestamp, source: 'exception', type: 'exception', level: 'error',
        text: clip(details.exception?.description || details.text, 8000), location: location(details),
        stack: (details.stackTrace?.callFrames || []).slice(0, 8).map(frame => ({ function: clip(frame.functionName, 200), ...location(frame) })) });
    } else if (method === 'Log.entryAdded') {
      const entry = params.entry;
      state.console.add({ ...origin, frame_id: state.contexts.get(contextKey), timestamp, source: clip(entry.source, 100), type: 'browser', level: clip(entry.level, 100),
        text: clip(entry.text, 8000), location: location(entry) });
    } else if (method.startsWith('Network.')) {
      const id = params.requestId;
      if (!id) return;
      const key = JSON.stringify([source.sessionId, id]);
      let request = state.requests.get(key);
      const add = (event, extra = {}) => state.network.add({ ...origin, event, request_id: id, timestamp, ...request, ...extra });
      if (method === 'Network.requestWillBeSent') {
        if (params.redirectResponse) add('redirect', { status: params.redirectResponse.status,
          url: clip(params.redirectResponse.url), redirect_to: clip(params.request.url) });
        request = { url: clip(params.request.url), method: clip(params.request.method, 50), resource_type: clip(params.type, 50),
          frame_id: params.frameId, hop: request ? request.hop + 1 : 0 };
        state.requests.delete(key); state.requests.set(key, request);
        if (state.requests.size > MAX_ENTRIES) state.requests.delete(state.requests.keys().next().value);
        add('request', { wall_time: params.wallTime });
      } else if (method === 'Network.responseReceived') {
        const response = params.response;
        add('response', { url: clip(response.url), status: response.status, status_text: clip(response.statusText, 200),
          mime_type: clip(response.mimeType, 200), protocol: clip(response.protocol, 50),
          from_cache: !!(response.fromDiskCache || response.fromPrefetchCache), from_service_worker: !!response.fromServiceWorker });
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        const failed = method === 'Network.loadingFailed';
        add(failed ? 'failed' : 'finished', failed ? { error: clip(params.errorText), canceled: !!params.canceled,
          blocked_reason: clip(params.blockedReason) } : { encoded_data_length: params.encodedDataLength });
        state.requests.delete(key);
      } else if (method === 'Network.requestServedFromCache') add('cache');
    }
  }
  function read(tabId, kind, args) {
    const state = tabs.get(tabId);
    if (!state) throw new Error('Diagnostics are unavailable; claim the tab again');
    if (args.level != null && !['log', 'debug', 'info', 'warning', 'error'].includes(args.level)) throw new Error('Invalid console level');
    if (args.url_contains != null && (typeof args.url_contains !== 'string' || args.url_contains.length > 2000)) throw new Error('url_contains must be at most 2000 characters');
    return { ...state[kind].read(args, record => kind === 'console' ? !args.level || record.level === args.level
      : !args.url_contains || record.url?.includes(args.url_contains)),
      capture_started_at: state.started, scope: 'tab_and_iframes', retained_across_navigation: true };
  }
  return { start, event, read, detach(tabId, sessionId) {
    const state = tabs.get(tabId);
    if (!state) return;
    for (const map of [state.contexts, state.requests]) for (const key of map.keys()) if (JSON.parse(key)[0] === sessionId) map.delete(key);
  }, forget: tabId => tabs.delete(tabId) };
}
