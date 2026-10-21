import { queryElement } from './locator.js';

export async function readText(cdp, value, tabId, args) {
  const max = args.max_chars ?? 20000, offset = args.offset ?? 0, mode = args.mode ?? 'visible';
  if (!Number.isInteger(max) || max < 1 || max > 100000) throw new Error('max_chars must be 1..100000');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be 0..9007199254740991');
  if (!['visible', 'text_content', 'value', 'editor'].includes(mode)) throw new Error('read_text mode must be visible, text_content, value or editor');
  if (args.selector != null && (typeof args.selector !== 'string' || !args.selector.trim() || args.selector.length > 10000)) throw new Error('selector must contain 1..10000 characters');
  if (args.selector_type != null && !['css', 'xpath'].includes(args.selector_type)) throw new Error('selector_type must be css or xpath');
  if (mode === 'value' || mode === 'editor') {
    if (!args.selector) throw new Error(`${mode} requires selector to identify exactly one field/editor`);
  }
  return value(await cdp(tabId, 'Runtime.evaluate', { returnByValue: true, ...(args.context_id != null ? { contextId: args.context_id } : {}),
    expression: `(${extractText.toString()})(${JSON.stringify({ selector: args.selector, selector_type: args.selector_type, mode, offset, max_chars: max })},${queryElement.toString()})` }));
}

export function extractText(args, query) {
  const element = args.selector ? query(args.selector, args.selector_type ?? 'css') : document.body;
  let text, source = args.mode, complete = true;
  if (args.mode === 'visible') { text = element?.innerText ?? ''; complete = false; }
  else if (args.mode === 'text_content') { text = element?.textContent ?? ''; complete = false; }
  else if (args.mode === 'value') {
    if (['INPUT', 'TEXTAREA'].includes(element.tagName)) text = element.value;
    else if (element.isContentEditable) { text = element.innerText; complete = false; }
    else throw new Error('value mode requires input, textarea or contenteditable');
  } else {
    const editors = globalThis.monaco?.editor?.getEditors?.() ?? [];
    const matches = editors.filter(editor => { const dom = editor.getDomNode(); return dom && (dom === element || element.contains(dom) || dom.contains(element)); });
    if (matches.length === 1 && matches[0].getModel()) { text = matches[0].getModel().getValue(); source = 'monaco_model'; }
    else if (element.CodeMirror?.getValue) { text = element.CodeMirror.getValue(); source = 'codemirror5_model'; }
    else throw new Error('No supported editor model found. Use a site-specific evaluate adapter; DOM text cannot guarantee virtualized editor completeness.');
  }
  const end = Math.min(text.length, args.offset + args.max_chars);
  return { title: document.title, url: location.href, text: text.slice(args.offset, end), returned_chars: Math.max(0, end - args.offset),
    total_chars: text.length, truncated: end < text.length, next_offset: end < text.length ? end : null,
    source, complete_source: complete, scope: 'main_frame' };
}
