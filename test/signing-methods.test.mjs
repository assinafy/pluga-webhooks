import test from 'node:test';
import assert from 'node:assert/strict';
import { AssinafyClient, runAction, normalizeEvent } from '../dist/index.js';
import { mock, ok, credentials, workspaceStep, signer, readyDocument, template, hasCode } from './helpers.mjs';

const methods = ['Email', 'Whatsapp', 'DigitalCertificate', 'IdDocumentFaceMatchBasic'];
const contact = { ...signer, whatsapp_phone_number: '+5548999990000', government_id: '39053344705' };
const document = { ...readyDocument, pages: [{ id: 'page1', width: 500, height: 700 }] };
const entries = [{ page_id: 'page1', fields: [{ signer_id: signer.id, field_id: 'signature',
  display_settings: { left: 0, top: 0, width: 100, height: 50, fontSize: 20 } }] }];

for (const flow of ['template', 'virtual', 'collect']) for (const verification of methods) {
  for (const notification of ['Email', 'Whatsapp', undefined]) {
    const virtualCertificate = verification !== 'DigitalCertificate' || flow === 'virtual';
    const allowed = virtualCertificate && (!notification || ['DigitalCertificate', 'IdDocumentFaceMatchBasic'].includes(verification) || notification === verification);
    test(`${flow}: ${verification} with ${notification ?? 'inferred'} notification ${allowed ? 'sends' : 'is rejected'}`, async () => {
      const row = { id: signer.id, verification_method: verification,
        ...(notification ? { notification_methods: [notification] } : {}), ...(flow === 'template' ? { role_id: 'customer' } : {}) };
      const body = { signers: [row], ...(flow === 'template' ? { editor_fields: [{ field_id: 'price', value: '20' }] } : { method: flow }), ...(flow === 'collect' ? { entries } : {}) };
      const reads = flow === 'template' ? [workspaceStep(), { response: ok([template]) }] : allowed ? [workspaceStep(), { response: ok(document) }] : [];
      const signers = [{ ...row, ...(verification === 'IdDocumentFaceMatchBasic' ? { identity_verification_status: 'InReview' } : {}) }];
      const result = { id: 'created1', ...(flow === 'template' ? { assignment: { signers } } : { signers }), future_data: { preserved: true } };
      const m = mock([...reads, ...(allowed ? [{ response: ok([contact]) }, { response: ok(result), check(_, init) {
        assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), body);
      } }] : [])]);
      const call = runAction(flow === 'template' ? 'create_document_from_template' : 'request_signatures', new AssinafyClient(credentials, m.runtime),
        { ...(flow === 'template' ? { template_id: template.id } : { document_id: document.id }), body });
      if (allowed) assert.deepEqual(await call, result);
      else await assert.rejects(call, hasCode(virtualCertificate ? 'INVALID_NOTIFICATION' : 'DIGITAL_CERTIFICATE_REQUIRES_VIRTUAL'));
      m.done();
    });
  }
}

test('template without signer placements supports a digital certificate signer', async () => {
  const selected = { ...template, pages: [{ fields: template.pages[0].fields.filter(field => field.role_id === 'editor') }] };
  const body = { signers: [{ id: signer.id, role_id: 'customer', verification_method: 'DigitalCertificate' }],
    editor_fields: [{ field_id: 'price', value: 'R$ 20' }] };
  const m = mock([workspaceStep(), { response: ok([selected]) }, { response: ok([contact]) }, { response: ok({ id: 'created1' }) }]);
  await runAction('create_document_from_template', new AssinafyClient(credentials, m.runtime), { template_id: template.id, body }); m.done();
});

for (const flow of ['template', 'virtual']) for (const government_id of [undefined, null, '', '12ABC34501DE35', '12345678000195', '390.533.447-05']) {
  test(`${flow}: biometric signing requires a normalized CPF: ${government_id}`, async () => {
    const m = mock([workspaceStep(), { response: ok(flow === 'template' ? [template] : document) }, { response: ok([{ ...contact, government_id }]) }]);
    const body = { signers: [{ id: signer.id, verification_method: 'IdDocumentFaceMatchBasic', ...(flow === 'template' ? { role_id: 'customer' } : {}) }],
      ...(flow === 'template' ? { editor_fields: [{ field_id: 'price', value: '20' }] } : { method: 'virtual' }) };
    await assert.rejects(runAction(flow === 'template' ? 'create_document_from_template' : 'request_signatures', new AssinafyClient(credentials, m.runtime),
      { ...(flow === 'template' ? { template_id: template.id } : { document_id: document.id }), body }), hasCode('INVALID_GOVERNMENT_ID'));
    m.done();
  });
}

