import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import contract from '../src/contract.json' with { type: 'json' };
import worksheet from '../recipes/requests.json' with { type: 'json' };

function structural(value) {
  if (Array.isArray(value)) return value.map(structural);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['description', 'summary', 'example', 'examples', 'title'].includes(key))
    .map(([key, item]) => [key, structural(item)]));
  return value;
}
try {
  const schemaFile = process.argv[2];
  const spec = schemaFile ? JSON.parse(await readFile(schemaFile, 'utf8')) :
    await fetch(contract.source, { signal: AbortSignal.timeout(30_000), redirect: 'error' }).then(response => {
      if (!response.ok) throw new Error('Cannot read the production OpenAPI document.');
      return response.json();
    });
  for (const action of Object.values(contract.actions)) {
    const operation = spec.paths[`/v1${action.path}`]?.[action.method.toLowerCase()];
    assert.ok(operation, `Missing action ${action.name}`);
    assert.deepEqual(structural(operation.requestBody?.content['application/json'].schema ?? { type: 'object', properties: {} }),
      structural(action.input), `Changed input: ${action.name}`);
    assert.deepEqual(structural(operation.responses['200'].content['application/json'].schema), structural(action.output), `Changed output: ${action.name}`);
  }
  for (const pinned of contract.operations) {
    const operation = spec.paths[`/v1${pinned.path}`]?.[pinned.method.toLowerCase()];
    assert.ok(operation, `Missing operation: ${pinned.method} ${pinned.path}`);
    assert.deepEqual(structural(operation.requestBody ?? null), structural(pinned.requestBody), `Changed request: ${pinned.path}`);
    assert.deepEqual(structural(operation.responses['200']), structural(pinned.response), `Changed response: ${pinned.path}`);
  }
  for (const [name, schema] of Object.entries(contract.schemas)) {
    assert.deepEqual(structural(spec.components.schemas[name]), structural(schema), `Changed schema: ${name}`);
  }
  for (const request of worksheet.requests) {
    assert.ok(spec.paths[`/v1${request.path}`]?.[request.method.toLowerCase()], `Missing request: ${request.id}`);
  }
  assert.deepEqual(structural(spec.paths['/v1/accounts/{accountId}/webhooks/subscriptions'].put.requestBody.content['application/json'].schema),
    structural(contract.webhookSubscriptionInput), 'Changed webhook registration input');
  assert.ok(Object.values(spec.components.securitySchemes).some(scheme => scheme.type === 'apiKey' && scheme.in === 'header' && scheme.name === 'X-Api-Key'));
  assert.ok(spec.components.securitySchemes.oauth2.flows.authorizationCode.scopes['webhooks:write']);
  assert.ok(spec.servers.some(server => server.url === 'https://api.assinafy.com.br'));
  assert.ok(spec.servers.some(server => server.url === 'https://sandbox.assinafy.com.br'));
  console.log('PASS: action requests/responses, helper endpoints, referenced schemas, recipes and authentication.');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
