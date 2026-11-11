import type { AssinafyClient } from './client.js';
import { contract } from './actions.js';
import { invariant } from './errors.js';
import { ID_PATTERN, id, record, validate } from './validation.js';
import type { Schema } from './validation.js';
import type { Resource } from './types.js';

export interface ContractInput {
  status?: 'draft' | 'active' | 'expired' | 'terminated';
  counterparty_name?: string | null;
  counterparty_taxpayer_id?: string | null;
  value?: number | null;
  currency?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  auto_renew?: boolean;
  renewal_term_months?: number | null;
  notice_period_days?: number | null;
  owner_id?: string | null;
  metadata?: Record<string, string> | null;
  external_references?: { system: string; id: string }[] | null;
  parent_document_id?: string | null;
  relation_type?: 'amendment' | 'renewal' | 'termination';
  updated_at?: string;
}
export interface ContractRenewal { end_date?: string | null; value?: number | null; term?: number; updated_at?: string }
export interface ContractTermination { reason?: string | null; updated_at?: string }
export interface ContractFilters {
  status?: string;
  counterparty?: string;
  search?: string;
  end_date_from?: string;
  end_date_to?: string;
  ending_within_days?: number;
  external_system?: string;
  external_id?: string;
  sort?: 'end_date' | '-end_date' | 'updated_at' | '-updated_at';
  expand?: 'document';
}
export interface DocumentContract extends Record<string, unknown> {
  resource?: 'document_contract';
  document_id: string;
  status: 'draft' | 'active' | 'expired' | 'terminated';
  counterparty_name: string | null;
  counterparty_taxpayer_id: string | null;
  value: number | null;
  currency: string | null;
  start_date: string | null;
  end_date: string | null;
  auto_renew: boolean;
  renewal_term_months: number | null;
  notice_period_days: number | null;
  term: number;
  owner_id: string | null;
  metadata: Record<string, string> | null;
  external_references: { system: string; id: string }[];
  document?: Resource;
  amendments?: DocumentContractAmendment[];
  created_at: string;
  updated_at: string;
}
export interface DocumentContractAmendment extends Record<string, unknown> {
  resource?: 'document_contract_amendment';
  document_id: string;
  document_name: string;
  parent_document_id: string;
  relation_type: 'amendment' | 'renewal' | 'termination';
  number: number | null;
  status: 'pending' | 'applied';
  document_status: string;
  apply_error: string | null;
  currency: string | null;
  terms: Record<string, unknown> | null;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
}
const base = '/accounts/{accountId}/documents/{documentId}/contract';
const schemas = contract.schemas as Record<string, Schema>;
const operations = contract.operations as { method: string; path: string; requestBody: { content: { 'application/json': { schema: Schema } } } | null;
  parameters: { name: string; in: string; schema: Schema }[] }[];

