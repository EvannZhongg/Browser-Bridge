// Observation can confirm a dialog/navigation/mutation, never absence of delivery.
export async function boundedRead(operation, ms = 300) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('observation did not respond')), ms); })]); }
  finally { clearTimeout(timer); }
}
export function installOutcomeObserver() {
  let mutations = 0;
  const observer = new MutationObserver(records => { mutations += records.length; });
  observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  const startUrl = location.href;
  let expiry = setTimeout(() => observer.disconnect(), 55000);
  return { read() { mutations += observer.takeRecords().length; return { dom_changed: mutations > 0, mutation_records: mutations, start_url: startUrl, current_url: location.href }; },
    stop() { clearTimeout(expiry); observer.disconnect(); } };
}
