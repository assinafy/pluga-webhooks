import test from 'node:test';
import assert from 'node:assert/strict';
import { AssinafyClient, listContracts, getContract, getContractFamily, updateContract, renewContract, terminateContract, normalizeEvent } from '../dist/index.js';
import { mock, ok, credentials, workspaceStep, hasCode } from './helpers.mjs';

const current = { resource: 'document_contract', document_id: 'document1', status: 'active', counterparty_name: 'Example company',
  counterparty_taxpayer_id: '11222333000181', value: 120000.5, currency: 'BRL', start_date: '2026-11-01', end_date: '2027-10-31',
  auto_renew: true, renewal_term_months: 12, notice_period_days: 30, term: 1, owner_id: 'owner1', metadata: { crm_stage: 'won' },
  external_references: [{ system: 'crm', id: 'deal1' }], created_at: '2026-10-28T12:00:00Z', updated_at: '2026-10-28T12:00:00Z' };
const amendment = { resource: 'document_contract_amendment', document_id: 'amendment1', document_name: 'Example amendment',
  parent_document_id: current.document_id, relation_type: 'amendment', number: null, status: 'pending', document_status: 'pending_signature',
  apply_error: null, currency: 'BRL', terms: { value: 130000 }, changes: { value: { from: 120000.5, to: 130000 } },
  applied_at: null, created_at: current.created_at, updated_at: current.updated_at };
const client = m => new AssinafyClient(credentials, m.runtime);

test('contract pagination uses document_id, preserves all response fields and forwards every filter', async () => {
  const filters = { status: 'active,expired', counterparty: 'Example', search: 'Agreement', end_date_from: '2026-01-01', end_date_to: '2027-12-31',
    ending_within_days: 0, external_system: 'crm', external_id: 'deal1', sort: '-updated_at', expand: 'document' };
  const row = { ...current, document: { id: 'document1', account_id: 'workspace1', has_contract: true }, future: { preserved: true } };
  delete row.resource;
  const second = { ...row, document_id: 'document2' };
  const m = mock([workspaceStep(), { response: ok([row], { 'X-Pagination-Page-Count': '2' }), check(url) {
    assert.equal(url.pathname, '/v1/accounts/workspace1/contracts');
    for (const [key, value] of Object.entries(filters)) assert.equal(url.searchParams.get(key), String(value));
  } }, { response: ok([second], { 'X-Pagination-Page-Count': '2' }), check(url) { assert.equal(url.searchParams.get('page'), '2'); } }]);
  assert.deepEqual(await listContracts(client(m), filters), [row, second]); m.done();
});

test('contract and amendment reads keep their different shapes and family reads return the root', async () => {
  const family = { ...current, amendments: [amendment] };
  const m = mock([workspaceStep(), ...[current, amendment, family].map((data, i) => ({ response: ok(data), check(url, init) {
    assert.equal(init.method, 'GET'); assert.equal(url.pathname, `/v1/accounts/workspace1/documents/${i ? 'amendment1' : 'document1'}/contract${i === 2 ? '/related' : ''}`);
  } }))]);
  const c = client(m);
  assert.deepEqual(await getContract(c, 'document1'), current);
  assert.deepEqual(await getContract(c, 'amendment1'), amendment);
  assert.deepEqual(await getContractFamily(c, 'amendment1'), family); m.done();
});

test('CLM writes use envelopes without inventing resource IDs or dropping nullable and dynamic fields', async () => {
  const full = { status: 'active', counterparty_name: 'Example company', counterparty_taxpayer_id: '11.222.333/0001-81', value: 120000.5,
    currency: 'brl', start_date: '2026-11-01', end_date: '2027-10-31', auto_renew: true, renewal_term_months: 12, notice_period_days: 0,
    owner_id: 'owner1', metadata: { crm_stage: 'won', 'custom.key': 'value' }, external_references: [{ system: 'crm', id: 'deal1' }], updated_at: current.updated_at };
  for (const [fn, documentId, body, suffix, response] of [
    [updateContract, 'document1', full, '', current],
    [updateContract, 'document1', { metadata: null, external_references: null, value: null, currency: null, owner_id: null, start_date: null, end_date: null, renewal_term_months: null, notice_period_days: null }, '', current],
    [updateContract, 'amendment1', { parent_document_id: 'document1', relation_type: 'amendment', value: 130000, updated_at: amendment.updated_at }, '', amendment],
    [updateContract, 'amendment1', { parent_document_id: null }, '', amendment],
    [renewContract, 'document1', { term: 1, end_date: null, value: null, updated_at: current.updated_at }, '/renew', { ...current, term: 2 }],
    [renewContract, 'document1', { end_date: '2028-10-31', value: 0.29 }, '/renew', { ...current, term: 2 }],
    [terminateContract, 'document1', { reason: 'Example reason', updated_at: current.updated_at }, '/terminate', { ...current, status: 'terminated' }],
    [terminateContract, 'document1', {}, '/terminate', { ...current, status: 'terminated' }],
  ]) {
    const m = mock([workspaceStep(), { response: ok(response), check(url, init) {
      assert.equal(url.pathname, `/v1/accounts/workspace1/documents/${documentId}/contract${suffix}`);
      assert.equal(init.method, suffix ? 'POST' : 'PUT'); assert.deepEqual(JSON.parse(init.body), body);
    } }]);
    assert.deepEqual(await fn(client(m), documentId, body), response); m.done();
  }
});

