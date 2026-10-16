import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import contract from '../src/contract.json' with { type: 'json' };

test('contract checks preserve response properties named description while ignoring annotation text', async () => {
  const spec = { paths: {}, components: { schemas: structuredClone(contract.schemas), securitySchemes: {
    apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
    oauth2: { flows: { authorizationCode: { scopes: { 'webhooks:write': 'Manage webhooks' } } } },
  } }, servers: [{ url: 'https://api.assinafy.com.br' }, { url: 'https://sandbox.assinafy.com.br' }] };
  for (const row of contract.operations) {
    const path = spec.paths['/v1' + row.path] ??= {};
    path[row.method.toLowerCase()] = { ...(row.requestBody ? { requestBody: row.requestBody } : {}), responses: { 200: row.response } };
  }
  for (const action of Object.values(contract.actions)) {
    const path = spec.paths['/v1' + action.path] ??= {};
    path[action.method.toLowerCase()] ??= { ...(action.method === 'GET' ? {} : { requestBody: { content: { 'application/json': { schema: action.input } } } }),
      responses: { 200: { content: { 'application/json': { schema: action.output } } } } };
  }
  const directory = await mkdtemp(join(tmpdir(), 'pluga-contract-'));
  const file = join(directory, 'openapi.json');
  const check = async expected => {
    await writeFile(file, JSON.stringify(spec));
    const result = spawnSync(process.execPath, ['scripts/audit-contract.mjs', file], { encoding: 'utf8' });
    assert.equal(result.status, expected, result.stdout + result.stderr);
    return result;
  };
  try {
    await check(0);
    spec.components.schemas.WebhookEventType.description = 'New annotation only';
    spec.components.schemas.AssignmentSigner.allOf[1].description = 'Another annotation in an array';
    await check(0);
    spec.components.schemas.WebhookEventType.properties.description.type = 'number';
    const failed = await check(1);
    assert.match(failed.stderr, /Changed schema: WebhookEventType/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
