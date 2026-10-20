import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { extractText } from '../extension/text.js';
import { queryElement } from '../extension/locator.js';

test('strict CSS and XPath reject zero, multiple and non-element matches', () => {
  const element = { nodeType: 1 };
  const context = vm.createContext({ document: { querySelectorAll: s => s === '#one' ? [element] : s === 'button' ? [element, element] : [],
    evaluate: () => ({ snapshotLength: 1, snapshotItem: () => element }) }, XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7 } });
  const query = vm.runInContext(`(${queryElement.toString()})`, context);
  assert.equal(query('#one'), element); assert.equal(query('//button', 'xpath'), element);
  assert.throws(() => query('button'), /matched 2/); assert.throws(() => query('#missing'), /matched 0/);
});

test('text modes page textarea values and distinguish virtual DOM text from full editor model', () => {
  const textarea = { tagName: 'TEXTAREA', value: 'all\nlines\nhere' };
  const editor = { innerText: 'visible line', contains: () => false };
  const context = vm.createContext({ document: { title: 'Demo', body: editor }, location: { href: 'http://fixture/' },
    monaco: { editor: { getEditors: () => [{ getDomNode: () => editor, getModel: () => ({ getValue: () => 'full model\nmore lines' }) }] } } });
  const read = vm.runInContext(`(${extractText.toString()})`, context);
  const args = { mode: 'value', selector: '#text', offset: 4, max_chars: 5 };
  const result = read(args, () => textarea);
  assert.equal(result.text, 'lines'); assert.equal(result.next_offset, 9); assert.equal(result.complete_source, true);
  const full = read({ ...args, mode: 'editor', offset: 0, max_chars: 100 }, () => editor);
  assert.equal(full.text, 'full model\nmore lines'); assert.equal(full.source, 'monaco_model'); assert.equal(full.complete_source, true);
  assert.equal(read({ ...args, mode: 'visible' }, () => editor).complete_source, false);
  assert.throws(() => read({ ...args, mode: 'editor' }, () => ({ contains: () => false })), /No supported editor model/);
  context.monaco = undefined;
  const cm = read({ ...args, mode: 'editor', offset: 0, max_chars: 100 }, () => ({ CodeMirror: { getValue: () => 'all CM lines' } }));
  assert.equal(cm.text, 'all CM lines'); assert.equal(cm.source, 'codemirror5_model'); assert.equal(cm.complete_source, true);
});
