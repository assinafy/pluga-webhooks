import test from 'node:test';
import assert from 'node:assert/strict';
import { AssinafyClient, runAction, loadOptions } from '../dist/index.js';
import { mock, ok, credentials, workspaceStep, signer, readyDocument, template, NOW, hasCode } from './helpers.mjs';
const client = m => new AssinafyClient(credentials, m.runtime);
const jsonCheck = (path, body) => (url, init) => {
  assert.equal(url.pathname, `/v1${path}`);
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), body);
  assert.equal(init.headers['X-Api-Key'], 'test-secret');
};
test('Create Signer sends every supported contact field and exposes the created ID', async () => {
  const body = { full_name: 'Test Signer', email: 'signer@example.com', whatsapp_phone_number: '+5548999990000', government_id: '390.533.447-05' };
  const m = mock([workspaceStep(), { response: ok(signer), check: jsonCheck('/accounts/workspace1/signers', body) }]);
  assert.equal((await runAction('create_signer', client(m), { body })).id, signer.id); m.done();
});
test('bad signer inputs cause no API writes or reads', async () => {
  const m = mock([]);
  for (const body of [{}, { full_name: ' ', email: 'a@example.com' }, { full_name: 'Test', email: 'bad' },
    { full_name: 'Test', whatsapp_phone_number: '48889999' }, { full_name: 'Test', email: 'a@example.com', unsupported: '123' }]) {
    await assert.rejects(runAction('create_signer', client(m), { body }));
  }
  m.done();
});
test('OAuth connections still require an explicit workspace', () => {
  assert.throws(() => new AssinafyClient({ type: 'oauth2', accessToken: 'secret' }), hasCode('INVALID_ID'));
});
test('Get Document includes its assignment without an undocumented expansion and preserves all API output fields', async () => {
  const expected = { ...readyDocument, tags: [{ id: 'tag1', name: 'Test' }], signing_url: 'https://example.com/sign', assignment: { id: 'assignment1' } };
  const m = mock([workspaceStep(), { response: ok(expected), check(url) { assert.equal(url.searchParams.has('expand'), false); } }]);
  assert.deepEqual(await runAction('get_document', client(m), { document_id: 'document1' }), expected); m.done();
});
test('Get Document rejects another workspace and does not follow supplied URLs', async () => {
  const m = mock([workspaceStep(), { response: ok({ ...readyDocument, account_id: 'other' }) }]);
  await assert.rejects(runAction('get_document', client(m), { document_id: 'document1' }), hasCode('WORKSPACE_ACCESS_DENIED')); m.done();
  const empty = mock([]);
  await assert.rejects(runAction('get_document', client(empty), { document_id: 'https://evil.example' }), hasCode('INVALID_ID')); empty.done();
});
test('template send preserves all fields and validates role/editor/signer membership before POST', async () => {
  const body = { signers: [{ id: 'signer1', role_id: 'customer', verification_method: 'Email', notification_methods: ['Email'], step: 1 }],
    editor_fields: [{ field_id: 'price', value: 'R$ 20' }], name: 'Test Contract', message: 'Please sign',
    expires_at: new Date(NOW + 7200000).toISOString(), tags: ['Test'] };
  const m = mock([workspaceStep(), { response: ok([template]) }, { response: ok([signer]) },
    { response: ok({ ...readyDocument, id: 'new-document' }), check: jsonCheck('/accounts/workspace1/templates/template1/documents', body) }]);
  assert.equal((await runAction('create_document_from_template', client(m), { template_id: 'template1', body })).id, 'new-document'); m.done();
});
for (const [label, body, code] of [
  ['missing roles', { signers: [] }, 'INVALID_ROLE_MAPPING'],
  ['wrong role', { signers: [{ id: 'signer1', role_id: 'wrong' }] }, 'INVALID_ROLE_MAPPING'],
  ['foreign editor field', { signers: [{ id: 'signer1', role_id: 'customer' }], editor_fields: [{ field_id: 'other', value: 'x' }] }, 'INVALID_EDITOR_FIELDS'],
  ['duplicate field', { signers: [{ id: 'signer1', role_id: 'customer' }], editor_fields: [{ field_id: 'price', value: 'x' }, { field_id: 'price', value: 'y' }] }, 'INVALID_EDITOR_FIELDS'],
]) test(`template ${label} never sends`, async () => {
  const m = mock([workspaceStep(), { response: ok([template]) }]);
  await assert.rejects(runAction('create_document_from_template', client(m), { template_id: 'template1', body }), hasCode(code)); m.done();
});
test('template cannot send to a signer outside this workspace', async () => {
  const m = mock([workspaceStep(), { response: ok([template]) }, { response: ok([]) }]);
  await assert.rejects(runAction('create_document_from_template', client(m), { template_id: 'template1', body: { signers: [{ id: 'other', role_id: 'customer' }], editor_fields: [{ field_id: 'price', value: '20' }] } }), hasCode('SIGNER_NOT_FOUND')); m.done();
});
test('virtual request supports ordered signing, message, expiration and copy receivers', async () => {
  const body = { method: 'virtual', signers: [{ id: 'signer1', step: 1 }], copy_receivers: ['copy1'], message: 'Test', expires_at: new Date(NOW + 7200000).toISOString() };
  const m = mock([workspaceStep(), { response: ok(readyDocument) }, { response: ok([signer, { id: 'copy1' }]) },
    { response: ok({ id: 'assignment1' }), check: jsonCheck('/documents/document1/assignments', body) }]);
  assert.equal((await runAction('request_signatures', client(m), { document_id: 'document1', body })).id, 'assignment1'); m.done();
});
test('collect mode sends nested placements with geometry and verifies document pages', async () => {
  const body = { method: 'collect', signers: [{ id: 'signer1' }], entries: [{ page_id: 'page1', fields: [{ signer_id: 'signer1', field_id: 'signature',
    display_settings: { left: 20, top: 30, width: 100, height: 50, fontSize: 20, fontFamily: 'Arial', backgroundColor: '#ffffff' } }] }] };
  const doc = { ...readyDocument, pages: [{ id: 'page1', width: 500, height: 700 }] };
  const m = mock([workspaceStep(), { response: ok(doc) }, { response: ok([signer]) }, { response: ok({ id: 'assignment1' }), check: jsonCheck('/documents/document1/assignments', body) }]);
  await runAction('request_signatures', client(m), { document_id: 'document1', body }); m.done();
  body.entries[0].fields[0].display_settings.left = 450;
  const invalid = mock([workspaceStep(), { response: ok(doc) }]);
  await assert.rejects(runAction('request_signatures', client(invalid), { document_id: 'document1', body }), hasCode('INVALID_ENTRIES')); invalid.done();
});
test('existing assignment blocks duplicate invitations', async () => {
  const m = mock([workspaceStep(), { response: ok({ ...readyDocument, assignment: { id: 'already-sent' } }) }]);
  await assert.rejects(runAction('request_signatures', client(m), { document_id: 'document1', body: { method: 'virtual', signers: [{ id: 'signer1' }] } }), hasCode('ALREADY_SENT')); m.done();
});
test('missing or malformed assignment state cannot create a duplicate invitation', async () => {
  for (const assignment of [undefined, {}, true]) {
    const selected = { ...readyDocument, assignment };
    if (assignment === undefined) delete selected.assignment;
    const m = mock([workspaceStep(), { response: ok(selected) }]);
    await assert.rejects(runAction('request_signatures', client(m), { document_id: 'document1', body: { method: 'virtual', signers: [{ id: 'signer1' }] } }), hasCode('INVALID_RESPONSE')); m.done();
  }
});
test('invalid verification pairs, multiple notifications, and noncontiguous steps cannot write', async () => {
  const m = mock([]);
  for (const signers of [
    [{ id: 'signer1', verification_method: 'Whatsapp', notification_methods: ['Email'] }],
    [{ id: 'signer1', notification_methods: ['Email', 'Whatsapp'] }],
    [{ id: 'signer1', step: 2 }], [{ id: 'signer1', step: 1 }, { id: 'signer2' }],
    [{ id: 'signer1', verification_method: 'DigitalCertificate' }, { id: 'signer2' }],
  ]) await assert.rejects(runAction('request_signatures', client(m), { document_id: 'document1', body: { method: 'virtual', signers } }));
  m.done();
});
test('expiration, enum and nested unsupported inputs are rejected before HTTP', async () => {
  const m = mock([]);
  for (const body of [
    { method: 'virtual', signers: [{ id: 'signer1' }], expires_at: new Date(NOW + 1000).toISOString() },
    { method: 'invalid', signers: [{ id: 'signer1' }] },
    { method: 'virtual', signers: [{ id: 'signer1', unknown: 'value' }] },
  ]) await assert.rejects(runAction('request_signatures', client(m), { document_id: 'document1', body }));
  m.done();
});
test('dependent template lists filter editor roles and expose unique editor field IDs', async () => {
  const m = mock([workspaceStep(), { response: ok([template]) }, { response: ok([template]) }]);
  const c = client(m);
  assert.deepEqual(await loadOptions('template_roles', c, 'template1'), [{ value: 'customer', label: 'Customer' }]);
  assert.deepEqual(await loadOptions('editor_fields', c, 'template1'), [{ value: 'price', label: 'Price' }]); m.done();
});
test('local end-to-end action sequence creates a signer, sends a template and reads certification', async () => {
  const body = { signers: [{ id: 'signer1', role_id: 'customer' }], editor_fields: [{ field_id: 'price', value: 'R$ 20' }] };
  const m = mock([workspaceStep(), { response: ok(signer) }, { response: ok([template]) }, { response: ok([signer]) },
    { response: ok({ ...readyDocument, status: 'pending_signature' }) }, { response: ok({ ...readyDocument, status: 'certificated' }) }]);
  const c = client(m);
  await runAction('create_signer', c, { body: { full_name: 'Test Signer', email: 'signer@example.com' } });
  const sent = await runAction('create_document_from_template', c, { template_id: 'template1', body });
  assert.equal((await runAction('get_document', c, { document_id: sent.id })).status, 'certificated'); m.done();
});

