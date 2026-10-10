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
test('Get Document requests expanded assignments and preserves all API output fields', async () => {
  const expected = { ...readyDocument, tags: [{ id: 'tag1', name: 'Test' }], signing_url: 'https://example.com/sign', assignment: { id: 'assignment1' } };
  const m = mock([workspaceStep(), { response: ok(expected), check(url) { assert.equal(url.searchParams.get('expand'), 'assignment'); } }]);
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
  await assert.rejects(runAction('create_document_from_template', client(m), { template_id: 'template1', body: { signers: [{ id: 'other', role_id: 'customer' }] } }), hasCode('SIGNER_NOT_FOUND')); m.done();
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
    { response: ok({ ...readyDocument, status: 'pending' }) }, { response: ok({ ...readyDocument, status: 'certificated' }) }]);
  const c = client(m);
  await runAction('create_signer', c, { body: { full_name: 'Test Signer', email: 'signer@example.com' } });
  const sent = await runAction('create_document_from_template', c, { template_id: 'template1', body });
  assert.equal((await runAction('get_document', c, { document_id: sent.id })).status, 'certificated'); m.done();
});
