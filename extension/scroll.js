export function scrollOptions(args) {
  if (!['dom', 'wheel'].includes(args.mode ?? 'dom')) throw new Error('Scroll mode must be dom or wheel');
  if (!Number.isFinite(args.delta_x ?? 0) || args.delta_y != null && !Number.isFinite(args.delta_y)) throw new Error('Scroll deltas must be finite');
  if (!args.until && !Number.isFinite(args.delta_y)) throw new Error('delta_y is required without until');
  if (args.until) {
    if (args.mode === 'wheel') throw new Error('until search requires explicit DOM scroll mode');
    const { text, selector } = args.until;
    if (typeof text !== 'string' || !text || text.length > 2000 || selector != null && (typeof selector !== 'string' || !selector)) throw new Error('until requires nonempty text and optional CSS selector');
    if (!Number.isInteger(args.max_steps ?? 100) || (args.max_steps ?? 100) < 1 || (args.max_steps ?? 100) > 500) throw new Error('max_steps must be 1..500');
  }
}

export function scrollElement(dx, dy) {
  if (!this.isConnected) throw new Error('Scroll container is detached');
  const before = { x: this.scrollLeft, y: this.scrollTop };
  this.scrollBy({ left: dx, top: dy ?? Math.max(1, this.clientHeight * 0.8), behavior: 'instant' });
  const after = { x: this.scrollLeft, y: this.scrollTop, width: this.scrollWidth, height: this.scrollHeight,
    client_width: this.clientWidth, client_height: this.clientHeight };
  return { scrolled: before.x !== after.x || before.y !== after.y, before, after, method: 'dom_scroll', scope: 'element' };
}

export function scrollState() {
  if (!this.isConnected) throw new Error('Scroll container is detached');
  return { x: this.scrollLeft, y: this.scrollTop, width: this.scrollWidth, height: this.scrollHeight,
    client_width: this.clientWidth, client_height: this.clientHeight };
}

export function findScrollText(text, selector) {
  if (!this.isConnected) throw new Error('Scroll container detached');
  const elements = Array.from(this.querySelectorAll(selector || '*'));
  if (elements.length > 10000) throw new Error('Scroll search exceeds 10000 candidates; scope until.selector');
  const matches = elements.filter(e => (e.textContent || '').includes(text) && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0 && e.ownerDocument.defaultView.getComputedStyle(e).visibility === 'visible');
  const leaves = matches.filter(e => !matches.some(other => other !== e && e.contains(other)));
  if (leaves.length > 1) throw new Error(`Scroll text must match one element; matched ${leaves.length}. Scope until.selector`);
  return leaves[0] || null;
}
