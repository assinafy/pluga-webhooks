import test from 'node:test';
import assert from 'node:assert/strict';
import { AssinafyClient } from '../dist/index.js';
import { limitedBody } from '../dist/client.js';
import { credentialsFromEnvironment } from '../scripts/credentials.mjs';
import { mock, ok, account, credentials, hasCode, workspaceStep, pdf } from './helpers.mjs';

test('API key uses a private header and an explicitly selected production workspace', async () => {
  const m = mock([{ response: ok([account]), check(url, init) {
    assert.equal(url.origin, 'https://api.assinafy.com.br');
    assert.equal(init.headers['X-Api-Key'], 'test-secret');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(url.href.includes('test-secret'), false);
    assert.equal(init.redirect, 'manual');
    assert.equal(url.searchParams.get('per-page'), '50');
  } }]);
  assert.equal((await new AssinafyClient(credentials, m.runtime).workspace()).id, 'workspace1'); m.done();
});
test('empty, malformed and ambiguous credentials fail before HTTP', () => {
  for (const changes of [{ apiKey: '' }, { apiKey: 'secret\n' }, { accountId: undefined }, { accountId: '../wrong' },
    { environment: 'staging' }, { environment: 'https://evil.example' }]) {
    assert.throws(() => new AssinafyClient({ ...credentials, ...changes }, mock([]).runtime));
  }
  for (const env of [{}, { ASSINAFY_API_KEY: 'key' }, { ASSINAFY_API_KEY: 'key', ASSINAFY_ACCOUNT_ID: 'id' }]) {
    assert.throws(() => credentialsFromEnvironment(env));
  }
  assert.deepEqual(credentialsFromEnvironment({ ASSINAFY_API_KEY: 'test-secret', ASSINAFY_ACCOUNT_ID: 'workspace1',
    ASSINAFY_ENVIRONMENT: 'production' }), credentials);
});
test('a selected workspace must be accessible', async () => {
  const m = mock([{ response: ok([{ id: 'workspace2' }]) }]);
  await assert.rejects(new AssinafyClient(credentials, m.runtime).workspace(), hasCode('WORKSPACE_ACCESS_DENIED')); m.done();
});
test('workspace reads coalesce within one client; credentials never cross clients', async () => {
  const m = mock([workspaceStep()]); const c = new AssinafyClient(credentials, m.runtime);
  assert.equal((await Promise.all([c.workspace(), c.workspace(), c.workspace()])).length, 3); m.done();
  const other = mock([{ response: ok([account]), check(_, init) { assert.equal(init.headers['X-Api-Key'], 'other'); } }]);
  await new AssinafyClient({ ...credentials, apiKey: 'other' }, other.runtime).workspace(); other.done();
});
test('URL and path injection cannot send credentials elsewhere', async () => {
  const m = mock([]); const c = new AssinafyClient(credentials, m.runtime);
  for (const path of ['https://evil.example/accounts', '//evil.example/accounts', '/documents/../accounts',
    '/documents/%2e%2e/accounts', '/documents/test?leak=1', '/accounts\\evil']) await assert.rejects(c.get(path), hasCode('UNSAFE_PATH'));
  m.done();
});
test('pagination follows page-count headers with per-page=50', async () => {
  const m = mock([{ response: ok([{ id: 'd1' }], { 'X-Pagination-Page-Count': '2' }) },
    { response: ok([{ id: 'd2' }], { 'X-Pagination-Page-Count': '2' }), check(url) { assert.equal(url.searchParams.get('page'), '2'); } }]);
  assert.equal((await new AssinafyClient(credentials, m.runtime).list('/documents')).length, 2); m.done();
});
test('contradictory repeated pages and page limits fail instead of returning partial membership', async () => {
  const m = mock([{ response: ok([{ id: 'd1' }], { 'X-Pagination-Page-Count': '3' }) },
    { response: ok([{ id: 'd1' }], { 'X-Pagination-Page-Count': '3' }) }]);
  await assert.rejects(new AssinafyClient(credentials, m.runtime).list('/documents'), hasCode('PAGINATION_INCONSISTENT')); m.done();
  const limit = mock([{ response: ok([{ id: 'd1' }], { 'X-Pagination-Page-Count': '2' }) }]);
  await assert.rejects(new AssinafyClient(credentials, { ...limit.runtime, maxPages: 1 }).list('/documents'), hasCode('PAGINATION_LIMIT')); limit.done();
});
test('rate-limit errors preserve delay but redact upstream bodies', async () => {
  const m = mock([{ response: new Response('test-secret person@example.com', { status: 429, headers: { 'Retry-After': '12' } }) }]);
  await assert.rejects(new AssinafyClient(credentials, m.runtime).get('/accounts'), error => {
    assert.equal(error.retryAfterSeconds, 12); assert.equal(error.safeToRetry, true);
    assert.equal(error.message.includes('test-secret'), false); assert.equal(error.message.includes('person@example.com'), false); return true;
  }); m.done();
});
for (const [label, response, error] of [
  ['network failure', undefined, new Error('test-secret')],
  ['server error', new Response('test-secret', { status: 500 }), undefined],
  ['invalid JSON', new Response('not json'), undefined],
  ['missing envelope', ok(null), undefined],
  ['redirect', new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }), undefined],
]) test(`write ${label} is indeterminate and never replayed`, async () => {
  const m = mock([{ response, error }]);
  await assert.rejects(new AssinafyClient(credentials, m.runtime).post('/documents', {}), e => {
    assert.equal(e.outcomeUnknown, true); assert.equal(e.safeToRetry, false); assert.equal(e.message.includes('test-secret'), false); return true;
  }); m.done();
});
test('resource redirects are blocked', async () => {
  const m = mock([{ response: new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }) }]);
  await assert.rejects(new AssinafyClient(credentials, m.runtime).get('/accounts'), hasCode('REDIRECT_BLOCKED')); m.done();
});
test('multipart helper sends bytes and lets the transport create the boundary', async () => {
  const m = mock([{ response: ok({ id: 'document1' }), async check(_, init) {
    assert.equal(init.headers['Content-Type'], undefined);
    assert.deepEqual(new Uint8Array(await init.body.get('file').arrayBuffer()), pdf().bytes);
  } }]);
  const form = new FormData(); form.set('file', new Blob([pdf().bytes], { type: 'application/pdf' }), 'test.pdf');
  await new AssinafyClient(credentials, m.runtime).upload('/accounts/workspace1/documents', form); m.done();
});
test('JSON and multipart writes need a usable created-resource ID', async () => {
  for (const data of [{}, { id: '' }, { id: 'bad/id' }, { id: 42 }, []]) {
    for (const method of ['post', 'upload']) {
      const m = mock([{ response: ok(data) }]);
      await assert.rejects(new AssinafyClient(credentials, m.runtime)[method]('/documents', method === 'upload' ? new FormData() : {}), hasCode('MUTATION_OUTCOME_UNKNOWN')); m.done();
    }
  }
});
test('artifact redirects require a trusted storage origin and strip API keys', async () => {
  const m = mock([{ response: new Response(null, { status: 302, headers: { Location: 'https://storage.example/file' } }) }]);
  await assert.rejects(new AssinafyClient(credentials, m.runtime).binary('/documents/d1/download/original'), hasCode('REDIRECT_BLOCKED')); m.done();
  const trusted = mock([{ response: new Response(null, { status: 302, headers: { Location: 'https://storage.example/file' } }) },
    { response: new Response(pdf().bytes), check(_, init) { assert.equal(init.headers['X-Api-Key'], undefined); assert.equal(init.headers.Authorization, undefined); } }]);
  assert.ok((await new AssinafyClient(credentials, { ...trusted.runtime, trustedDownloadOrigins: ['https://storage.example'] }).binary('/documents/d1/download/original')).length > 5); trusted.done();
});
test('private storage origins and oversized responses are rejected', async () => {
  for (const origin of ['http://storage.example', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://storage.example/path'])
    assert.throws(() => new AssinafyClient(credentials, { trustedDownloadOrigins: [origin] }), hasCode('INVALID_RUNTIME'));
  await assert.rejects(limitedBody(new Response('12345678901'), 10), hasCode('RESPONSE_TOO_LARGE'));
  await assert.rejects(limitedBody(new Response('test', { headers: { 'Content-Length': '9999' } }), 10), hasCode('RESPONSE_TOO_LARGE'));
});
