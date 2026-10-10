import { IntegrationError, invariant, unknownWriteOutcome } from './errors.js';
import { id, record } from './validation.js';
import type { Account, Credentials, Environment, Runtime } from './types.js';

export const API_URLS = Object.freeze({
  production: 'https://api.assinafy.com.br/v1',
  sandbox: 'https://sandbox.assinafy.com.br/v1',
});
type Query = Record<string, string | number | undefined>;
interface RequestOptions { query?: Query; json?: unknown; form?: FormData }
const HINTS: Record<number, string> = {
  400: 'Assinafy rejected the request.', 401: 'Reconnect Assinafy.',
  403: 'Check connection permissions, OAuth scopes and workspace access.', 404: 'The resource was not found.',
  409: 'The request conflicts with an existing resource.', 422: 'Assinafy rejected the field values.',
  429: 'The rate limit was reached. Wait before retrying.',
};

export class AssinafyClient {
  readonly baseUrl: string;
  readonly environment: Environment;
  readonly runtime: Runtime;
  readonly #fetch: typeof globalThis.fetch;
  readonly #headers: Record<string, string>;
  readonly #selectedAccount: string | undefined;
  #workspace: Promise<Account> | undefined;
  constructor(credentials: Credentials, runtime: Runtime = {}) {
    invariant(record(credentials), 'INVALID_CREDENTIALS', 'An Assinafy connection is required.');
    invariant(credentials.type === 'api_key' || credentials.type === 'oauth2', 'INVALID_CREDENTIALS', 'An API key or OAuth2 connection is required.');
    this.environment = credentials.environment ?? 'production';
    invariant(Object.hasOwn(API_URLS, this.environment), 'INVALID_ENVIRONMENT', 'Choose production or sandbox.');
    this.baseUrl = API_URLS[this.environment];
    const secret = credentials.type === 'api_key' ? credentials.apiKey : credentials.accessToken;
    invariant(typeof secret === 'string' && secret.length > 0 && !/[\s\x00-\x1f\x7f]/.test(secret),
      'INVALID_CREDENTIALS', 'The connection secret is empty or contains whitespace.');
    this.#headers = credentials.type === 'api_key' ? { 'X-Api-Key': secret } : { Authorization: `Bearer ${secret}` };
    this.#selectedAccount = id(credentials.accountId, 'Workspace ID');
    this.runtime = Object.freeze({ ...runtime, ...(runtime.trustedDownloadOrigins ? { trustedDownloadOrigins: Object.freeze([...runtime.trustedDownloadOrigins]) } : {}) });
    this.#fetch = runtime.fetch ?? globalThis.fetch;
    invariant(typeof this.#fetch === 'function', 'MISSING_CAPABILITY', 'An HTTP transport is required.');
    invariant(runtime.timeoutMs === undefined || (Number.isInteger(runtime.timeoutMs) && runtime.timeoutMs > 0 && runtime.timeoutMs <= 120_000),
      'INVALID_RUNTIME', 'Timeout must be between 1 and 120000 milliseconds.');
    invariant(runtime.maxPages === undefined || (Number.isInteger(runtime.maxPages) && runtime.maxPages > 0 && runtime.maxPages <= 1000),
      'INVALID_RUNTIME', 'maxPages must be between 1 and 1000.');
    invariant(runtime.maxDownloadBytes === undefined || (Number.isSafeInteger(runtime.maxDownloadBytes) && runtime.maxDownloadBytes > 0),
      'INVALID_RUNTIME', 'maxDownloadBytes must be a positive integer.');
    for (const origin of runtime.trustedDownloadOrigins ?? []) validateExternalOrigin(origin);
  }
  #url(path: string, query?: Query): string {
    invariant(/^\/(accounts|documents|webhooks)(\/|$)/.test(path) && !/[?#\\]/.test(path) && !/%|\/\.|\/\//.test(path),
      'UNSAFE_PATH', 'Only application resource paths are accepted.');
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
  async #send(url: string, method: string, options: RequestOptions = {}, authenticated = true, binary = false): Promise<Response> {
    // Assinafy negotiates JSON before the download handler sends binary bytes.
    const headers: Record<string, string> = { Accept: binary ? 'application/json, application/pdf, application/zip, application/octet-stream' : 'application/json', ...(authenticated ? this.#headers : {}) };
    const init: RequestInit = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(this.runtime.timeoutMs ?? 30_000) };
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.json);
    }
    if (options.form !== undefined) init.body = options.form;
    let response: Response;
    try { response = await this.#fetch(url, init); }
    catch {
      if (method !== 'GET') throw unknownWriteOutcome();
      throw new IntegrationError('TRANSPORT_ERROR', 'The Assinafy read request failed or timed out.', { safeToRetry: true });
    }
    if (response.status >= 300 && response.status < 400) return response;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (method !== 'GET' && response.status >= 500) throw unknownWriteOutcome();
      const retry = Number(response.headers.get('retry-after'));
      throw new IntegrationError('API_ERROR', HINTS[response.status] ?? `Assinafy returned HTTP ${response.status}.`, {
        httpStatus: response.status,
        safeToRetry: method === 'GET' && (response.status === 429 || response.status >= 500),
        ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
      });
    }
    return response;
  }
  async envelope<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', path: string, options: RequestOptions = {}): Promise<{ data: T; headers: Headers }> {
    const response = await this.#send(this.#url(path, options.query), method, options);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      if (method !== 'GET') throw unknownWriteOutcome();
      throw new IntegrationError('REDIRECT_BLOCKED', 'Resource API redirects are not followed.');
    }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(await limitedBody(response, 8 * 1024 * 1024))); }
    catch (error) {
      if (method !== 'GET') throw unknownWriteOutcome();
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError('INVALID_RESPONSE', 'Assinafy returned invalid JSON.', { safeToRetry: true });
    }
    if (!record(body) || !('data' in body) || (body.data === null && !path.endsWith('/webhooks/subscriptions')) || body.data === undefined ||
      body.status !== response.status) {
      if (method !== 'GET') throw unknownWriteOutcome();
      throw new IntegrationError('INVALID_RESPONSE', 'Assinafy returned an unexpected response envelope.');
    }
    return { data: body.data as T, headers: response.headers };
  }
  async get<T>(path: string, query?: Query): Promise<T> {
    return (await this.envelope<T>('GET', path, query ? { query } : {})).data;
  }
  async post<T>(path: string, json: unknown): Promise<T> {
    return this.#created<T>(path, { json });
  }
  async upload<T>(path: string, form: FormData): Promise<T> {
    return this.#created<T>(path, { form });
  }
  async #created<T>(path: string, options: RequestOptions): Promise<T> {
    const { data } = await this.envelope<T>('POST', path, options);
    if (!record(data)) throw unknownWriteOutcome();
    try { id(data.id, 'Created resource ID'); } catch { throw unknownWriteOutcome(); }
    return data;
  }
  async list<T extends { id: string | number }>(path: string, query: Query = {}): Promise<T[]> {
    const result = new Map<string | number, T>();
    const signatures = new Set<string>();
    const maxPages = this.runtime.maxPages ?? 20;
    for (let page = 1; page <= maxPages; page++) {
      const { data: rows, headers } = await this.envelope<T[]>('GET', path,
        { query: { ...query, page, 'per-page': 50 } });
      invariant(Array.isArray(rows), 'INVALID_RESPONSE', 'Assinafy did not return a list.');
      for (const row of rows) invariant(record(row) && (typeof row.id === 'string' ? /^[A-Za-z0-9_-]{1,128}$/.test(row.id) :
        Number.isSafeInteger(row.id) && Number(row.id) > 0), 'INVALID_RESPONSE', 'A list entry has no valid identifier.');
      const rawPages = headers.get('x-pagination-page-count');
      const pages = rawPages === null ? undefined : Number(rawPages);
      if (pages !== undefined) invariant(Number.isInteger(pages) && pages >= 0, 'INVALID_RESPONSE', 'Invalid pagination metadata.');
      invariant(pages !== 0 || rows.length === 0, 'PAGINATION_INCONSISTENT', 'Records were returned for an empty pagination range.');
      const signature = JSON.stringify(rows.map(row => row.id));
      const repeated = signatures.has(signature);
      // Some deployments repeat the final page when requesting beyond the end.
      if (repeated) {
        invariant(pages === undefined || page > pages, 'PAGINATION_INCONSISTENT',
          'The API repeated a page before the reported end. Refusing an incomplete lookup.');
        return [...result.values()];
      }
      signatures.add(signature);
      for (const row of rows) result.set(row.id, row);
      if (pages !== undefined ? page >= pages : rows.length < 50) return [...result.values()];
      invariant(rows.length > 0, 'PAGINATION_INCONSISTENT', 'An empty page appeared before the reported end.');
    }
    throw new IntegrationError('PAGINATION_LIMIT', 'The lookup exceeded its page budget. No incomplete result will be used to create or send a document.');
  }
  async workspace(): Promise<Account> {
    if (!this.#workspace) {
      this.#workspace = this.list<Account>('/accounts').then(accounts => {
        if (this.#selectedAccount) {
          const account = accounts.find(row => row.id === this.#selectedAccount);
          invariant(account, 'WORKSPACE_ACCESS_DENIED', 'The selected workspace is not accessible to this connection.');
          return account;
        }
        invariant(accounts.length === 1, 'WORKSPACE_REQUIRED', 'Select a workspace explicitly when the connection does not expose exactly one workspace.');
        return accounts[0]!;
      }).catch(error => { this.#workspace = undefined; throw error; });
    }
    return this.#workspace;
  }
  async accountPath(suffix: string): Promise<string> {
    return `/accounts/${id((await this.workspace()).id, 'Workspace ID')}${suffix}`;
  }
  async binary(path: string): Promise<Uint8Array> {
    let url = this.#url(path);
    const apiOrigin = new URL(this.baseUrl).origin;
    const trusted = new Set(this.runtime.trustedDownloadOrigins ?? []);
    for (let hop = 0; hop <= 3; hop++) {
      const response = await this.#send(url, 'GET', {}, new URL(url).origin === apiOrigin, true);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        invariant(location, 'REDIRECT_BLOCKED', 'The download redirect has no destination.');
        let next: URL;
        try { next = new URL(location, url); } catch { throw new IntegrationError('REDIRECT_BLOCKED', 'Invalid file-download redirect destination.'); }
        invariant(next.protocol === 'https:' && !next.username && !next.password && !next.hash,
          'REDIRECT_BLOCKED', 'Only HTTPS download redirects without embedded credentials are allowed.');
        const same = next.origin === apiOrigin;
        invariant(same ? next.pathname.startsWith('/v1/') : trusted.has(next.origin),
          'REDIRECT_BLOCKED', 'Configure the trusted file-storage origin in the deployment before following this download redirect.');
        url = next.toString();
        continue;
      }
      const type = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (type.includes('json') || type.includes('text/html')) {
        await response.body?.cancel().catch(() => {});
        throw new IntegrationError('INVALID_FILE_RESPONSE', 'The download endpoint returned an error page instead of file bytes.');
      }
      try { return await limitedBody(response, this.runtime.maxDownloadBytes ?? 50 * 1024 * 1024); }
      catch (error) {
        if (error instanceof IntegrationError) throw error;
        throw new IntegrationError('TRANSPORT_ERROR', 'The file read failed or timed out.', { safeToRetry: true });
      }
    }
    throw new IntegrationError('REDIRECT_BLOCKED', 'Too many file-download redirects.');
  }
}
function validateExternalOrigin(origin: string): void {
  let url: URL;
  try { url = new URL(origin); } catch { throw new IntegrationError('INVALID_RUNTIME', 'Invalid trusted storage origin.'); }
  invariant(url.origin === origin && url.protocol === 'https:' && !url.username && !url.password &&
    !url.hostname.includes(':') && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) &&
    !/(^|\.)(localhost|local|internal)$/.test(url.hostname),
    'INVALID_RUNTIME', 'Trusted storage must be an exact HTTPS origin on a public hostname.');
}
export async function limitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new IntegrationError('RESPONSE_TOO_LARGE', 'Response exceeded the configured byte limit.');
  }
  invariant(response.body, 'INVALID_RESPONSE', 'The response body is missing.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new IntegrationError('RESPONSE_TOO_LARGE', 'Response exceeded the configured byte limit.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
