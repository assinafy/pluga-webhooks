import test from 'node:test';
import assert from 'node:assert/strict';
import event from '../examples/document-ready.json' with { type: 'json' };
import { AssinafyClient, getSubscription, registerSubscription, normalizeEvent, runAction } from '../dist/index.js';
import { mock, ok, credentials, workspaceStep, hasCode } from './helpers.mjs';
const subscription = { url: 'https://receiver.example.com/private-hook', email: 'ops@example.com',
  events: ['document_ready', 'signer_signed_document'], is_active: true };
const client = m => new AssinafyClient(credentials, m.runtime);

test('register checks the workspace, existing subscription and live event catalog before PUT', async () => {
  const m = mock([workspaceStep(), { response: ok(null) },
    { response: ok(subscription.events.map(id => ({ id }))), check(url) { assert.equal(url.pathname, '/v1/webhooks/event-types'); } },
    { response: ok(subscription), check(url, init) {
      assert.equal(url.pathname, '/v1/accounts/workspace1/webhooks/subscriptions'); assert.equal(init.method, 'PUT');
      assert.equal(init.headers['X-Api-Key'], 'test-secret'); assert.deepEqual(JSON.parse(init.body), subscription);
    } }]);
  assert.deepEqual(await registerSubscription(client(m), subscription), subscription); m.done();
});
test('same setup is idempotent locally without writing or requesting event types', async () => {
  const m = mock([workspaceStep(), { response: ok(subscription) }]);
  await registerSubscription(client(m), { ...subscription, events: [...subscription.events].reverse() }); m.done();
});
for (const change of [{ url: 'https://existing.example.com/hook' }, { events: ['signer_created'] }, { is_active: false }, { email: 'other@example.com' }]) {
  test(`existing subscription change ${Object.keys(change)[0]} is refused`, async () => {
    const m = mock([workspaceStep(), { response: ok({ ...subscription, ...change }) }]);
    await assert.rejects(registerSubscription(client(m), subscription), hasCode('EXISTING_SUBSCRIPTION')); m.done();
  });
}
test('subscription lookup never interprets 403 or malformed response as no subscription', async () => {
  for (const response of [new Response('{}', { status: 403 }), ok({}), ok({ ...subscription, events: 'wrong' })]) {
    const m = mock([workspaceStep(), { response }]);
    await assert.rejects(registerSubscription(client(m), subscription)); m.done();
  }
});
test('bad registration inputs and unknown events do not write', async () => {
  const empty = mock([]);
  for (const change of [{ url: 'http://receiver.example.com' }, { url: 'https://user:pass@receiver.example.com' },
    { url: 'https://127.0.0.1' }, { url: 'https://localhost' }, { url: 'https://receiver.example.com/#secret' },
    { email: '' }, { events: [] }, { events: ['document_ready', 'document_ready'] }, { is_active: 'true' }, { unsupported: true }]) {
    await assert.rejects(registerSubscription(client(empty), { ...subscription, ...change }));
  }
  empty.done();
  const unknown = mock([workspaceStep(), { response: ok(null) }, { response: ok([{ id: 'different_event' }]) }]);
  await assert.rejects(registerSubscription(client(unknown), subscription), hasCode('UNKNOWN_EVENT')); unknown.done();
});
test('subscription writes never retry on transport failure', async () => {
  const m = mock([workspaceStep(), { response: ok(null) }, { response: ok(subscription.events.map(id => ({ id }))) }, { error: new Error('secret') }]);
  await assert.rejects(registerSubscription(client(m), subscription), hasCode('MUTATION_OUTCOME_UNKNOWN')); m.done();
});
test('a misleading successful save is detected', async () => {
  const m = mock([workspaceStep(), { response: ok(null) }, { response: ok(subscription.events.map(id => ({ id }))) },
    { response: ok({ ...subscription, events: [] }) }]);
  await assert.rejects(registerSubscription(client(m), subscription), hasCode('INVALID_RESPONSE')); m.done();
});
test('webhook model yields stable deduplication key and document ID, without private payload fields', () => {
  const actual = normalizeEvent({ ...event, future_field: true, payload: { signer_email: 'private@example.com' } }, 'workspace_example');
  assert.equal(actual.deduplication_key, 'workspace_example:10001'); assert.equal(actual.document_id, 'document_example');
  assert.equal(actual.status, 'ready'); assert.equal(JSON.stringify(actual).includes('private'), false);
  assert.deepEqual(normalizeEvent(event, 'workspace_example'), actual);
});
test('webhook rejects wrong workspace, malformed timestamps and missing document identifiers', () => {
  for (const change of [{ account_id: 'wrong' }, { id: null }, { id: '10001' }, { created_at: '2026-10-03' },
    { created_at: -1 }, { object: { id: 'd1', account_id: 'wrong' } }, { object: null }, { object: { id: 'https://evil.example' } }]) {
    assert.throws(() => normalizeEvent({ ...event, ...change }, 'workspace_example'));
  }
});
test('signer/template events and new event types do not invent a document ID', () => {
  for (const name of ['signer_created', 'template_created', 'future_event']) {
    assert.equal(normalizeEvent({ ...event, event: name, object: { id: 'resource1' } }, 'workspace_example').document_id, undefined);
  }
});
test('local inbound acceptance: webhook triggers an authenticated document read before using status', async () => {
  const incoming = { ...event, account_id: 'workspace1', object: { ...event.object, id: 'document1', account_id: 'workspace1' } };
  const normalized = normalizeEvent(incoming, 'workspace1');
  const m = mock([workspaceStep(), { response: ok({ id: 'document1', account_id: 'workspace1', status: 'certificated' }), check(url, init) {
    assert.equal(url.pathname, '/v1/documents/document1'); assert.equal(init.headers['X-Api-Key'], 'test-secret');
  } }]);
  assert.equal((await runAction('get_document', client(m), { document_id: normalized.document_id })).status, 'certificated'); m.done();
});
test('read-only subscription check needs no PUT', async () => {
  const m = mock([workspaceStep(), { response: ok(subscription), check(_, init) { assert.equal(init.method, 'GET'); } }]);
  assert.deepEqual(await getSubscription(client(m)), subscription); m.done();
});