test('document envelope expansions are encoded explicitly and preserve nullable relationships', async () => {
  const expected = { ...readyDocument, envelope_id: null, envelope: null };
  const m = mock([workspaceStep(), { response: ok(expected), check(url) { assert.equal(url.searchParams.get('expand'), 'envelope_id,envelope'); } }]);
  assert.deepEqual(await runAction('get_document', client(m), { document_id: 'document1', expand: ['envelope_id', 'envelope'] }), expected); m.done();
  const invalid = mock([]);
  for (const expand of ['envelope', ['assignment'], [null]]) {
    await assert.rejects(runAction('get_document', client(invalid), { document_id: 'document1', expand }), hasCode('INVALID_INPUT'));
  }
  invalid.done();
});

test('template idempotency keys and credit ceilings reach only the write and preserve its response', async () => {
  const body = { signers: [{ id: 'signer1', role_id: 'customer' }], max_total_credits: 0 };
  const expected = { ...readyDocument, status: 'uploaded', assignment: null };
  const reads = [workspaceStep(), { response: ok([{ ...template, pages: [] }]) }, { response: ok([signer]) }];
  for (const step of reads) step.check = (_, init) => assert.equal(init.headers['Idempotency-Key'], undefined);
  const m = mock([...reads, { response: ok(expected), check(_, init) {
    assert.equal(init.headers['Idempotency-Key'], 'create-document-once');
    assert.deepEqual(JSON.parse(init.body), body);
  } }]);
  assert.deepEqual(await runAction('create_document_from_template', client(m), { template_id: 'template1', body, idempotency_key: 'create-document-once' }), expected);
  m.done();
});

