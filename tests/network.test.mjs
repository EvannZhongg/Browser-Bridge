import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkTracker } from '../extension/network.js';

test('network facts work without diagnostics and retain session, redirect and overflow boundaries', () => {
  const network = createNetworkTracker(), main = { tabId: 9 }, child = { tabId: 9, sessionId: 'child' };
  network.start(9);
  const request = (source, id, url = 'https://fixture.test/') => network.event(source, 'Network.requestWillBeSent', {
    requestId: id, type: 'Document', frameId: 'main', request: { url, method: 'GET' },
  });
  request(main, 'same'); request(child, 'same');
  assert.equal(network.networkStatus(9).inflight, 2);
  const redirect = request(main, 'same', 'https://fixture.test/final');
  assert.equal(redirect.previous.hop, 0); assert.equal(redirect.request.hop, 1);
  assert.equal(network.networkStatus(9).inflight, 2);
  network.event(main, 'Network.responseReceived', { requestId: 'same', type: 'Document', frameId: 'main', loaderId: 'loader', response: { status: 201, url: 'https://fixture.test/final' } });
  network.detach(9, 'child');
  assert.equal(network.networkStatus(9).inflight, 1);
  assert.equal(network.documentStatus(9, { id: 'main', loaderId: 'loader' }), 201);
  for (let index = 0; index < 501; index++) request(main, String(index));
  assert.equal(network.networkStatus(9).tracking_overflow, true);
  for (let index = 0; index < 501; index++) network.event(main, 'Network.loadingFinished', { requestId: String(index) });
  assert.equal(network.networkStatus(9).inflight, 0);
  assert.equal(network.networkStatus(9).tracking_overflow, true);
  network.forget(9);
  assert.equal(network.documentStatus(9, { id: 'main', loaderId: 'loader' }), null);
  assert.throws(() => network.networkStatus(9), /control ended/);
});
