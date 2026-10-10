import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AssinafyClient, runAction, loadOptions, verifyWebhookSignature, normalizeEvent,
  listWebhookEndpoints, registerWebhookEndpoint, updateWebhookEndpoint, deleteWebhookEndpoint, getWebhookSecret } from '../dist/index.js';
import { mock, ok, credentials, workspaceStep, signer, template, readyDocument, NOW, hasCode } from './helpers.mjs';
import event from '../examples/document-ready.json' with { type: 'json' };
import { validate } from '../dist/validation.js';
const client = m => new AssinafyClient(credentials, m.runtime);
const endpoint = { id: 'endpoint1', name: null, url: 'https://receiver.example.com/hook', email: 'ops@example.com', events: ['document_ready'],
  is_active: true, signing_enabled: true, created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z' };
const input = { url: endpoint.url, email: endpoint.email, events: endpoint.events, signing_enabled: true };
const catalog = () => ({ response: ok([{ id: 'document_ready' }]) });

test('schema validation allows empty required text and nullable values while rejecting inherited fields and invalid enums', () => {
  const schema = { type: 'object', required: ['value'], properties: { value: { type: 'string' } } };
  validate({ value: '' }, schema, {});
  assert.throws(() => validate(Object.create({ value: 'inherited' }), schema, {}), hasCode('INVALID_INPUT'));
  validate(null, { type: ['string', 'null'] }, {});
  validate('text', { type: ['string', 'null'] }, {});
  assert.throws(() => validate(null, { type: ['string', 'null'], enum: ['text'] }, {}), hasCode('INVALID_INPUT'));
});

test('a signer can be created without contact data, as allowed by the live API', async () => {
  const body = { full_name: 'Example signer' };
  const m = mock([workspaceStep(), { response: ok({ id: 'signer1', ...body }), check(_, init) { assert.deepEqual(JSON.parse(init.body), body); } }]);
  await runAction('create_signer', client(m), { body }); m.done();
});
test('invalid calendar dates are rejected before assignment reads', async () => {
  const m = mock([]);
  await assert.rejects(runAction('request_signatures', client(m), { document_id: 'document1', body: { method: 'virtual', signers: [{ id: 'signer1' }], expires_at: '2027-02-31T12:00:00Z' } }), hasCode('INVALID_INPUT')); m.done();
});

test('sandbox API keys use the sandbox host only', async () => {
  const m = mock([{ response: ok([{ id: 'workspace1' }]), check(url, init) { assert.equal(url.origin, 'https://sandbox.assinafy.com.br'); assert.equal(init.headers['X-Api-Key'], 'test-secret'); } }]);
  await new AssinafyClient({ ...credentials, environment: 'sandbox' }, m.runtime).workspace(); m.done();
});
test('webhook delivery history preserves numeric IDs and rejects contradictory zero-page metadata', async () => {
  const m = mock([{ response: ok([{ id: 10001, delivered: true }]) }]);
  assert.deepEqual(await client(m).list('/accounts/workspace1/webhooks'), [{ id: 10001, delivered: true }]); m.done();
  const invalid = mock([{ response: ok([{ id: 'document1' }], { 'X-Pagination-Page-Count': '0' }) }]);
  await assert.rejects(client(invalid).list('/documents'), hasCode('PAGINATION_INCONSISTENT')); invalid.done();
});
test('collect mode rejects processing documents before any field or contact reads', async () => {
  for (const status of ['uploaded', 'metadata_processing']) {
    const m = mock([workspaceStep(), { response: ok({ ...readyDocument, status }) }]);
    await assert.rejects(runAction('request_signatures', client(m), { document_id: 'document1', body: { method: 'collect', signers: [{ id: 'signer1' }], entries: [] } }), hasCode('DOCUMENT_NOT_READY')); m.done();
  }
});
test('OpenAPI 3.1 exclusive bounds reject zero and negative geometry before HTTP', async () => {
  for (const key of ['width', 'height', 'fontSize']) for (const value of [0, -1]) {
    const m = mock([]);
    await assert.rejects(runAction('request_signatures', client(m), { document_id: 'document1', body: {
      method: 'collect', signers: [{ id: 'signer1' }], entries: [{ page_id: 'p1', fields: [{ signer_id: 'signer1', field_id: 'f1', display_settings: { left: 0, top: 0, width: 1, height: 1, fontSize: 1, [key]: value } }] }],
    } }), hasCode('INVALID_INPUT')); m.done();
  }
});
test('channel contacts and CPF/CNPJ are checked before digital or WhatsApp invitations', async () => {
  for (const [verification, contact, code] of [['Whatsapp', signer, 'INVALID_CONTACT'], ['DigitalCertificate', signer, 'INVALID_GOVERNMENT_ID']]) {
    const m = mock([workspaceStep(), { response: ok(readyDocument) }, { response: ok([contact]) }]);
    await assert.rejects(runAction('request_signatures', client(m), { document_id: 'document1', body: { method: 'virtual', signers: [{ id: 'signer1', verification_method: verification }] } }), hasCode(code)); m.done();
  }
});
for (const [verification, contact] of [['Whatsapp', { ...signer, email: null, whatsapp_phone_number: '+5548999990000' }],
  ['DigitalCertificate', { ...signer, government_id: '39053344705' }], ['DigitalCertificate', { ...signer, government_id: '12ABC34501DE35' }]]) {
  test(`${verification} preserves the request and supported contact data`, async () => {
    const body = { method: 'virtual', signers: [{ id: 'signer1', verification_method: verification }] };
    const m = mock([workspaceStep(), { response: ok(readyDocument) }, { response: ok([contact]) }, { response: ok({ id: 'assignment1' }), check(_, init) { assert.deepEqual(JSON.parse(init.body), body); } }]);
    await runAction('request_signatures', client(m), { document_id: 'document1', body }); m.done();
  });
}
test('every options list returns actual IDs and document page numbers', async () => {
  for (const kind of ['documents', 'signers', 'templates', 'fields']) {
    const m = mock([workspaceStep(), { response: ok([{ id: 'item1', name: 'Name' }]), check(url) { assert.equal(url.pathname, `/v1/accounts/workspace1/${kind}`); if (kind === 'fields') assert.equal(url.searchParams.get('include_standard'), '1'); } }]);
    assert.deepEqual(await loadOptions(kind, client(m)), [{ value: 'item1', label: 'Name' }]); m.done();
  }
  const m = mock([workspaceStep(), { response: ok({ ...readyDocument, pages: [{ id: 'page2', number: 2 }] }) }]);
  assert.deepEqual(await loadOptions('document_pages', client(m), 'document1'), [{ value: 'page2', label: 'Page 2' }]); m.done();
});
test('template readiness, unknown actions/lists and null request bodies fail safely', async () => {
  const m = mock([workspaceStep(), { response: ok([{ ...template, status: 'processing' }]) }]);
  await assert.rejects(runAction('create_document_from_template', client(m), { template_id: 'template1', body: { signers: [{ id: 'signer1', role_id: 'customer' }] } }), hasCode('TEMPLATE_NOT_READY')); m.done();
  const empty = mock([]);
  await assert.rejects(runAction('unknown', client(empty)), hasCode('UNKNOWN_ACTION'));
  await assert.rejects(loadOptions('unknown', client(empty)), hasCode('UNKNOWN_LIST'));
  await assert.rejects(runAction('get_document', client(empty), { document_id: 'document1', body: null }), hasCode('INVALID_INPUT')); empty.done();
});
test('multiple webhook endpoints preserve unrelated destinations and create through POST', async () => {
  const m = mock([catalog(), workspaceStep(), { response: ok([{ ...endpoint, id: 'other', url: 'https://other.example.com/hook' }]) },
    { response: ok(endpoint), check(url, init) { assert.equal(url.pathname, '/v1/accounts/workspace1/webhooks/endpoints'); assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), input); } }]);
  assert.deepEqual(await registerWebhookEndpoint(client(m), input), endpoint); m.done();
});
test('matching endpoint is reused; changing an existing URL requires explicit update', async () => {
  const m = mock([catalog(), workspaceStep(), { response: ok([endpoint]) }]);
  assert.deepEqual(await registerWebhookEndpoint(client(m), input), endpoint); m.done();
  const changed = mock([catalog(), workspaceStep(), { response: ok([{ ...endpoint, signing_enabled: false }]) }]);
  await assert.rejects(registerWebhookEndpoint(client(changed), input), hasCode('EXISTING_SUBSCRIPTION')); changed.done();
});
test('endpoint list rejects malformed entries and registration preserves the plan-limit 403', async () => {
  const malformed = mock([workspaceStep(), { response: ok([{}]) }]);
  await assert.rejects(listWebhookEndpoints(client(malformed)), hasCode('INVALID_RESPONSE')); malformed.done();
  const limit = mock([catalog(), workspaceStep(), { response: ok([]) }, { response: new Response(null, { status: 403 }) }]);
  await assert.rejects(registerWebhookEndpoint(client(limit), input), e => e.httpStatus === 403 && !e.safeToRetry); limit.done();
});
test('endpoint partial update, secret read/rotation and deletion use their exact paths and methods', async () => {
  const secret = 'whsec_' + Buffer.from('test-key').toString('base64');
  const m = mock([workspaceStep(), { response: ok({ ...endpoint, is_active: false }), check(url, init) { assert.equal(url.pathname, '/v1/accounts/workspace1/webhooks/endpoints/endpoint1'); assert.equal(init.method, 'PUT'); assert.deepEqual(JSON.parse(init.body), { is_active: false }); } },
    { response: ok({ secret }), check(url, init) { assert.equal(url.pathname.endsWith('/endpoint1/secret'), true); assert.equal(init.method, 'GET'); } },
    { response: ok({ secret }), check(url, init) { assert.equal(url.pathname.endsWith('/endpoint1/secret/rotate'), true); assert.equal(init.method, 'POST'); } },
    { response: ok([]), check(_, init) { assert.equal(init.method, 'DELETE'); } }]);
  const c = client(m);
  await updateWebhookEndpoint(c, 'endpoint1', { is_active: false });
  assert.equal(await getWebhookSecret(c, 'endpoint1'), secret); assert.equal(await getWebhookSecret(c, 'endpoint1', true), secret);
  await deleteWebhookEndpoint(c, 'endpoint1'); m.done();
});
test('webhook signature uses exact raw UTF-8 bytes, multiple v1 entries and a five-minute window', async () => {
  const raw = JSON.stringify({ ...event, message: 'Assinatura ✓' });
  const key = Buffer.from('independent-test-key'); const timestamp = String(Math.floor(NOW / 1000)); const messageId = 'msg-test1.attempt';
  const digest = createHmac('sha256', key).update(`${messageId}.${timestamp}.${raw}`).digest('base64');
  const secret = `whsec_${key.toString('base64')}`;
  const headers = new Headers({ 'webhook-id': messageId, 'webhook-timestamp': timestamp, 'webhook-signature': `v2,ignored v1,invalid v1,${digest}` });
  await verifyWebhookSignature(raw, headers, secret, NOW);
  await verifyWebhookSignature(raw, headers, secret, NOW + 300000);
  for (const [body, date, signingSecret] of [[raw + ' ', NOW, secret], [raw, NOW + 300001, secret], [raw, NOW - 300001, secret], [raw, NOW, `whsec_${Buffer.from('wrong-key').toString('base64')}`]]) {
    await assert.rejects(verifyWebhookSignature(body, headers, signingSecret, date), hasCode('INVALID_WEBHOOK_SIGNATURE'));
  }
  await assert.rejects(verifyWebhookSignature(raw, new Headers(), secret, NOW), hasCode('INVALID_WEBHOOK_SIGNATURE'));
  assert.equal(normalizeEvent(event, event.account_id, messageId).deduplication_key, `${event.account_id}:${messageId}`);
  assert.throws(() => normalizeEvent({ ...event, object: { ...event.object, type: 'Signer' } }, event.account_id), hasCode('INVALID_EVENT'));
});
test('invalid file redirects and JSON downloads produce redacted integration errors', async () => {
  const bad = mock([{ response: new Response(null, { status: 302, headers: { Location: 'https://[bad-private-token' } }) }]);
  await assert.rejects(client(bad).binary('/documents/document1/download/original'), e => e.code === 'REDIRECT_BLOCKED' && !e.message.includes('private-token')); bad.done();
  const json = mock([{ response: ok({ secret: 'private-token' }) }]);
  await assert.rejects(client(json).binary('/documents/document1/download/original'), hasCode('INVALID_FILE_RESPONSE')); json.done();
});
test('success status mismatches, stream errors and changing trusted origins do not leak secrets', async () => {
  const mismatch = mock([{ response: new Response(JSON.stringify({ status: 500, data: [] })) }]);
  await assert.rejects(client(mismatch).get('/accounts'), hasCode('INVALID_RESPONSE')); mismatch.done();
  const stream = mock([{ response: new Response(new ReadableStream({ start(controller) { controller.error(new Error('private-token')); } })) }]);
  await assert.rejects(client(stream).binary('/documents/document1/download/original'), e => e.code === 'TRANSPORT_ERROR' && !e.message.includes('private-token')); stream.done();
  const origins = [];
  const m = mock([{ response: new Response(null, { status: 302, headers: { Location: 'https://storage.example.com/file' } }) }]);
  const c = new AssinafyClient(credentials, { ...m.runtime, trustedDownloadOrigins: origins }); origins.push('https://storage.example.com');
  await assert.rejects(c.binary('/documents/document1/download/original'), hasCode('REDIRECT_BLOCKED')); m.done();
});
test('failing response cleanup preserves redacted redirect and size errors', async () => {
  const body = () => new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2)); },
    cancel() { throw new Error('private-token'); },
  });
  for (const method of ['GET', 'POST']) {
    const m = mock([{ response: new Response(body(), { status: 302, headers: { Location: 'https://example.com' } }) }]);
    await assert.rejects(client(m).envelope(method, '/accounts'), error =>
      error.code === (method === 'GET' ? 'REDIRECT_BLOCKED' : 'MUTATION_OUTCOME_UNKNOWN') && !error.message.includes('private-token'));
    m.done();
  }
  const redirect = mock([{ response: new Response(body(), { status: 302, headers: { Location: 'https://example.com/file' } }) }]);
  await assert.rejects(client(redirect).binary('/documents/document1/download/original'), hasCode('REDIRECT_BLOCKED')); redirect.done();
  for (const headers of [{}, { 'content-length': '2' }]) {
    const m = mock([{ response: new Response(body(), { headers }) }]);
    const c = new AssinafyClient(credentials, { ...m.runtime, maxDownloadBytes: 1 });
    await assert.rejects(c.binary('/documents/document1/download/original'), hasCode('RESPONSE_TOO_LARGE')); m.done();
  }
});
