import test from 'node:test';
import assert from 'node:assert/strict';
import { AssinafyClient } from '../dist/index.js';
import { mock, ok, credentials, workspaceStep, hasCode } from './helpers.mjs';

const path = '/accounts/workspace1/envelopes';
const body = { name: 'Example envelope', message: null, max_total_credits: 0,
  signers: [{ id: 'signer1', verification_method: 'Email', notification_methods: ['Email'], embedded: true }],
  documents: [{ id: 'document1', method: 'virtual', signer_ids: ['signer1'], expires_at: null, copy_receiver_ids: [] }] };
const envelope = { resource: 'envelope', id: 'envelope1', name: body.name, message: null,
  documents: [{ id: 'document1', position: 1, name: 'example.pdf', status: 'pending_signature', artifacts: {}, signers: [] }],
  counts: { pending_signature: 1 }, signing_urls: [{ signer_id: 'signer1', url: null, embedded: true }], created_at: '2026-11-24T12:00:00Z' };

test('envelope creation preserves every field and explicit replay reuses its key without automatic retries', async () => {
  const m = mock([workspaceStep(), ...[body, { ...body, name: 'Ignored on replay' }].map(expected => ({ response: ok(envelope), check(url, init) {
    assert.equal(url.pathname, '/v1' + path); assert.equal(init.method, 'POST');
    assert.equal(init.headers['Idempotency-Key'], 'saved-envelope-key'); assert.deepEqual(JSON.parse(init.body), expected);
  } }))]);
  const c = new AssinafyClient(credentials, m.runtime);
  for (const input of [body, { ...body, name: 'Ignored on replay' }]) assert.deepEqual(await c.post(await c.accountPath('/envelopes'), input, 'saved-envelope-key'), envelope);
  m.done();
  for (const response of [new Response('private', { status: 500 }), ok({}), new Response('invalid')]) {
    const failed = mock([{ response }]);
    await assert.rejects(new AssinafyClient(credentials, failed.runtime).post(path, body, 'saved-envelope-key'), error => error.outcomeUnknown && !error.safeToRetry);
    failed.done();
  }
});

test('envelope keys never reach estimates, document additions, updates or unrelated resources', async () => {
  const m = mock([]); const c = new AssinafyClient(credentials, m.runtime);
  for (const [method, target] of [['GET', path], ['PATCH', path + '/envelope1'], ['POST', path + '/estimate-cost'],
    ['POST', path + '/envelope1/documents'], ['POST', '/accounts/workspace1/signers']]) {
    await assert.rejects(c.envelope(method, target, { json: body, idempotencyKey: 'key' }), hasCode('INVALID_INPUT'));
  }
  m.done();
});

test('envelope management preserves lists, partial updates, activities, reminders, cancellation and deletion responses', async () => {
  const operations = [
    ['POST', path + '/estimate-cost', body, { documents: 1, total_credits: 0, has_sufficient_resources: true }],
    ['GET', path, undefined, [envelope]], ['GET', path + '/envelope1', undefined, envelope],
    ['PATCH', path + '/envelope1', { message: null, document_ids: ['document1'], name: 'Updated' }, { ...envelope, name: 'Updated' }],
    ['POST', path + '/envelope1/documents', { id: 'document2', signer_ids: ['signer1'], max_total_credits: 0 }, envelope],
    ['GET', path + '/envelope1/activities', undefined, [{ id: 123, document_id: 'document1', document_name: 'example.pdf' }]],
    ['PUT', path + '/envelope1/signers/signer1/resend', undefined, { is_sent: false, envelope_id: 'envelope1', signer_id: 'signer1' }],
    ['DELETE', path + '/envelope1/documents/document2', undefined, envelope],
    ['PUT', path + '/envelope1/cancel', undefined, [{ id: 'document1', status: 'rejected_by_user', cancelled: true }]],
    ['DELETE', path + '/envelope1', undefined, []],
  ];
  const m = mock(operations.map(([method, target, json, data]) => ({ response: ok(data), check(url, init) {
    assert.equal(url.pathname, '/v1' + target); assert.equal(init.method, method);
    assert.deepEqual(init.body === undefined ? undefined : JSON.parse(init.body), json);
    assert.equal(init.headers['Idempotency-Key'], undefined); assert.equal(init.headers.Authorization, 'Bearer test-token');
  } })));
  const c = new AssinafyClient({ type: 'oauth2', accessToken: 'test-token', accountId: 'workspace1' }, m.runtime);
  for (const [method, target, json, data] of operations) {
    const actual = method === 'GET' && Array.isArray(data) ? await c.list(target) : (await c.envelope(method, target, json === undefined ? {} : { json })).data;
    assert.deepEqual(actual, data);
  }
  m.done();
});

test('envelope downloads keep ZIP bytes and respect size limits', async () => {
  const bytes = new Uint8Array([80, 75, 3, 4]);
  const m = mock([{ response: new Response(bytes, { headers: { 'Content-Type': 'application/zip' } }) }]);
  assert.deepEqual(await new AssinafyClient(credentials, m.runtime).binary(path + '/envelope1/download/original'), bytes); m.done();
  const large = mock([{ response: new Response(bytes) }]);
  await assert.rejects(new AssinafyClient(credentials, { ...large.runtime, maxDownloadBytes: 3 }).binary(path + '/envelope1/download/bundle'), hasCode('RESPONSE_TOO_LARGE')); large.done();
});

test('envelope conflicts and plan errors remain explicit without replay or private response data', async () => {
  for (const status of [400, 403, 404, 409, 429]) {
    const m = mock([{ response: new Response('private recipient data', { status }) }]);
    await assert.rejects(new AssinafyClient(credentials, m.runtime).post(path, body, 'key'), error =>
      error.httpStatus === status && !error.safeToRetry && !error.message.includes('private recipient'));
    m.done();
  }
});
