import type { AssinafyClient } from './client.js';
import { IntegrationError, invariant } from './errors.js';
import { id, record, validate } from './validation.js';
import type { Schema } from './validation.js';
import { contract } from './actions.js';

export interface Subscription {
  url: string | null;
  email: string | null;
  events: string[];
  is_active: boolean;
}
function validateWebhookUrl(value: unknown): void {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new IntegrationError('INVALID_INPUT', 'Webhook URL must be absolute HTTPS.'); }
  invariant(url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
    url.hostname.includes('.') && !url.hostname.includes(':') && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) &&
    !/(^|\.)(localhost|local|internal|test|example|invalid)$/.test(url.hostname), 'INVALID_INPUT', 'Use a public HTTPS webhook URL.');
}
async function validateEvents(client: AssinafyClient, events: string[]): Promise<void> {
  const catalog = await client.get<unknown>('/webhooks/event-types');
  invariant(Array.isArray(catalog) && catalog.every(row => record(row) && typeof row.id === 'string'), 'INVALID_RESPONSE', 'Unexpected event catalog.');
  invariant(events.every(event => catalog.some(row => row.id === event)), 'UNKNOWN_EVENT', 'An event is not in the live catalog.');
}

export async function getSubscription(client: AssinafyClient): Promise<Subscription | null> {
  const current = await client.get<unknown>(await client.accountPath('/webhooks/subscriptions'));
  if (current === null) return null;
  invariant(record(current) && (current.url === null || typeof current.url === 'string') &&
    (current.email === null || typeof current.email === 'string') &&
    Array.isArray(current.events) && current.events.every(event => typeof event === 'string') &&
    typeof current.is_active === 'boolean', 'INVALID_RESPONSE', 'Unexpected webhook subscription response.');
  return current as unknown as Subscription;
}

/** Initial setup only. A different existing destination must be handled explicitly in Assinafy. */
export async function registerSubscription(client: AssinafyClient, input: Subscription): Promise<Subscription> {
  invariant(record(input) && Object.keys(input).every(key => ['url', 'email', 'events', 'is_active'].includes(key)),
    'INVALID_INPUT', 'Unsupported subscription field.');
  validateWebhookUrl(input.url);
  invariant(typeof input.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email),
    'INVALID_INPUT', 'A notification email is required.');
  invariant(input.is_active === true, 'INVALID_INPUT', 'Setup requires an active subscription.');
  invariant(Array.isArray(input.events) && input.events.length > 0 &&
    input.events.every(event => typeof event === 'string') && new Set(input.events).size === input.events.length,
    'INVALID_INPUT', 'Choose distinct event codes.');
  const current = await getSubscription(client);
  if (current?.url) {
    const same = current.url === input.url && current.email === input.email && current.is_active === input.is_active &&
      current.events.length === input.events.length && current.events.every(event => input.events.includes(event));
    invariant(same, 'EXISTING_SUBSCRIPTION', 'This workspace already has a webhook configuration. Use a dedicated test workspace or review it in Assinafy before replacing it.');
    return current;
  }
  await validateEvents(client, input.events);
  const result = await client.envelope<Subscription>('PUT', await client.accountPath('/webhooks/subscriptions'), { json: input });
  invariant(record(result.data) && result.data.url === input.url && result.data.is_active === true &&
    result.data.email === input.email &&
    Array.isArray(result.data.events) && result.data.events.length === input.events.length &&
    input.events.every(event => result.data.events.includes(event)), 'INVALID_RESPONSE', 'The saved subscription differs from the request; inspect it before continuing.');
  return result.data;
}

const documentEvents = new Set([
  'document_uploaded', 'document_metadata_ready', 'document_prepared', 'assignment_created',
  'document_ready', 'signature_requested', 'signer_viewed_document', 'signer_signed_document',
  'signer_rejected_document', 'user_rejected_document', 'document_processing_failed',
  'signer_email_verified', 'signer_whatsapp_verified', 'signer_data_confirmed',
]);

