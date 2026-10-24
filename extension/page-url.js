export function pageUrl(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Only http(s) and file pages without URL credentials can be controlled');
  }
  return parsed.href;
}

export function httpUrl(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Only http(s) pages without URL credentials can be controlled');
  }
  return parsed.href;
}
