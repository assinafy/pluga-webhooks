import { invariant } from './errors.js';

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function id(value: unknown, label = 'ID'): string {
  invariant(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),
    'INVALID_ID', `${label} must be an unencoded identifier, not a URL or path.`);
  return value;
}
export interface Schema {
  $ref?: string;
  type?: string | readonly string[];
  properties?: Record<string, Schema>;
  required?: readonly string[];
  items?: Schema;
  enum?: readonly unknown[];
  format?: string;
  minimum?: number;
  exclusiveMinimum?: number | boolean;
  maxLength?: number;
}
/** Validate request contracts, including OpenAPI 3.1 bounds; reject unknown fields. */
export function validate(value: unknown, schema: Schema, schemas: Record<string, Schema>, path = 'input'): void {
  if (schema.$ref) {
    const resolved = schemas[schema.$ref.split('/').at(-1)!];
    invariant(resolved, 'INVALID_CONTRACT', 'Unresolved request schema.');
    return validate(value, resolved, schemas, path);
  }
  const fail = (condition: unknown, reason: string) => invariant(condition, 'INVALID_INPUT', `${path}: ${reason}`);
  if (schema.enum) fail(schema.enum.includes(value), 'unsupported selection.');
  if (Array.isArray(schema.type)) {
    if (value === null && schema.type.includes('null')) return;
    const type = schema.type.find(type => type !== 'null');
    invariant(type, 'INVALID_CONTRACT', 'Missing request type.');
    return validate(value, { ...schema, type }, schemas, path);
  }
  if (schema.type === 'object') {
    invariant(record(value), 'INVALID_INPUT', `${path}: expected an object.`);
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) fail(Object.hasOwn(value, key) && value[key] !== undefined, `${key} is required.`);
    for (const [key, item] of Object.entries(value)) {
      fail(Object.hasOwn(properties, key), 'unsupported field.');
      validate(item, properties[key]!, schemas, `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    invariant(Array.isArray(value), 'INVALID_INPUT', `${path}: expected an array.`);
    for (const [index, item] of value.entries()) validate(item, schema.items ?? {}, schemas, `${path}[${index}]`);
  } else if (schema.type === 'string') {
    invariant(typeof value === 'string', 'INVALID_INPUT', `${path}: expected text.`);
    fail(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), 'control characters are not allowed.');
    if (schema.maxLength !== undefined) fail(value.length <= schema.maxLength, 'text is too long.');
    if (schema.format === 'email') fail(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'invalid email address.');
    if (schema.format === 'date-time') fail(/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) &&
      new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10), 'use a valid ISO 8601 date with timezone.');
  } else if (schema.type === 'number' || schema.type === 'integer') {
    invariant(typeof value === 'number' && Number.isFinite(value), 'INVALID_INPUT', `${path}: expected a number.`);
    if (schema.type === 'integer') fail(Number.isInteger(value), 'expected an integer.');
    if (schema.minimum !== undefined) fail(schema.exclusiveMinimum === true ? value > schema.minimum : value >= schema.minimum, 'number is out of range.');
    if (typeof schema.exclusiveMinimum === 'number') fail(value > schema.exclusiveMinimum, 'number is out of range.');
  } else if (schema.type === 'boolean') fail(typeof value === 'boolean', 'expected a boolean.');
}