/** Shapes the current Assinafy activity envelope. This does not authenticate a webhook or store deduplication state. */
export function normalizeEvent(input: unknown, accountId: string, webhookId?: string) {
  id(accountId, 'Workspace ID');
  invariant(record(input), 'INVALID_EVENT', 'Expected an event object.');
  invariant(input.account_id === accountId, 'WORKSPACE_ACCESS_DENIED', 'Webhook workspace does not match.');
  invariant(Number.isSafeInteger(input.id) && Number(input.id) > 0 && typeof input.event === 'string' &&
    /^[a-z][a-z0-9_]+$/.test(input.event) && Number.isSafeInteger(input.created_at) && Number(input.created_at) > 0,
    'INVALID_EVENT', 'Expected an activity ID, event code and Unix timestamp.');
  const object = record(input.object) ? input.object : {};
  if (documentEvents.has(input.event)) invariant(object.type === 'Document', 'INVALID_EVENT', 'Expected a Document event object.');
  if (webhookId !== undefined) invariant(typeof webhookId === 'string' && /^[\x21-\x7e]{1,256}$/.test(webhookId), 'INVALID_EVENT', 'Invalid webhook message ID.');
  if (object.account_id !== undefined) invariant(object.account_id === accountId, 'WORKSPACE_ACCESS_DENIED', 'Event object workspace does not match.');
  return {
    deduplication_key: `${accountId}:${webhookId ?? input.id}`,
    activity_id: Number(input.id),
    account_id: accountId,
    event: input.event,
    created_at: Number(input.created_at),
    ...(documentEvents.has(input.event) ? { document_id: id(object.id, 'Document ID') } : {}),
    ...(typeof object.status === 'string' ? { status: object.status } : {}),
  };
}

export interface WebhookEndpoint extends Subscription {
  id: string;
  url: string;
  email: string;
  name: string | null;
  signing_enabled: boolean;
  created_at: string;
  updated_at: string;
}
export interface WebhookEndpointInput {
  url: string;
  email: string;
  events: string[];
  name?: string;
  is_active?: boolean;
  signing_enabled?: boolean;
}
function endpoint(value: unknown): WebhookEndpoint {
  invariant(record(value) && typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.id) &&
    typeof value.url === 'string' && typeof value.email === 'string' && (value.name === null || typeof value.name === 'string') &&
    Array.isArray(value.events) && value.events.every(event => typeof event === 'string') &&
    typeof value.is_active === 'boolean' && typeof value.signing_enabled === 'boolean' &&
    typeof value.created_at === 'string' && typeof value.updated_at === 'string',
  'INVALID_RESPONSE', 'Unexpected webhook endpoint response.');
  return value as unknown as WebhookEndpoint;
}
async function validateEndpointInput(client: AssinafyClient, input: unknown, schema: Schema): Promise<void> {
  validate(input, schema, contract.schemas as Record<string, Schema>);
  invariant(record(input), 'INVALID_INPUT', 'Expected endpoint configuration.');
  if (input.url !== undefined) validateWebhookUrl(input.url);
  if (input.events !== undefined) {
    const events = input.events as string[];
    invariant(events.length > 0 && new Set(events).size === events.length, 'INVALID_INPUT', 'Choose distinct event codes.');
    await validateEvents(client, events);
  }
}
export async function listWebhookEndpoints(client: AssinafyClient): Promise<WebhookEndpoint[]> {
  const rows = await client.get<unknown>(await client.accountPath('/webhooks/endpoints'));
  invariant(Array.isArray(rows), 'INVALID_RESPONSE', 'Expected a webhook endpoint list.');
  return rows.map(endpoint);
}
export async function registerWebhookEndpoint(client: AssinafyClient, input: WebhookEndpointInput): Promise<WebhookEndpoint> {
  await validateEndpointInput(client, input, contract.webhookEndpointInput as Schema);
  const rows = await listWebhookEndpoints(client);
  const current = rows.find(row => row.url === input.url);
  if (current) {
    invariant(current.email === input.email && current.name === (input.name ?? null) &&
      current.is_active === (input.is_active ?? true) && current.signing_enabled === (input.signing_enabled ?? false) &&
      current.events.length === input.events.length && current.events.every(event => input.events.includes(event)),
    'EXISTING_SUBSCRIPTION', 'This URL already has different settings. Update its endpoint explicitly.');
    return current;
  }
  const result = endpoint(await client.post(await client.accountPath('/webhooks/endpoints'), input));
  invariant(result.url === input.url && result.email === input.email && result.name === (input.name ?? null) &&
    result.is_active === (input.is_active ?? true) && result.signing_enabled === (input.signing_enabled ?? false) &&
    result.events.length === input.events.length && result.events.every(event => input.events.includes(event)),
  'INVALID_RESPONSE', 'The saved endpoint differs from the request; inspect it before continuing.');
  return result;
}
export async function updateWebhookEndpoint(client: AssinafyClient, endpointId: string, input: Partial<WebhookEndpointInput>): Promise<WebhookEndpoint> {
  id(endpointId, 'Endpoint ID');
  await validateEndpointInput(client, input, contract.webhookEndpointUpdateInput as Schema);
  const result = endpoint((await client.envelope('PUT', await client.accountPath(`/webhooks/endpoints/${endpointId}`), { json: input })).data);
  invariant(result.id === endpointId && Object.entries(input).every(([key, value]) => key === 'events' ?
    result.events.length === (value as string[]).length && result.events.every(event => (value as string[]).includes(event)) :
    result[key as keyof WebhookEndpoint] === value), 'INVALID_RESPONSE', 'The saved endpoint differs from the request; inspect it before continuing.');
  return result;
}
export async function deleteWebhookEndpoint(client: AssinafyClient, endpointId: string): Promise<void> {
  const { data } = await client.envelope('DELETE', await client.accountPath(`/webhooks/endpoints/${id(endpointId, 'Endpoint ID')}`));
  invariant(Array.isArray(data) && data.length === 0, 'INVALID_RESPONSE', 'Unexpected endpoint deletion response.');
}
export async function getWebhookSecret(client: AssinafyClient, endpointId: string, rotate = false): Promise<string> {
  const suffix = `/webhooks/endpoints/${id(endpointId, 'Endpoint ID')}/secret${rotate ? '/rotate' : ''}`;
  const { data } = await client.envelope(rotate ? 'POST' : 'GET', await client.accountPath(suffix));
  invariant(record(data) && typeof data.secret === 'string' && /^whsec_[A-Za-z0-9+/]+={0,2}$/.test(data.secret),
    'INVALID_RESPONSE', 'Unexpected webhook signing secret.');
  return data.secret;
}