test('invalid contract inputs and filters are rejected before any HTTP request', async () => {
  const m = mock([]); const c = client(m);
  for (const body of [null, [], {}, { unknown: true }, { metadata: new Date() }, { metadata: new Map() },
    { metadata: Object.assign(Object.create({ toJSON() { return 'bypassed'; } }), { field: 'value' }) },
    { metadata: { bad: 12 } }, { metadata: { 'invalid key': 'x' } },
    { metadata: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'x'])) }, { metadata: { key: 'x'.repeat(501) } },
    { value: -1 }, { value: 1.005 }, { value: 10000000000000 }, { renewal_term_months: 0 }, { renewal_term_months: 601 },
    { notice_period_days: 3651 }, { end_date: '2027-02-30' }, { start_date: '0999-01-01' }, { start_date: '2027-02-01', end_date: '2027-01-01' },
    { currency: 'BR' }, { owner_id: '../other' }, { parent_document_id: 'document1' }, { status: 'signed' }, { updated_at: '2027-01-01' },
    { external_references: [{ system: 'bad system', id: '1' }] }, { external_references: [{ system: 'crm', id: '' }] },
    { external_references: [{ system: 'crm', id: '😀' }] }, { external_references: Array(21).fill({ system: 'crm', id: '1' }) }]) {
    await assert.rejects(updateContract(c, 'document1', body));
  }
  for (const body of [{}, { term: 0 }, { term: 1.2 }, { term: 1, end_date: '2027-02-30' }, { term: 1, value: -1 }]) await assert.rejects(renewContract(c, 'document1', body));
  await assert.rejects(terminateContract(c, 'document1', { reason: 'x'.repeat(501) }));
  for (const filters of [{ status: 'signed' }, { ending_within_days: -1 }, { ending_within_days: 3651 }, { end_date_from: '2026-02-30' }, { page: 1 }]) await assert.rejects(listContracts(c, filters));
  await assert.rejects(getContract(c, '../other'), hasCode('INVALID_ID')); m.done();
});

test('conflicts and plan limits are surfaced; uncertain CLM writes are never retried', async () => {
  for (const status of [400, 403, 409, 429, 500]) {
    const m = mock([workspaceStep(), { response: new Response('private contract details', { status }) }]);
    await assert.rejects(renewContract(client(m), 'document1', { term: 1 }), error => {
      assert.equal(error.safeToRetry, false); assert.equal(error.outcomeUnknown, status === 500);
      assert.equal(error.message.includes('private contract'), false); return true;
    }); m.done();
  }
  for (const step of [{ error: new Error('private') }, { response: new Response('invalid JSON') },
    { response: ok({ ...current, document_id: 'other' }) }, { response: ok({}) }]) {
    const m = mock([workspaceStep(), step]);
    await assert.rejects(updateContract(client(m), 'document1', { value: 1 }), error => error.outcomeUnknown && !error.safeToRetry); m.done();
  }
});

test('OAuth CLM helpers retain the selected workspace and Bearer authentication', async () => {
  const m = mock([workspaceStep(), { response: ok(current), check(_, init) {
    assert.equal(init.headers.Authorization, 'Bearer oauth-test'); assert.equal(init.headers['X-Api-Key'], undefined);
  } }]);
  await getContract(new AssinafyClient({ type: 'oauth2', accessToken: 'oauth-test', accountId: 'workspace1' }, m.runtime), 'document1'); m.done();
});

for (const event of ['document_contract_updated', 'document_contract_renewal_notice', 'document_contract_expiring', 'document_contract_expired',
  'document_contract_renewed', 'document_contract_terminated', 'document_contract_amended', 'document_contract_amendment_updated']) {
  test(`${event} identifies its document without exposing contract terms or personal data`, () => {
    const input = { id: 10001, account_id: 'workspace1', event, created_at: 1793188800,
      object: { id: 'document1', type: 'Document', account_id: 'workspace1', status: 'certificated' }, payload: { reason: 'private', changes: { value: 10 } } };
    const normalized = normalizeEvent(input, 'workspace1', 'msg-contract');
    assert.equal(normalized.document_id, 'document1'); assert.equal(normalized.deduplication_key, 'workspace1:msg-contract');
    assert.equal(normalized.payload, undefined);
    assert.throws(() => normalizeEvent({ ...input, object: { type: 'Signer', id: 'signer1' } }, 'workspace1'), hasCode('INVALID_EVENT'));
  });
}

test('family expansion preserves the parent document and amendments without a resource discriminator', async () => {
  const { resource, ...entry } = amendment;
  const expected = { ...current, document: { id: current.document_id, name: 'Parent document' }, amendments: [entry] };
  const m = mock([workspaceStep(), { response: ok(expected), check(url) { assert.equal(url.searchParams.get('expand'), 'document'); } }]);
  assert.deepEqual(await getContractFamily(client(m), amendment.document_id, { expand: 'document' }), expected); m.done();
  const invalid = mock([]);
  for (const options of [{ expand: 'assignment' }, { extra: true }, null]) await assert.rejects(getContractFamily(client(invalid), 'document1', options), hasCode('INVALID_INPUT'));
  invalid.done();
});
