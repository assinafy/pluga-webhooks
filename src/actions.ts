import pinnedContract from './contract.json' with { type: 'json' };
import { AssinafyClient } from './client.js';
import { invariant } from './errors.js';
import { id, record, validate } from './validation.js';
import type { Schema } from './validation.js';
import type { Resource } from './types.js';

export const contract = pinnedContract;
export type ActionId = keyof typeof contract.actions;
type Input = { document_id?: string; template_id?: string; body?: Record<string, unknown> };
const schemas = contract.schemas as Record<string, Schema>;

async function document(client: AssinafyClient, documentId: string): Promise<Resource> {
  const account = await client.workspace();
  const result = await client.get<Resource>(`/documents/${id(documentId)}`, { expand: 'assignment' });
  invariant(record(result) && result.id === documentId, 'INVALID_RESPONSE', 'The document response has an unexpected ID.');
  invariant(result.account_id === account.id, 'WORKSPACE_ACCESS_DENIED', 'The document belongs to another workspace.');
  return result;
}
async function template(client: AssinafyClient, templateId: string): Promise<Resource> {
  const rows = await client.list<Resource>(await client.accountPath('/templates'));
  const selected = rows.find(row => row.id === templateId);
  invariant(selected, 'TEMPLATE_NOT_FOUND', 'The template is not in the connected workspace.');
  return selected;
}
function objectRows(value: unknown): Record<string, unknown>[] {
  invariant(Array.isArray(value) && value.every(record), 'INVALID_INPUT', 'Expected an array of objects.');
  return value;
}
function validateSigning(rows: Record<string, unknown>[]): void {
  invariant(rows.length > 0, 'INVALID_SIGNERS', 'Add at least one signer.');
  for (const row of rows) {
    id(row.id, 'Signer ID');
    const notifications = row.notification_methods;
    if (notifications !== undefined) invariant(Array.isArray(notifications) && notifications.length === 1 &&
      ['Email', 'Whatsapp'].includes(String(notifications[0])), 'INVALID_NOTIFICATION', 'Choose exactly one notification channel.');
    const channel = Array.isArray(notifications) ? notifications[0] : undefined;
    const verification = row.verification_method ?? channel ?? 'Email';
    invariant(!channel || verification === 'DigitalCertificate' || channel === verification,
      'INVALID_NOTIFICATION', 'Verification and notification channels must match.');
    if (row.step !== undefined) invariant(Number.isInteger(row.step) && Number(row.step) > 0,
      'INVALID_STEPS', 'Signing steps must be positive integers.');
  }
  if (rows.some(row => row.step !== undefined)) {
    invariant(rows.every(row => row.step !== undefined), 'INVALID_STEPS', 'Set a step for every signer or leave every step empty.');
    const steps = [...new Set(rows.map(row => Number(row.step)))].sort((a, b) => a - b);
    invariant(steps.every((step, i) => step === i + 1), 'INVALID_STEPS', 'Signing steps must start at one without gaps.');
  }
  for (const row of rows.filter(row => row.verification_method === 'DigitalCertificate')) {
    invariant(rows.filter(other => (other.step ?? 1) === (row.step ?? 1)).length === 1,
      'INVALID_STEPS', 'Each digital certificate signer must be alone in its signing step.');
  }
}
async function verifyContacts(client: AssinafyClient, rows: Record<string, unknown>[], signingRows: Record<string, unknown>[], copies: string[]): Promise<void> {
  const requested = [...rows.map(row => id(row.id, 'Signer ID')), ...copies.map(value => id(value, 'Copy receiver ID'))];
  const existing = new Map((await client.list<Resource>(await client.accountPath('/signers'))).map(row => [row.id, row]));
  invariant(requested.every(value => existing.has(value)), 'SIGNER_NOT_FOUND', 'Every signer and copy receiver must exist in the connected workspace.');
  for (const row of signingRows) {
    const contact = existing.get(String(row.id))!;
    const notifications = row.notification_methods as string[] | undefined;
    const channel = notifications?.[0] ?? (row.verification_method === 'Whatsapp' ? 'Whatsapp' : 'Email');
    invariant(channel === 'Whatsapp' ? typeof contact.whatsapp_phone_number === 'string' && /^\+[1-9]\d{7,14}$/.test(contact.whatsapp_phone_number) :
      typeof contact.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email),
    'INVALID_CONTACT', 'The signer needs a valid contact for the selected notification channel.');
    if (row.verification_method === 'DigitalCertificate') invariant(typeof contact.government_id === 'string' &&
      /^(?:\d{11}|[A-Z0-9]{12}\d{2})$/.test(contact.government_id),
    'INVALID_GOVERNMENT_ID', 'Digital certificate signers need a normalized CPF or CNPJ.');
  }
}
export async function runAction(action: ActionId, client: AssinafyClient, input: Input = {}): Promise<Resource> {
  invariant(Object.hasOwn(contract.actions, action), 'UNKNOWN_ACTION', 'Unknown action.');
  const definition = contract.actions[action];
  invariant(record(input) && Object.keys(input).every(key => ['body', ...(definition.path.includes('{documentId}') ? ['document_id'] : []),
    ...(definition.path.includes('{templateId}') ? ['template_id'] : [])].includes(key)), 'INVALID_INPUT', 'Unknown action input.');
  const body = input.body === undefined ? {} : input.body;
  validate(body, definition.input as Schema, schemas);
  if (action === 'get_document') return document(client, id(input.document_id, 'Document ID'));

  if (body.expires_at !== undefined) invariant(Date.parse(String(body.expires_at)) >= (client.runtime.now ?? Date.now)() + 3_600_000,
    'INVALID_EXPIRATION', 'Expiration must be at least one hour in the future.');
  if (action === 'create_signer') {
    invariant(typeof body.full_name === 'string' && body.full_name.trim(), 'INVALID_INPUT', 'Full name is required.');
    if (body.whatsapp_phone_number !== undefined) invariant(/^\+[1-9]\d{7,14}$/.test(String(body.whatsapp_phone_number)),
      'INVALID_PHONE', 'Use an E.164 WhatsApp number, including + and country code.');
    return client.post<Resource>(await client.accountPath('/signers'), body);
  }

  const rows = objectRows(body.signers);
  let signingRows = rows;
  let path: string;
  if (action === 'create_document_from_template') {
    const templateId = id(input.template_id, 'Template ID');
    const selected = await template(client, templateId);
    invariant(String(selected.status).toLowerCase() === 'ready', 'TEMPLATE_NOT_READY', 'The template must be ready before sending.');
    const roles = objectRows(selected.roles);
    const nonEditors = roles.filter(role => String(role.assignment_type).toLowerCase() !== 'editor');
    const roleIds = rows.map(row => id(row.role_id, 'Role ID'));
    invariant(nonEditors.length > 0 && roleIds.length === nonEditors.length && new Set(roleIds).size === roleIds.length &&
      nonEditors.every(role => roleIds.includes(String(role.id))), 'INVALID_ROLE_MAPPING', 'Map every non-editor template role exactly once.');
    const signingRoles = new Set(nonEditors.filter(role => String(role.assignment_type).toLowerCase() === 'signer').map(role => role.id));
    signingRows = rows.filter(row => signingRoles.has(row.role_id));
    validateSigning(signingRows);
    const editorRoles = new Set(roles.filter(role => String(role.assignment_type).toLowerCase() === 'editor').map(role => role.id));
    const editorIds = new Set(objectRows(selected.pages ?? []).flatMap(page => objectRows(page.fields ?? []))
      .filter(field => editorRoles.has(field.role_id)).map(field => field.field_id));
    const fields = objectRows(body.editor_fields ?? []);
    invariant(fields.every(field => editorIds.has(field.field_id)) && new Set(fields.map(field => field.field_id)).size === fields.length,
      'INVALID_EDITOR_FIELDS', 'Use unique editor field IDs from the selected template.');
    if (body.tags !== undefined) invariant((body.tags as string[]).every(tag => tag.trim()), 'INVALID_INPUT', 'Tags must not be empty.');
    path = await client.accountPath(`/templates/${templateId}/documents`);
  } else {
    validateSigning(rows);
    invariant(new Set(rows.map(row => row.id)).size === rows.length, 'INVALID_SIGNERS', 'Do not repeat signer IDs.');
    const documentId = id(input.document_id, 'Document ID');
    const selected = await document(client, documentId);
    invariant(!record(selected.assignment) || !selected.assignment.id, 'ALREADY_SENT', 'The document already has a signature request.');
    invariant(['uploaded', 'metadata_processing', 'metadata_ready'].includes(String(selected.status)), 'DOCUMENT_NOT_READY', 'The document cannot be sent in its current state.');
    if (body.method === 'collect') {
      invariant(selected.status === 'metadata_ready', 'DOCUMENT_NOT_READY', 'Collect mode requires processed document pages.');
      const entries = objectRows(body.entries);
      invariant(entries.length > 0, 'INVALID_ENTRIES', 'Collect mode requires field placements.');
      const pages = new Map(objectRows(selected.pages ?? []).map(page => [page.id, page]));
      for (const entry of entries) {
        const page = pages.get(id(entry.page_id, 'Page ID'));
        invariant(page, 'INVALID_ENTRIES', 'The page does not belong to this document.');
        const fields = objectRows(entry.fields);
        invariant(fields.length > 0, 'INVALID_ENTRIES', 'Add a field placement.');
        for (const field of fields) {
          id(field.field_id, 'Field ID');
          invariant(rows.some(row => row.id === field.signer_id), 'INVALID_ENTRIES', 'A field refers to an unmapped signer.');
          invariant(record(field.display_settings), 'INVALID_ENTRIES', 'Field placement geometry is required.');
          const geometry = field.display_settings;
          invariant(typeof page.width === 'number' && typeof page.height === 'number' &&
            Number(geometry.left) + Number(geometry.width) <= page.width && Number(geometry.top) + Number(geometry.height) <= page.height,
          'INVALID_ENTRIES', 'The field placement must fit inside the document page.');
        }
      }
    }
    path = `/documents/${documentId}/assignments`;
  }
  await verifyContacts(client, rows, signingRows, (body.copy_receivers ?? []) as string[]);
  return client.post<Resource>(path, body);
}

