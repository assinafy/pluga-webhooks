import assert from 'node:assert/strict';

// A test that forgets to inject its transport cannot contact any real service.
globalThis.fetch = async () => { throw new Error('Real network access is disabled in this test suite.'); };
export const NOW = Date.UTC(2026, 9, 2, 20, 0, 0);
export const credentials = { type: 'api_key', apiKey: 'test-secret', environment: 'production', accountId: 'workspace1' };
export const account = { id: 'workspace1', name: 'Test workspace' };
export const signer = { id: 'signer1', full_name: 'Test Signer', email: 'signer@example.com' };
export const readyDocument = { id: 'document1', account_id: 'workspace1', name: 'Test contract', status: 'metadata_ready' };
export const template = {
  id: 'template1', name: 'Test template', status: 'ready',
  roles: [{ id: 'customer', name: 'Customer', assignment_type: 'signer' }, { id: 'editor', assignment_type: 'editor' }],
  pages: [{ fields: [{ field_id: 'price', role_id: 'editor', label: 'Price' }, { field_id: 'signature', role_id: 'customer', label: 'Signature' }] }],
};
export function ok(data, headers = {}) {
  return new Response(JSON.stringify({ status: 200, data }), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
}
export function mock(steps) {
  const calls = [];
  const checkErrors = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: new URL(url), init });
    const step = steps[calls.length - 1];
    if (!step) throw new Error('Unexpected HTTP request.');
    if (step.check) {
      try { await step.check(new URL(url), init); } catch (error) { checkErrors.push(error); }
    }
    if (step.error) throw step.error;
    return typeof step.response === 'function' ? step.response() : step.response;
  };
  return {
    calls, fetch,
    runtime: { fetch, now: () => NOW },
    done() {
      assert.equal(calls.length, steps.length, 'Every expected request must be consumed exactly once.');
      if (checkErrors.length) throw checkErrors[0];
    },
  };
}
export const workspaceStep = () => ({ response: ok([account]), check: url => assert.equal(url.pathname, '/v1/accounts') });
export function hasCode(code) { return error => { assert.equal(error.code, code); return true; }; }
export const pdf = () => ({ bytes: new TextEncoder().encode('%PDF-1.7\nfixture only\n%%EOF'), filename: 'contract.pdf', mimeType: 'application/pdf' });