/** Verify the unchanged UTF-8 body before parsing it or using any event fields. */
export async function verifyWebhookSignature(rawBody: string, headers: Headers, secret: string, now = Date.now()): Promise<void> {
  invariant(typeof secret === 'string' && /^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret), 'INVALID_CREDENTIALS', 'Expected a Standard Webhooks signing secret.');
  invariant(typeof rawBody === 'string' && Number.isFinite(now), 'INVALID_INPUT', 'Expected raw UTF-8 body and current time in milliseconds.');
  const messageId = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatures = headers.get('webhook-signature');
  invariant(messageId && /^[\x21-\x7e]{1,256}$/.test(messageId) && timestamp && /^\d+$/.test(timestamp) &&
    Number.isSafeInteger(Number(timestamp)) && Math.abs(now / 1000 - Number(timestamp)) <= 300 && signatures,
  'INVALID_WEBHOOK_SIGNATURE', 'Missing or stale webhook signature headers.');
  let keyBytes: Uint8Array<ArrayBuffer>;
  try { keyBytes = Uint8Array.from(atob(secret.slice(6)), char => char.charCodeAt(0)); }
  catch { throw new IntegrationError('INVALID_CREDENTIALS', 'Invalid webhook signing secret encoding.'); }
  invariant(keyBytes.length > 0, 'INVALID_CREDENTIALS', 'Empty webhook signing secret.');
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const content = new TextEncoder().encode(`${messageId}.${timestamp}.${rawBody}`);
  for (const candidate of signatures.split(' ')) {
    if (!/^v1,[A-Za-z0-9+/]+={0,2}$/.test(candidate)) continue;
    let bytes: Uint8Array<ArrayBuffer>;
    try { bytes = Uint8Array.from(atob(candidate.slice(3)), char => char.charCodeAt(0)); } catch { continue; }
    if (bytes.length === 32 && await crypto.subtle.verify('HMAC', key, bytes, content)) return;
  }
  throw new IntegrationError('INVALID_WEBHOOK_SIGNATURE', 'Webhook signature does not match the raw body.');
}
