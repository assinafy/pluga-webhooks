import test from 'node:test';
import assert from 'node:assert/strict';
import worksheet from '../recipes/requests.json' with { type: 'json' };
import { contract } from '../dist/index.js';
import { validate } from '../dist/validation.js';
import { readFile } from 'node:fs/promises';

test('every action has a production recipe with an actual nested JSON body', () => {
  assert.equal(worksheet.base_url, 'https://api.assinafy.com.br/v1');
  assert.equal(worksheet.headers['X-Api-Key'], '<ASSINAFY_API_KEY>');
  assert.equal(new Set(worksheet.requests.map(row => row.id)).size, worksheet.requests.length);
  for (const [name, action] of Object.entries(contract.actions)) {
    const recipe = worksheet.requests.find(row => row.id === name);
    assert.equal(recipe.path, action.path); assert.equal(recipe.method, action.method);
    validate(recipe.body ?? {}, action.input, contract.schemas);
    assert.ok(recipe.response_model.data.id);
  }
});
test('public recipes and event fixtures remain identical and new endpoint inputs match their contracts', async () => {
  assert.deepEqual(JSON.parse(await readFile(new URL('../public-guide/examples/requests.json', import.meta.url))), worksheet);
  assert.deepEqual(JSON.parse(await readFile(new URL('../public-guide/examples/document-ready.json', import.meta.url))),
    JSON.parse(await readFile(new URL('../examples/document-ready.json', import.meta.url))));
  validate(worksheet.requests.find(row => row.id === 'register_webhook_endpoint').body, contract.webhookEndpointInput, contract.schemas);
  validate(worksheet.requests.find(row => row.id === 'update_webhook_endpoint').body, contract.webhookEndpointUpdateInput, contract.schemas);
});
test('documented full action request examples conform to the request schemas', async () => {
  const reference = await readFile(new URL('../docs/API.md', import.meta.url), 'utf8');
  for (const [name, action] of Object.entries(contract.actions)) {
    if (action.method === 'GET') continue;
    const section = reference.split(`### ${name}\n`)[1].split('\n### ')[0];
    const body = JSON.parse(section.match(/```json\n([\s\S]*?)\n```/)[1]);
    validate(body, action.input, contract.schemas);
    if (body.signers) assert.ok(body.signers.every(row => row.id === 'SIGNER_ID'));
    if (body.entries) assert.ok(body.entries.every(entry => entry.fields.every(field => field.signer_id === 'SIGNER_ID')));
  }
});
test('setup request is distinguished from routine automations and credentials never appear in URLs', () => {
  const setup = worksheet.requests.find(row => row.id === 'register_subscription');
  assert.equal(setup.setup_only, true); assert.equal(setup.body.is_active, true);
  validate(setup.body, contract.webhookSubscriptionInput, contract.schemas);
  for (const recipe of worksheet.requests) {
    assert.match(recipe.path, /^\/(accounts|documents|webhooks)(\/|$)/);
    assert.equal(recipe.path.includes('API_KEY'), false);
    assert.equal(JSON.stringify(recipe.body ?? {}).includes('API_KEY'), false);
  }
});
