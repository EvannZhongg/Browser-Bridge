import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAX, snapshotOptions } from '../extension/snapshot.js';

const node = (nodeId, role, name = '', childIds = [], extra = {}) =>
  ({ nodeId, role: { value: role }, name: { value: name }, childIds, ...extra });

test('interactive view removes prose with refs but preserves control ancestors, disabled and custom controls', () => {
  const nodes = [node('root', 'RootWebArea', 'Page', ['main']), node('main', 'main', '', ['prose', 'group']),
    node('prose', 'paragraph', '', ['body'], { backendDOMNodeId: 1 }), node('body', 'StaticText', 'Read me'),
    node('group', 'group', 'Settings', ['button', 'custom', 'ignored']),
    node('button', 'button', 'Save', ['label'], { backendDOMNodeId: 2, properties: [{ name: 'disabled', value: { value: true } }] }),
    node('label', 'StaticText', 'Save'),
    node('custom', 'generic', 'Custom', [], { backendDOMNodeId: 3, properties: [{ name: 'focusable', value: { value: true } }] }),
    node('ignored', 'button', 'Hidden', [], { backendDOMNodeId: 4, ignored: true })];
  const refs = new Map(), entries = renderAX(nodes, 'view', refs, 'main', undefined, snapshotOptions({ profile: 'interactive' }));
  const text = entries.map(entry => entry.line).join('\n');
  assert.match(text, /RootWebArea "Page"\n  main ""\n    group "Settings"\n      \[view:1\] button "Save" disabled=true/);
  assert.match(text, /generic "Custom"/);
  assert.doesNotMatch(text, /Read me|paragraph|Hidden|StaticText/);
  assert.equal(refs.size, 2);
  assert.match(renderAX(nodes, 'full', new Map(), 'main').map(e => e.line).join('\n'), /paragraph "Read me"/);
});

test('text previews never shorten control identity, accessible names or values', () => {
  const name = 'Save '.repeat(30), content = 'Extra context '.repeat(30);
  const nodes = [node('root', 'RootWebArea', '', ['button']),
    node('button', 'button', name, ['label', 'extra'], { backendDOMNodeId: 2, value: { value: 'full value' } }),
    node('label', 'StaticText', name), node('extra', 'StaticText', content, [], { backendDOMNodeId: 3 })];
  const refs = new Map();
  const options = snapshotOptions({ profile: 'interactive', text_limit: 12 });
  const text = renderAX(nodes, 'view', refs, 'main', undefined, options).map(e => e.line).join('\n');
  assert.ok(text.includes(JSON.stringify(name)));
  assert.ok(text.includes(JSON.stringify(content.slice(0, 12) + '…')));
  assert.equal((text.match(/StaticText/g) || []).length, 1);
  assert.equal(refs.get('view:2').name, content);
  const hidden = renderAX(nodes, 'hidden', new Map(), 'main', undefined, { ...options, text: false }).map(e => e.line).join('\n');
  assert.doesNotMatch(hidden, /StaticText|Extra context/);
  assert.ok(hidden.includes(JSON.stringify(name))); assert.match(hidden, /value="full value"/);
  for (const args of [{ profile: 'bad' }, { text: 'false' }, { text_limit: -1 }, { text_limit: 0.5 }, { text_limit: 10001 }]) {
    assert.throws(() => snapshotOptions(args));
  }
});