export type ListId = 'documents' | 'signers' | 'templates' | 'fields' | 'template_roles' | 'editor_fields' | 'document_pages';
export async function loadOptions(list: ListId, client: AssinafyClient, parentId?: string): Promise<{ value: string; label: string }[]> {
  if (['documents', 'signers', 'templates', 'fields'].includes(list)) {
    const rows = await client.list<Resource>(await client.accountPath(`/${list}`), list === 'fields' ? { include_standard: 1 } : {});
    return rows.map(row => ({ value: row.id, label: String(row.name ?? row.full_name ?? row.email ?? row.id) }));
  }
  if (list === 'document_pages') {
    const selected = await document(client, id(parentId, 'Document ID'));
    return objectRows(selected.pages ?? []).map((page, i) => ({ value: id(page.id), label: `Page ${page.number ?? i + 1}` }));
  }
  invariant(list === 'template_roles' || list === 'editor_fields', 'UNKNOWN_LIST', 'Unknown options list.');
  const selected = await template(client, id(parentId, 'Template ID'));
  const roles = objectRows(selected.roles);
  if (list === 'template_roles') return roles.filter(role => String(role.assignment_type).toLowerCase() !== 'editor')
    .map(role => ({ value: id(role.id), label: String(role.name ?? role.id) }));
  const editors = new Set(roles.filter(role => String(role.assignment_type).toLowerCase() === 'editor').map(role => role.id));
  const fields = objectRows(selected.pages ?? []).flatMap(page => objectRows(page.fields ?? [])).filter(field => editors.has(field.role_id));
  return [...new Map(fields.map(field => [id(field.field_id), { value: id(field.field_id), label: String(field.label ?? field.field_id) }])).values()];
}