for (const notification of ['Email', 'Whatsapp']) for (const flow of ['template', 'virtual']) {
  test(`${flow}: notification alone infers ${notification} verification and uses only that contact`, async () => {
    const row = { id: signer.id, notification_methods: [notification], ...(flow === 'template' ? { role_id: 'customer' } : {}) };
    const body = { signers: [row], ...(flow === 'template' ? { editor_fields: [{ field_id: 'price', value: '20' }] } : { method: 'virtual' }) };
    const selected = { ...contact, ...(notification === 'Whatsapp' ? { email: null } : { whatsapp_phone_number: null }), government_id: null };
    const m = mock([workspaceStep(), { response: ok(flow === 'template' ? [template] : document) }, { response: ok([selected]) }, { response: ok({ id: 'created1' }) }]);
    await runAction(flow === 'template' ? 'create_document_from_template' : 'request_signatures', new AssinafyClient(credentials, m.runtime),
      { ...(flow === 'template' ? { template_id: template.id } : { document_id: document.id }), body }); m.done();
  });
}

test('digital certificate steps stay isolated while biometric signers can share a later step', async () => {
  const body = { method: 'virtual', signers: [
    { id: signer.id, verification_method: 'DigitalCertificate', notification_methods: ['Whatsapp'], step: 1 },
    { id: 'signer2', verification_method: 'IdDocumentFaceMatchBasic', step: 2 },
    { id: 'signer3', verification_method: 'Email', step: 2 },
  ] };
  const m = mock([workspaceStep(), { response: ok(document) }, { response: ok([contact, { ...contact, id: 'signer2' }, { ...contact, id: 'signer3' }]) },
    { response: ok({ id: 'assignment1' }), check(_, init) { assert.deepEqual(JSON.parse(init.body), body); } }]);
  await runAction('request_signatures', new AssinafyClient(credentials, m.runtime), { document_id: document.id, body }); m.done();
});

for (const event of ['signer_identity_verified', 'signer_identity_verification_failed', 'signer_identity_review_required',
  'signer_identity_review_approved', 'signer_identity_review_rejected']) {
  test(`${event} normalizes its document and keeps private evidence out of the result`, () => {
    const input = { id: 10001, account_id: 'workspace1', event, created_at: 1791028800,
      object: { type: 'Document', id: document.id, status: 'pending_identity_review' }, payload: { evidence: 'private-evidence' } };
    const normalized = normalizeEvent(input, 'workspace1');
    assert.equal(normalized.document_id, document.id); assert.equal(normalized.status, 'pending_identity_review');
    assert.equal(JSON.stringify(normalized).includes('private-evidence'), false);
    assert.throws(() => normalizeEvent({ ...input, object: { type: 'Signer', id: signer.id } }, 'workspace1'), hasCode('INVALID_EVENT'));
  });
}

for (const verification of methods) for (const channel of ['Email', 'Whatsapp']) {
  if (!['DigitalCertificate', 'IdDocumentFaceMatchBasic', channel].includes(verification)) continue;
  test(`inline template lookup supports ${verification}/${channel} without discarding fields`, async () => {
    const body = { signers: [{ role_id: 'customer', email: contact.email, name: 'Example signer', whatsapp_phone_number: contact.whatsapp_phone_number,
      verification_method: verification, notification_methods: [channel] }] };
    const selected = { ...template, pages: [] };
    for (const existing of [true, false]) {
      const allowed = existing || ['Email', 'Whatsapp'].includes(verification);
      const m = mock([workspaceStep(), { response: ok([selected]) }, { response: ok(existing ? [contact] : []) },
        ...(allowed ? [{ response: ok({ ...readyDocument, status: 'uploaded', assignment: null }), check(_, init) { assert.deepEqual(JSON.parse(init.body), body); } }] : [])]);
      const call = runAction('create_document_from_template', new AssinafyClient(credentials, m.runtime), { template_id: template.id, body });
      if (allowed) assert.equal((await call).status, 'uploaded');
      else await assert.rejects(call, hasCode('INVALID_GOVERNMENT_ID'));
      m.done();
    }
  });
}