test('invalid ceilings and misplaced or unsafe idempotency keys fail before HTTP', async () => {
  const m = mock([]);
  for (const max_total_credits of [-1, Infinity, NaN, '1', null]) {
    await assert.rejects(runAction('request_signatures', client(m), { document_id: 'document1', body: { method: 'virtual', signers: [{ id: 'signer1' }], max_total_credits } }), hasCode('INVALID_INPUT'));
  }
  for (const idempotency_key of ['', ' key', 'key ', 'key\r\nAuthorization: secret', 123]) {
    await assert.rejects(runAction('create_document_from_template', client(m), { template_id: 'template1', body: { signers: [] }, idempotency_key }), hasCode('INVALID_INPUT'));
  }
  await assert.rejects(runAction('create_signer', client(m), { body: { full_name: 'Example' }, idempotency_key: 'key' }), hasCode('INVALID_INPUT'));
  await assert.rejects(client(m).post('/documents', {}, 'key'), hasCode('INVALID_INPUT'));
  await assert.rejects(client(m).envelope('GET', '/accounts/workspace1/templates/template1/documents', { idempotencyKey: 'key' }), hasCode('INVALID_INPUT'));
  m.done();
});

test('an idempotency key does not trigger automatic replay after an uncertain template write', async () => {
  const m = mock([workspaceStep(), { response: ok([{ ...template, pages: [] }]) }, { response: ok([signer]) }, { error: new Error('timeout') }]);
  await assert.rejects(runAction('create_document_from_template', client(m), { template_id: 'template1', body: { signers: [{ id: 'signer1', role_id: 'customer' }] }, idempotency_key: 'once' }), error => error.outcomeUnknown && !error.safeToRetry);
  m.done();
});

