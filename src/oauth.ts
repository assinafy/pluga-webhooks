import { API_URLS, limitedBody } from './client.js';
import { IntegrationError, invariant } from './errors.js';
import { record } from './validation.js';
import type { Environment, Runtime } from './types.js';

const ISSUERS = { production: 'https://auth.assinafy.com.br', sandbox: 'https://auth-sandbox.assinafy.com.br' };
export interface OAuthApplication { clientId: string; clientSecret?: string; environment?: Environment }
export interface OAuthSession extends OAuthApplication {
  redirectUri: string;
  state: string;
  codeVerifier: string;
  issuer: string;
  url: string;
}
export interface OAuthTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  refresh_token?: string | null;
  id_token?: string | null;
}
function environment(application: OAuthApplication): Environment {
  invariant(record(application) && typeof application.clientId === 'string' && application.clientId.trim() &&
    (application.clientSecret === undefined || (typeof application.clientSecret === 'string' && application.clientSecret.length > 0)),
  'INVALID_CREDENTIALS', 'An OAuth client ID and valid optional secret are required.');
  const env = application.environment ?? 'production';
  invariant(Object.hasOwn(API_URLS, env), 'INVALID_ENVIRONMENT', 'Choose production or sandbox.');
  return env;
}
function redirect(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new IntegrationError('INVALID_INPUT', 'Use a registered HTTPS redirect URI.'); }
  invariant(url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
    !['state', 'iss', 'code', 'error'].some(key => url.searchParams.has(key)),
    'INVALID_INPUT', 'Use a registered HTTPS callback without OAuth response parameters or fragment.');
  return url;
}
async function request(url: string, runtime: Runtime, fields?: Record<string, string>, empty = false): Promise<unknown> {
  invariant(runtime.timeoutMs === undefined || (Number.isInteger(runtime.timeoutMs) && runtime.timeoutMs > 0 && runtime.timeoutMs <= 120_000),
    'INVALID_RUNTIME', 'Timeout must be between 1 and 120000 milliseconds.');
  let response: Response;
  try {
    response = await (runtime.fetch ?? globalThis.fetch)(url, {
      method: fields ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(runtime.timeoutMs ?? 30_000),
      headers: { Accept: 'application/json', ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(fields ? { body: new URLSearchParams(fields) } : {}),
    });
  } catch {
    throw new IntegrationError(fields ? 'OAUTH_OUTCOME_UNKNOWN' : 'TRANSPORT_ERROR',
      fields ? 'The OAuth exchange may have completed. Do not replay a code or rotating refresh token; reconcile or reconnect.' : 'OAuth discovery failed.',
      { outcomeUnknown: Boolean(fields), safeToRetry: !fields });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new IntegrationError(fields && response.status >= 500 ? 'OAUTH_OUTCOME_UNKNOWN' : 'OAUTH_ERROR',
      `OAuth returned HTTP ${response.status}. Reconnect if the grant is expired or invalid.`,
      { httpStatus: response.status, outcomeUnknown: Boolean(fields && response.status >= 500), safeToRetry: !fields && response.status >= 500 });
  }
  if (empty) { await response.body?.cancel().catch(() => {}); return undefined; }
  try { return JSON.parse(new TextDecoder().decode(await limitedBody(response, 1024 * 1024))); }
  catch { throw new IntegrationError(fields ? 'OAUTH_OUTCOME_UNKNOWN' : 'INVALID_RESPONSE', 'OAuth returned an unreadable response.', { outcomeUnknown: Boolean(fields) }); }
}
async function discovery(env: Environment, runtime: Runtime) {
  const metadata = await request(`${ISSUERS[env]}/.well-known/oauth-authorization-server`, runtime);
  const base = API_URLS[env];
  invariant(record(metadata) && metadata.issuer === ISSUERS[env] &&
    metadata.authorization_endpoint === `${ISSUERS[env]}/oauth/authorize` &&
    metadata.token_endpoint === `${base}/oauth/token` && metadata.revocation_endpoint === `${base}/oauth/revoke`,
  'INVALID_RESPONSE', 'OAuth discovery does not match the selected Assinafy environment.');
  return metadata;
}
function tokens(value: unknown): OAuthTokens {
  const valid = record(value) && typeof value.access_token === 'string' && value.access_token.length > 0 && !/[\s\x00-\x1f\x7f]/.test(value.access_token) &&
    value.token_type === 'Bearer' && Number.isSafeInteger(value.expires_in) && Number(value.expires_in) > 0 && typeof value.scope === 'string' &&
    (value.refresh_token === undefined || value.refresh_token === null || typeof value.refresh_token === 'string' && value.refresh_token.length > 0) &&
    (value.id_token === undefined || value.id_token === null || typeof value.id_token === 'string' && value.id_token.length > 0);
  if (!valid) throw new IntegrationError('OAUTH_OUTCOME_UNKNOWN', 'The OAuth token response is incomplete; reconnect before repeating the exchange.', { outcomeUnknown: true });
  return value as unknown as OAuthTokens;
}
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export async function createOAuthAuthorization(application: OAuthApplication & { redirectUri: string; scopes: readonly string[] }, runtime: Runtime = {}): Promise<OAuthSession> {
  const env = environment(application);
  redirect(application.redirectUri);
  const metadata = await discovery(env, runtime);
  const supported = metadata.scopes_supported;
  invariant(Array.isArray(application.scopes) && application.scopes.length > 0 && Array.isArray(supported) &&
    application.scopes.every(scope => typeof scope === 'string' && supported.includes(scope)) &&
    new Set(application.scopes).size === application.scopes.length, 'INVALID_INPUT', 'Request distinct scopes advertised by OAuth discovery.');
  const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))));
  const url = new URL(String(metadata.authorization_endpoint));
  url.search = new URLSearchParams({ response_type: 'code', client_id: application.clientId, redirect_uri: application.redirectUri,
    scope: application.scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', resource: new URL(API_URLS[env]).origin }).toString();
  return { clientId: application.clientId, environment: env, redirectUri: application.redirectUri, state, codeVerifier, issuer: ISSUERS[env], url: url.toString() };
}
export async function exchangeOAuthCode(session: OAuthSession, callbackUrl: string, clientSecret?: string, runtime: Runtime = {}): Promise<OAuthTokens> {
  const env = environment(session);
  const expected = redirect(session.redirectUri);
  let callback: URL;
  try { callback = new URL(callbackUrl); } catch { throw new IntegrationError('INVALID_OAUTH_CALLBACK', 'Invalid OAuth callback URL.'); }
  invariant(callback.origin === expected.origin && callback.pathname === expected.pathname && !callback.username && !callback.password && !callback.hash &&
    [...expected.searchParams.keys()].every(key => JSON.stringify(callback.searchParams.getAll(key)) === JSON.stringify(expected.searchParams.getAll(key))) &&
    session.issuer === ISSUERS[env] && typeof session.state === 'string' && session.state.length >= 16 &&
    ['state', 'iss', 'code', 'error'].every(key => callback.searchParams.getAll(key).length <= 1) &&
    callback.searchParams.get('state') === session.state && callback.searchParams.get('iss') === session.issuer,
  'INVALID_OAUTH_CALLBACK', 'OAuth callback address, state or issuer does not match this session.');
  invariant(!callback.searchParams.has('error'), 'OAUTH_DENIED', 'OAuth authorization was declined or rejected.');
  const code = callback.searchParams.get('code');
  invariant(code && /^[A-Za-z0-9._~-]{43,128}$/.test(session.codeVerifier), 'INVALID_OAUTH_CALLBACK', 'A code and valid PKCE verifier are required.');
  const app = { clientId: session.clientId, ...(clientSecret === undefined ? {} : { clientSecret }), environment: env };
  environment(app);
  return tokens(await request(`${API_URLS[env]}/oauth/token`, runtime, {
    grant_type: 'authorization_code', client_id: app.clientId, code, redirect_uri: session.redirectUri,
    code_verifier: session.codeVerifier, resource: new URL(API_URLS[env]).origin, ...(clientSecret ? { client_secret: clientSecret } : {}),
  }));
}
export async function refreshOAuthToken(application: OAuthApplication, refreshToken: string, runtime: Runtime = {}): Promise<OAuthTokens> {
  const env = environment(application);
  invariant(typeof refreshToken === 'string' && refreshToken.length > 0, 'INVALID_CREDENTIALS', 'A refresh token is required.');
  const metadata = await discovery(env, runtime);
  return tokens(await request(String(metadata.token_endpoint), runtime, { grant_type: 'refresh_token', client_id: application.clientId,
    refresh_token: refreshToken, ...(application.clientSecret ? { client_secret: application.clientSecret } : {}) }));
}
export async function revokeOAuthToken(application: OAuthApplication, token: string, runtime: Runtime = {}): Promise<void> {
  const env = environment(application);
  invariant(typeof token === 'string' && token.length > 0, 'INVALID_CREDENTIALS', 'A token is required.');
  const metadata = await discovery(env, runtime);
  await request(String(metadata.revocation_endpoint), runtime, { client_id: application.clientId, token,
    ...(application.clientSecret ? { client_secret: application.clientSecret } : {}) }, true);
}
