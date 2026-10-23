import test from 'node:test';
import assert from 'node:assert/strict';
import { findScrollText } from '../extension/scroll.js';

function fixture(definitions) {
  const nodes = new Map(), reads = new Map();
  let comparisons = 0, queried;
  for (const { id, parent, text = 'Target', width = 10, height = 10, visibility = 'visible' } of definitions) {
    const node = { id, parent, textContent: text,
      getBoundingClientRect() { reads.set(id, (reads.get(id) || 0) + 1); return { width, height }; },
      ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility }) } },
      contains(other) {
        comparisons++;
        for (let current = other; current; current = nodes.get(current.parent)) if (current === this) return true;
        return false;
      },
    };
    nodes.set(id, node);
  }
  const elements = [...nodes.values()];
  const root = { isConnected: true, querySelectorAll(selector) {
    queried = selector;
    return { length: elements.length, [Symbol.iterator]: () => elements[Symbol.iterator]() };
  } };
  return { root, nodes, reads, comparisons: () => comparisons, queried: () => queried };
}

test('scroll text returns the deepest visible match across filtered intermediate nodes', () => {
  const f = fixture([
    { id: 'ancestor' },
    { id: 'hidden', parent: 'ancestor', visibility: 'hidden' },
    { id: 'leaf', parent: 'hidden' },
    { id: 'unrelated', text: 'Other' },
    { id: 'zero-width', width: 0 },
    { id: 'zero-height', height: 0 },
  ]);
  assert.equal(findScrollText.call(f.root, 'Target', '.row'), f.nodes.get('leaf'));
  assert.equal(f.queried(), '.row');
  assert.equal(f.comparisons(), 1);
  assert.equal(f.reads.has('unrelated'), false);
  assert.ok([...f.reads.values()].every(count => count === 1));
  assert.equal(findScrollText.call(f.root, 'Missing'), null);
  assert.equal(f.queried(), '*');
});

test('scroll text rejects all deepest sibling matches, including branches under a matching ancestor', () => {
  const f = fixture([
    { id: 'ancestor' }, { id: 'branch', parent: 'ancestor' }, { id: 'leaf-a', parent: 'branch' },
    { id: 'leaf-b', parent: 'ancestor' }, { id: 'leaf-c' },
  ]);
  assert.throws(() => findScrollText.call(f.root, 'Target'), /matched 3.*Scope until.selector/);
  assert.equal(f.comparisons(), 4);
  const empty = fixture([]);
  assert.equal(findScrollText.call(empty.root, 'Target'), null);
});

test('scroll text handles the candidate boundary with linear containment checks and preserves the limit', () => {
  const f = fixture(Array.from({ length: 10000 }, (_, id) => ({ id })));
  assert.throws(() => findScrollText.call(f.root, 'Target'), /matched 10000/);
  assert.equal(f.comparisons(), 9999);
  assert.equal(f.reads.size, 10000);
  assert.ok([...f.reads.values()].every(count => count === 1));
  const overflow = fixture(Array.from({ length: 10001 }, (_, id) => ({ id })));
  assert.throws(() => findScrollText.call(overflow.root, 'Target'), /exceeds 10000 candidates/);
  assert.equal(overflow.reads.size, 0);
  f.root.isConnected = false;
  assert.throws(() => findScrollText.call(f.root, 'Target'), /container detached/);
});