test('embedded backend flow keeps single-use session responses intact and confirms completion by document read', async () => {
  const origin = { id: 'origin1', origin: 'https://app.example.com', created_at: '2026-11-11T12:00:00Z' };
  const session = { url: 'https://app.assinafy.com.br/embed/single-use-token', expires_at: '2026-11-11T12:05:00Z' };
  const body = { method: 'virtual', signers: [{ id: signer.id, verification_method: 'Email', embedded: true }], max_total_credits: 0 };
  const assignment = { id: 'assignment1', signing_urls: [{ signer_id: signer.id, embedded: true, url: null }] };
  const m = mock([workspaceStep(),
    { response: ok(origin), check: jsonCheck('/accounts/workspace1/embed-origins', { origin: origin.origin }) },
    { response: ok(readyDocument) }, { response: ok([signer]) },
    { response: ok(assignment), check: jsonCheck('/documents/document1/assignments', body) },
    { response: ok(session), check(url, init) {
      assert.equal(url.pathname, '/v1/documents/document1/assignments/assignment1/signers/signer1/embed-sessions');
      assert.equal(init.method, 'POST'); assert.equal(init.body, undefined);
    } },
    { response: ok({ ...readyDocument, status: 'certificated', assignment }) },
    { response: ok([]), check(url, init) { assert.equal(init.method, 'DELETE'); assert.equal(url.pathname, '/v1/accounts/workspace1/embed-origins/origin1'); } },
  ]);
  const c = client(m);
  await c.post(await c.accountPath('/embed-origins'), { origin: origin.origin });
  assert.deepEqual(await runAction('request_signatures', c, { document_id: readyDocument.id, body }), assignment);
  assert.deepEqual((await c.envelope('POST', '/documents/document1/assignments/assignment1/signers/signer1/embed-sessions')).data, session);
  assert.equal((await runAction('get_document', c, { document_id: readyDocument.id })).status, 'certificated');
  assert.deepEqual((await c.envelope('DELETE', await c.accountPath('/embed-origins/origin1'))).data, []); m.done();
});

test('a credit-ceiling rejection is surfaced without retrying the invitation', async () => {
  const body = { method: 'virtual', signers: [{ id: 'signer1' }], max_total_credits: 0 };
  const m = mock([workspaceStep(), { response: ok(readyDocument) }, { response: ok([signer]) },
    { response: new Response(JSON.stringify({ code: 'CreditCeilingExceeded', private_data: 'not-for-logs' }), { status: 409 }),
      check: jsonCheck('/documents/document1/assignments', body) }]);
  await assert.rejects(runAction('request_signatures', client(m), { document_id: readyDocument.id, body }), error => {
    assert.equal(error.httpStatus, 409); assert.equal(error.safeToRetry, false); assert.equal(error.outcomeUnknown, false);
    assert.equal(error.message.includes('not-for-logs'), false); return true;
  }); m.done();
});
