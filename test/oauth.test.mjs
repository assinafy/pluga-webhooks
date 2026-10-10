import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOAuthAuthorization, exchangeOAuthCode, refreshOAuthToken, revokeOAuthToken, AssinafyClient } from '../dist/index.js';
import { mock, ok, account, hasCode } from './helpers.mjs';
const app = { clientId: 'test-client', environment: 'production' };
const metadata = { issuer: 'https://auth.assinafy.com.br', authorization_endpoint: 'https://auth.assinafy.com.br/oauth/authorize',
  token_endpoint: 'https://api.assinafy.com.br/v1/oauth/token', revocation_endpoint: 'https://api.assinafy.com.br/v1/oauth/revoke',
  scopes_supported: ['account:read', 'documents:read', 'offline_access'] };
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const token = { access_token: 'access-test', token_type: 'Bearer', expires_in: 3600, scope: 'account:read', refresh_token: 'refresh-test' };
const session = { ...app, issuer: metadata.issuer, redirectUri: 'https://callback.example.com/oauth', state: 'state-test-123456789', codeVerifier: 'x'.repeat(43), url: '' };
const callback = changes => { const url = new URL(session.redirectUri); url.search = new URLSearchParams({ state: session.state, iss: session.issuer, code: 'code-test', ...changes }); return url.href; };

test('authorization uses discovery, random per-session state and an S256 PKCE challenge', async () => {
  const m = mock([{ response: response(metadata), check(url, init) { assert.equal(url.href, `${metadata.issuer}/.well-known/oauth-authorization-server`); assert.equal(init.headers.Authorization, undefined); } },
    { response: response(metadata) }]);
  const args = { ...app, redirectUri: session.redirectUri, scopes: ['account:read', 'offline_access'] };
  const first = await createOAuthAuthorization(args, m.runtime);
  const second = await createOAuthAuthorization(args, m.runtime);
  assert.notEqual(first.state, second.state); assert.notEqual(first.codeVerifier, second.codeVerifier);
  assert.match(first.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  const url = new URL(first.url);
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(first.codeVerifier).digest('base64url'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('resource'), 'https://api.assinafy.com.br');
  assert.equal(first.clientSecret, undefined); m.done();
});
test('sandbox authorization never uses production hosts', async () => {
  const sandbox = Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, typeof value === 'string' ? value.replace('auth.assinafy', 'auth-sandbox.assinafy').replace('api.assinafy', 'sandbox.assinafy') : value]));
  const m = mock([{ response: response(sandbox), check(url) { assert.equal(url.hostname, 'auth-sandbox.assinafy.com.br'); } }]);
  const result = await createOAuthAuthorization({ ...app, environment: 'sandbox', redirectUri: session.redirectUri, scopes: ['account:read'] }, m.runtime);
  assert.equal(new URL(result.url).searchParams.get('resource'), 'https://sandbox.assinafy.com.br'); m.done();
});
test('OAuth code exchange sends form encoding and returns the unwrapped token response', async () => {
  const m = mock([{ response: response(token), check(url, init) {
    assert.equal(url.href, metadata.token_endpoint); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(init.body.get('code_verifier'), session.codeVerifier); assert.equal(init.body.get('client_secret'), 'client-secret');
    assert.equal(init.headers['X-Api-Key'], undefined);
  } }]);
  assert.deepEqual(await exchangeOAuthCode(session, callback(), 'client-secret', m.runtime), token); m.done();
});
test('callback injection, duplicate state, issuer mismatch, denial and malformed PKCE never exchange tokens', async () => {
  const m = mock([]);
  for (const url of [callback({ state: 'wrong' }), callback({ iss: 'https://evil.example' }), callback({ error: 'access_denied' }),
    callback({ code: '' }), callback() + '&state=duplicate', callback().replace('callback.example.com', 'evil.example')]) {
    await assert.rejects(exchangeOAuthCode(session, url, undefined, m.runtime));
  }
  await assert.rejects(exchangeOAuthCode({ ...session, codeVerifier: 'short' }, callback(), undefined, m.runtime)); m.done();
});
test('discovery injection and unavailable scopes never start authorization', async () => {
  for (const changes of [{ issuer: 'https://evil.example' }, { token_endpoint: 'https://evil.example/token' }]) {
    const m = mock([{ response: response({ ...metadata, ...changes }) }]);
    await assert.rejects(createOAuthAuthorization({ ...app, redirectUri: session.redirectUri, scopes: ['account:read'] }, m.runtime), hasCode('INVALID_RESPONSE')); m.done();
  }
  const m = mock([{ response: response(metadata) }]);
  await assert.rejects(createOAuthAuthorization({ ...app, redirectUri: session.redirectUri, scopes: ['admin'] }, m.runtime), hasCode('INVALID_INPUT')); m.done();
});
test('refresh sends each token once and preserves the newly rotated token', async () => {
  const rotated = { ...token, refresh_token: 'new-refresh' };
  const m = mock([{ response: response(metadata) }, { response: response(rotated), check(_, init) {
    assert.equal(init.body.get('grant_type'), 'refresh_token'); assert.equal(init.body.get('refresh_token'), 'refresh-test'); assert.equal(init.body.has('client_secret'), false);
  } }]);
  assert.deepEqual(await refreshOAuthToken(app, 'refresh-test', m.runtime), rotated); m.done();
});
test('revocation accepts the documented empty HTTP 200 response', async () => {
  const m = mock([{ response: response(metadata) }, { response: new Response(null), check(_, init) { assert.equal(init.body.get('token'), 'refresh-test'); } }]);
  await revokeOAuthToken(app, 'refresh-test', m.runtime); m.done();
});
test('incomplete tokens and rejected clients are never marked safe for automatic replay', async () => {
  for (const data of [{}, { ...token, token_type: 'MAC' }, { ...token, expires_in: 0 }]) {
    const m = mock([{ response: response(data) }]);
    await assert.rejects(exchangeOAuthCode(session, callback(), undefined, m.runtime), e => e.code === 'OAUTH_OUTCOME_UNKNOWN' && e.outcomeUnknown && !e.safeToRetry); m.done();
  }
  const m = mock([{ response: new Response('private-client-secret', { status: 401 }) }]);
  await assert.rejects(exchangeOAuthCode(session, callback(), undefined, m.runtime), e => e.code === 'OAUTH_ERROR' && e.httpStatus === 401 && !e.message.includes('private-client-secret')); m.done();
});
for (const [label, step] of [['timeout', { error: new Error('private-token') }], ['server error', { response: new Response('private-token', { status: 500 }) }], ['invalid JSON', { response: new Response('private-token') }]]) {
  test(`OAuth ${label} does not replay a single-use grant`, async () => {
    const m = mock([step]);
    await assert.rejects(exchangeOAuthCode(session, callback(), undefined, m.runtime), error => {
      assert.equal(error.outcomeUnknown, true); assert.equal(error.safeToRetry, false); assert.equal(error.message.includes('private-token'), false); return true;
    }); m.done();
  });
}
test('OAuth API credentials use only Bearer and still check workspace membership', async () => {
  const m = mock([{ response: ok([account]), check(_, init) { assert.equal(init.headers.Authorization, 'Bearer access-test'); assert.equal(init.headers['X-Api-Key'], undefined); } }]);
  assert.equal((await new AssinafyClient({ type: 'oauth2', accessToken: token.access_token, accountId: account.id }, m.runtime).workspace()).id, account.id); m.done();
});