function result(value: unknown, documentId?: string, writing = false): DocumentContract | DocumentContractAmendment {
  invariant(record(value) && ['document_contract', 'document_contract_amendment'].includes(String(value.resource)) &&
    typeof value.document_id === 'string' && ID_PATTERN.test(value.document_id) && (documentId === undefined || value.document_id === documentId) &&
    typeof value.updated_at === 'string', 'INVALID_RESPONSE', 'Unexpected contract response.', { outcomeUnknown: writing });
  return value as unknown as DocumentContract | DocumentContractAmendment;
}
async function path(client: AssinafyClient, documentId: string): Promise<string> {
  return client.accountPath(`/documents/${id(documentId, 'Document ID')}/contract`);
}
export async function listContracts(client: AssinafyClient, filters: ContractFilters = {}): Promise<DocumentContract[]> {
  const parameters = operations.find(row => row.path === '/accounts/{accountId}/contracts' && row.method === 'GET')!.parameters;
  validate(filters, { type: 'object', properties: Object.fromEntries(parameters.filter(row => row.in === 'query' && !['page', 'per-page'].includes(row.name))
    .map(row => [row.name, row.name === 'status' ? { type: 'string' } : row.schema])) }, schemas);
  if (filters.status !== undefined) invariant(filters.status.split(',').every(status => ['draft', 'active', 'expired', 'terminated'].includes(status)),
    'INVALID_INPUT', 'Choose contract statuses separated by commas.');
  const rows = await client.list<DocumentContract>(await client.accountPath('/contracts'), { ...filters }, 'document_id');
  for (const row of rows) {
    invariant((row.resource === undefined || row.resource === 'document_contract') && typeof row.updated_at === 'string',
      'INVALID_RESPONSE', 'Expected contract terms in the list.');
  }
  return rows;
}
export async function getContract(client: AssinafyClient, documentId: string): Promise<DocumentContract | DocumentContractAmendment> {
  return result(await client.get(await path(client, documentId)), documentId);
}
export async function getContractFamily(client: AssinafyClient, documentId: string, options: { expand?: 'document' } = {}): Promise<DocumentContract> {
  validate(options, { type: 'object', properties: { expand: { type: 'string', enum: ['document'] } } }, schemas);
  const value = result(await client.get(`${await path(client, documentId)}/related`, options));
  invariant(value.resource === 'document_contract', 'INVALID_RESPONSE', 'Expected the root contract.');
  return value;
}
async function write(client: AssinafyClient, documentId: string, suffix: '' | '/renew' | '/terminate', input: ContractInput | ContractRenewal | ContractTermination) {
  id(documentId, 'Document ID');
  const method = suffix ? 'POST' : 'PUT';
  const schema = operations.find(row => row.path === base + suffix && row.method === method)!.requestBody!.content['application/json'].schema;
  validate(input, schema, schemas);
  invariant(suffix || Object.keys(input).length > 0, 'INVALID_INPUT', 'Send at least one contract attribute.');
  const terms = input as ContractInput;
  if (terms.value != null) invariant(terms.value >= 0 && terms.value <= 9999999999999.99 && Number(terms.value.toFixed(2)) === terms.value,
    'INVALID_INPUT', 'Contract value must be non-negative with at most two decimal places.');
  for (const date of [terms.start_date, terms.end_date]) if (date != null) invariant(date >= '1000-01-01', 'INVALID_INPUT', 'Contract dates start at year 1000.');
  if (terms.start_date && terms.end_date) invariant(terms.end_date >= terms.start_date, 'INVALID_INPUT', 'Contract end date precedes its start.');
  if (terms.currency != null) invariant(/^[A-Za-z]{3}$/.test(terms.currency), 'INVALID_INPUT', 'Use a three-letter currency code.');
  if (terms.owner_id != null) id(terms.owner_id, 'Owner ID');
  if (terms.parent_document_id != null) {
    id(terms.parent_document_id, 'Parent document ID');
    invariant(terms.parent_document_id !== documentId, 'INVALID_INPUT', 'A document cannot amend itself.');
  }
  if (terms.metadata) invariant(Object.keys(terms.metadata).every(key => /^[A-Za-z0-9_.-]{1,40}$/.test(key)), 'INVALID_INPUT', 'Invalid metadata key.');
  for (const reference of terms.external_references ?? []) invariant(/^[A-Za-z0-9_.-]+$/.test(reference.system) &&
    reference.id.trim() && !/[\u{10000}-\u{10ffff}]/u.test(reference.id), 'INVALID_INPUT', 'Invalid external reference.');
  if (suffix === '/renew') invariant(terms.end_date || (input as ContractRenewal).term !== undefined, 'INVALID_INPUT', 'Renewal requires the current term or a new end date.');
  const value = result((await client.envelope(method, `${await path(client, documentId)}${suffix}`, { json: input })).data, documentId, true);
  invariant(!suffix || value.resource === 'document_contract', 'INVALID_RESPONSE', 'Expected contract terms after renewal or termination.', { outcomeUnknown: true });
  return value;
}
export async function updateContract(client: AssinafyClient, documentId: string, input: ContractInput): Promise<DocumentContract | DocumentContractAmendment> {
  return write(client, documentId, '', input);
}
export async function renewContract(client: AssinafyClient, documentId: string, input: ContractRenewal): Promise<DocumentContract> {
  return await write(client, documentId, '/renew', input) as DocumentContract;
}
export async function terminateContract(client: AssinafyClient, documentId: string, input: ContractTermination = {}): Promise<DocumentContract> {
  return await write(client, documentId, '/terminate', input) as DocumentContract;
}
