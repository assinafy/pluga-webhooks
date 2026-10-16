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
    const allowed = !notification || ['DigitalCertificate', 'IdDocumentFaceMatchBasic'].includes(verification) || notification === verification;
    test(`${flow}: ${verification} with ${notification ?? 'inferred'} notification ${allowed ? 'sends' : 'is rejected'}`, async () => {
      const row = { id: signer.id, verification_method: verification,
        ...(notification ? { notification_methods: [notification] } : {}), ...(flow === 'template' ? { role_id: 'customer' } : {}) };
      const body = { signers: [row], ...(flow === 'template' ? {} : { method: flow }), ...(flow === 'collect' ? { entries } : {}) };
      const reads = flow === 'template' ? [workspaceStep(), { response: ok([template]) }] : allowed ? [workspaceStep(), { response: ok(document) }] : [];
      const signers = [{ ...row, ...(verification === 'IdDocumentFaceMatchBasic' ? { identity_verification_status: 'InReview' } : {}) }];
      const result = { id: 'created1', ...(flow === 'template' ? { assignment: { signers } } : { signers }), future_data: { preserved: true } };
      const m = mock([...reads, ...(allowed ? [{ response: ok([contact]) }, { response: ok(result), check(_, init) {
        assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), body);
      } }] : [])]);
      const call = runAction(flow === 'template' ? 'create_document_from_template' : 'request_signatures', new AssinafyClient(credentials, m.runtime),
        { ...(flow === 'template' ? { template_id: template.id } : { document_id: document.id }), body });
      if (allowed) assert.deepEqual(await call, result);
      else await assert.rejects(call, hasCode('INVALID_NOTIFICATION'));
      m.done();
    });
  }
}

for (const flow of ['template', 'virtual']) for (const government_id of [undefined, null, '', '12ABC34501DE35', '12345678000195', '390.533.447-05']) {
  test(`${flow}: biometric signing requires a normalized CPF: ${government_id}`, async () => {
    const m = mock([workspaceStep(), { response: ok(flow === 'template' ? [template] : document) }, { response: ok([{ ...contact, government_id }]) }]);
    const body = { signers: [{ id: signer.id, verification_method: 'IdDocumentFaceMatchBasic', ...(flow === 'template' ? { role_id: 'customer' } : {}) }],
      ...(flow === 'template' ? {} : { method: 'virtual' }) };
    await assert.rejects(runAction(flow === 'template' ? 'create_document_from_template' : 'request_signatures', new AssinafyClient(credentials, m.runtime),
      { ...(flow === 'template' ? { template_id: template.id } : { document_id: document.id }), body }), hasCode('INVALID_GOVERNMENT_ID'));
    m.done();
  });
}

for (const notification of ['Email', 'Whatsapp']) for (const flow of ['template', 'virtual']) {
  test(`${flow}: notification alone infers ${notification} verification and uses only that contact`, async () => {
    const row = { id: signer.id, notification_methods: [notification], ...(flow === 'template' ? { role_id: 'customer' } : {}) };
    const body = { signers: [row], ...(flow === 'template' ? {} : { method: 'virtual' }) };
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