test('template IDs take precedence over inline fields and copy roles are optional', async () => {
  const selected = { ...template, pages: [], roles: [...template.roles, { id: 'copy', assignment_type: 'CopyReceiver' }] };
  const body = { signers: [{ id: signer.id, role_id: 'customer', email: 'ignored', name: '' }] };
  const m = mock([workspaceStep(), { response: ok([selected]) }, { response: ok([contact]) }, { response: ok({ id: 'created1' }) }]);
  await runAction('create_document_from_template', new AssinafyClient(credentials, m.runtime), { template_id: template.id, body }); m.done();
});

for (const row of [{}, { email: 'invalid', name: 'Example' }, { email: 'new@example.com' },
  { email: 'new@example.com', name: 'Example', whatsapp_phone_number: 'invalid' }]) {
  test(`invalid inline contact cannot send: ${JSON.stringify(row)}`, async () => {
    const m = mock([workspaceStep(), { response: ok([{ ...template, pages: [] }]) }, { response: ok([]) }]);
    await assert.rejects(runAction('create_document_from_template', new AssinafyClient(credentials, m.runtime),
      { template_id: template.id, body: { signers: [{ ...row, role_id: 'customer' }] } })); m.done();
  });
}

for (const editor_fields of [undefined, [], [{ field_id: 'price', value: '' }]]) {
  test('every editor placement requires a supplied non-empty value', async () => {
    const m = mock([workspaceStep(), { response: ok([template]) }]);
    await assert.rejects(runAction('create_document_from_template', new AssinafyClient(credentials, m.runtime),
      { template_id: template.id, body: { signers: [{ id: signer.id, role_id: 'customer' }], ...(editor_fields ? { editor_fields } : {}) } }), hasCode('INVALID_EDITOR_FIELDS')); m.done();
  });
}

test('collect refuses a signer without a field and a template signing role without a placement', async () => {
  const m = mock([workspaceStep(), { response: ok(document) }]);
  await assert.rejects(runAction('request_signatures', new AssinafyClient(credentials, m.runtime),
    { document_id: document.id, body: { method: 'collect', signers: [{ id: signer.id }, { id: 'signer2' }], entries } }), hasCode('INVALID_ENTRIES')); m.done();
  const selected = { ...template, roles: [...template.roles, { id: 'second', assignment_type: 'Signer' }] };
  const t = mock([workspaceStep(), { response: ok([selected]) }]);
  await assert.rejects(runAction('create_document_from_template', new AssinafyClient(credentials, t.runtime),
    { template_id: template.id, body: { signers: [{ id: signer.id, role_id: 'customer' }, { id: 'signer2', role_id: 'second' }] } }), hasCode('INVALID_ENTRIES')); t.done();
});

for (const flow of ['template', 'virtual', 'collect']) for (const verification of methods) {
  test(`${flow}: embedded ${verification} signing enforces supported methods and preserves credit ceilings`, async () => {
    const allowed = ['Email', 'Whatsapp'].includes(verification);
    const body = { signers: [{ id: signer.id, verification_method: verification, embedded: true, ...(flow === 'template' ? { role_id: 'customer' } : {}) }],
      max_total_credits: 1.5, ...(flow === 'template' ? { editor_fields: [{ field_id: 'price', value: '20' }] } : { method: flow }), ...(flow === 'collect' ? { entries } : {}) };
    const reads = flow === 'template' ? [workspaceStep(), { response: ok([template]) }] : allowed ? [workspaceStep(), { response: ok(document) }] : [];
    const response = { id: 'created1', signing_urls: [{ signer_id: signer.id, url: null, embedded: true }] };
    const m = mock([...reads, ...(allowed ? [{ response: ok([contact]) }, { response: ok(response), check(_, init) { assert.deepEqual(JSON.parse(init.body), body); } }] : [])]);
    const call = runAction(flow === 'template' ? 'create_document_from_template' : 'request_signatures', new AssinafyClient(credentials, m.runtime),
      { ...(flow === 'template' ? { template_id: template.id } : { document_id: document.id }), body });
    if (allowed) assert.deepEqual(await call, response);
    else await assert.rejects(call, hasCode('INVALID_VERIFICATION'));
    m.done();
  });
}
