// Render semantic AX nodes once; page through the same observation without losing refs.
export function snapshotOptions({ profile = 'full', text = true, text_limit, query } = {}) {
  if (!['full', 'interactive'].includes(profile)) throw new Error('profile must be full or interactive');
  if (typeof text !== 'boolean') throw new Error('text must be a boolean');
  if (text_limit != null && (!Number.isInteger(text_limit) || text_limit < 0 || text_limit > 10000)) throw new Error('text_limit must be 0..10000');
  if (query != null && (typeof query !== 'string' || !query.trim() || query.length > 2000)) throw new Error('query must contain 1..2000 characters and not be blank');
  return { profile, text, text_limit: text_limit ?? (profile === 'interactive' ? 80 : null), ...(query != null ? { query } : {}) };
}

export function renderAX(nodes, token, refs, frameId, sessionId, options = snapshotOptions()) {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const visited = new Set();
  const entries = [];
  const query = options.query?.toLowerCase();
  const textRoles = new Set(['StaticText', 'InlineTextBox', 'ListMarker']);
  const controls = new Set(['button', 'checkbox', 'combobox', 'DisclosureTriangle', 'link', 'listbox', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'scrollbar', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem']);
  let kept;
  if (options.profile === 'interactive') {
    kept = new Set();
    const parents = new Map();
    for (const node of nodes) for (const child of node.childIds || []) parents.set(child, node.nodeId);
    function keepText(node) {
      if (!node || kept.has(node.nodeId)) return;
      const role = node.role?.value;
      if (!textRoles.has(role) && !node.ignored && !['none', 'generic'].includes(role)) return;
      kept.add(node.nodeId);
      for (const child of node.childIds || []) keepText(byId.get(child));
    }
    for (const node of nodes) {
      if (node.ignored || !node.backendDOMNodeId || !(controls.has(node.role?.value) ||
        node.properties?.some(prop => prop.name === 'focusable' && prop.value?.value === true ||
          prop.name === 'editable' && prop.value?.value && prop.value.value !== 'false'))) continue;
      for (const child of node.childIds || []) keepText(byId.get(child));
      let id = node.nodeId;
      while (id != null && !kept.has(id)) { kept.add(id); id = parents.get(id); }
    }
  }
  function plainText(node) {
    if (!node) return null;
    const role = node.role?.value;
    if (textRoles.has(role)) return String(node.name?.value || '');
    if (!node.ignored && !['none', 'generic'].includes(role)) return null;
    const parts = (node.childIds || []).map(id => plainText(byId.get(id)));
    return parts.includes(null) ? null : parts.join(' ');
  }
  function render(node, depth, parentName = '') {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (kept && !kept.has(node.nodeId)) return;
    const role = node.role?.value || 'node';
    if (role === 'InlineTextBox') return;
    let name = String(node.name?.value || '');
    let merged = false;
    if (['listitem', 'paragraph'].includes(role) && !name) {
      const parts = (node.childIds || []).map(id => plainText(byId.get(id)));
      if (parts.length && !parts.includes(null)) { name = parts.filter(Boolean).join(' '); merged = true; }
    }
    const states = (node.properties || []).filter(prop =>
      ['disabled', 'focused', 'expanded', 'checked', 'selected', 'required', 'invalid', 'level'].includes(prop.name)
    ).map(prop => `${prop.name}=${JSON.stringify(prop.value?.value)}`);
    if (node.value?.value != null) states.push(`value=${JSON.stringify(node.value.value)}`);
    const attributes = states.join(' ');
    const skip = node.ignored || (!options.text && textRoles.has(role)) || (['none', 'generic'].includes(role) && !name && !attributes) ||
      (role === 'StaticText' && name === parentName);
    const identityName = name;
    if (textRoles.has(role) || merged) {
      if (!options.text) name = '';
      else if (options.text_limit != null && name.length > options.text_limit) name = name.slice(0, options.text_limit) + '…';
    }
    let nextDepth = depth;
    if (!skip) {
      if (query == null || identityName.toLowerCase().includes(query) || String(node.value?.value ?? '').toLowerCase().includes(query)) {
        const ref = node.backendDOMNodeId ? `${token}:${refs.size + 1}` : null;
        if (ref) refs.set(ref, { backendNodeId: node.backendDOMNodeId, frameId, sessionId, role: node.role?.value, name: String(node.name?.value || '') });
        entries.push({ node: true, frameId, line: `${'  '.repeat(Math.min(depth, 24))}${ref ? `[${ref}] ` : ''}${role} ${JSON.stringify(name)}${attributes ? ' ' + attributes : ''}` });
      }
      nextDepth++;
    }
    if (!merged) for (const child of node.childIds || []) render(byId.get(child), nextDepth, skip ? parentName : identityName);
  }
  // AX trees normally have a single root, but ignored roots can be disconnected.
  const children = new Set(nodes.flatMap(node => node.childIds || []));
  for (const node of nodes) if (!children.has(node.nodeId)) render(node, 0);
  return entries;
}

export function snapshotPage(state, { max_nodes = 600, max_chars = 24000, cursor, verbose = false, ...view } = {}) {
  if (!Number.isInteger(max_nodes) || max_nodes < 1 || max_nodes > 3000) throw new Error('max_nodes must be 1..3000');
  if (!Number.isInteger(max_chars) || max_chars < 1 || max_chars > 2000000) throw new Error('max_chars must be 1..2000000');
  if (typeof verbose !== 'boolean') throw new Error('verbose must be a boolean');
  let offset = 0;
  if (cursor != null) {
    if (cursor !== state.nextCursor) throw new Error('Snapshot cursor is stale or unknown. Take a new browser_snapshot.');
    for (const key of ['profile', 'text', 'text_limit', 'query']) if (view[key] != null && view[key] !== state.options[key]) {
      throw new Error('Snapshot cursor uses the original profile/text/text_limit/query; take a new snapshot to change the view.');
    }
    offset = state.nextOffset;
  }
  const lines = [];
  let count = 0, chars = 0, index = offset, reason = null;
  for (; index < state.entries.length; index++) {
    const entry = state.entries[index];
    if (state.invalidFrames.has(entry.frameId)) continue;
    const size = JSON.stringify(entry.line).length + 2;
    if (entry.node && count >= max_nodes) { reason = 'node_limit'; break; }
    if (chars + size > max_chars) {
      if (!lines.length) throw new Error(`A snapshot line requires max_chars >= ${size}. Increase max_chars to continue without losing text.`);
      reason = 'text_budget'; break;
    }
    lines.push(entry.line); chars += size; count += entry.node ? 1 : 0;
  }
  const truncated = index < state.entries.length;
  state.nextOffset = index;
  state.nextCursor = truncated ? `${state.id}@${index}` : null;
  const { viewport, ...metadata } = state.metadata;
  return { ...metadata, ...state.options, ...(verbose ? { viewport, snapshot_id: state.id } : {}), snapshot: lines.join('\n'), node_count: count,
    total_node_count: state.totalNodes, truncated, truncation_reason: reason, next_cursor: state.nextCursor };
}
