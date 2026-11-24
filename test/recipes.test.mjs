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
  assert.deepEqual(JSON.parse(await readFile(new URL('../examples/requests.json', import.meta.url))), worksheet);
  assert.deepEqual(JSON.parse(await readFile(new URL('../public-guide/examples/requests.json', import.meta.url))), worksheet);
  assert.deepEqual(JSON.parse(await readFile(new URL('../public-guide/examples/document-ready.json', import.meta.url))),
    JSON.parse(await readFile(new URL('../examples/document-ready.json', import.meta.url))));
  validate(worksheet.requests.find(row => row.id === 'register_webhook_endpoint').body, contract.webhookEndpointInput, contract.schemas);
  validate(worksheet.requests.find(row => row.id === 'update_webhook_endpoint').body, contract.webhookEndpointUpdateInput, contract.schemas);
});
test('all action recipe variants use supported nested request fields', () => {
  for (const row of worksheet.requests) {
    const action = Object.values(contract.actions).find(action => action.method === row.method && action.path === row.path);
    if (action) validate(row.body ?? {}, action.input, contract.schemas);
  }
  for (const id of ['request_signatures_biometric', 'create_document_from_template_biometric']) {
    assert.equal(worksheet.requests.find(row => row.id === id).body.signers[0].verification_method, 'IdDocumentFaceMatchBasic');
  }
});
test('documented full action request examples conform to the request schemas', async () => {
  const reference = await readFile(new URL('../docs/API.md', import.meta.url), 'utf8');
  for (const [name, action] of Object.entries(contract.actions)) {
    if (action.method === 'GET') continue;
    const section = reference.split(`### ${name}\n`)[1].split('\n### ')[0];
    const body = JSON.parse(section.match(/```json\n([\s\S]*?)\n```/)[1]);
    validate(body, action.input, contract.schemas);
    assert.deepEqual(Object.keys(body).sort(), Object.keys(action.input.properties).sort(), name);
    if (body.signers) assert.deepEqual(Object.keys(body.signers[0]).sort(), Object.keys(action.input.properties.signers.items.properties).sort(), name);
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

test('CLM recipes and documented bodies match every supported request field and response model', async () => {
  const reference = await readFile(new URL('../docs/CONTRACTS.md', import.meta.url), 'utf8');
  const bodies = [...reference.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  for (const row of worksheet.requests.filter(row => row.path.includes('/contract') && row.body)) {
    const operation = contract.operations.find(operation => operation.path === row.path && operation.method === row.method);
    validate(row.body, operation.requestBody.content['application/json'].schema, contract.schemas);
    assert.ok(bodies.some(body => JSON.stringify(body) === JSON.stringify(row.body)), row.id);
    const name = row.id === 'link_contract_amendment' ? 'DocumentContractAmendment' : 'DocumentContract';
    for (const key of Object.keys(contract.schemas[name].properties).filter(key => key !== 'document')) {
      assert.ok(Object.hasOwn(row.response_model.data, key), `${row.id}: ${key}`);
    }
  }
  const update = worksheet.requests.find(row => row.id === 'update_contract').body;
  const link = worksheet.requests.find(row => row.id === 'link_contract_amendment').body;
  assert.deepEqual(Object.keys({ ...update, ...link }).sort(), Object.keys(contract.schemas.DocumentContractInput.properties).sort());
  assert.equal(worksheet.requests.find(row => row.id === 'list_contracts').unique_key, 'document_id');
  assert.equal(worksheet.requests.find(row => row.id === 'rotate_webhook_secret').api_key_only, undefined);
});

test('every envelope operation has a recipe and documented complete payloads from its pinned contract', async () => {
  const reference = await readFile(new URL('../docs/ENVELOPES.md', import.meta.url), 'utf8');
  const examples = [...reference.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  const operations = contract.operations.filter(row => row.path.includes('/envelopes'));
  assert.equal(operations.length, 12);
  for (const op of operations) {
    const recipe = worksheet.requests.find(row => row.method === op.method && row.path === op.path);
    assert.ok(recipe, `${op.method} ${op.path}`);
    for (const value of [recipe.body, recipe.response_model].filter(Boolean)) {
      assert.ok(examples.some(example => JSON.stringify(example) === JSON.stringify(value)), recipe.id);
    }
    if (!op.requestBody) assert.equal(recipe.body, undefined);
  }
  const create = worksheet.requests.find(row => row.id === 'create_envelope').body;
  const fields = (value, schema) => assert.deepEqual(Object.keys(value).sort(), Object.keys(schema.properties).sort());
  fields(create, contract.schemas.EnvelopeCreateRequest);
  fields(create.signers[0], contract.schemas.EnvelopeCreateRequest.properties.signers.items);
  fields(create.documents[0], contract.schemas.EnvelopeDocumentRequest);
  const model = worksheet.requests.find(row => row.id === 'get_envelope').response_model.data;
  fields(model, contract.schemas.DocumentEnvelope);
  fields(model.documents[0], contract.schemas.DocumentEnvelope.properties.documents.items);
  fields(model.documents[0].signers[0], contract.schemas.DocumentEnvelope.properties.documents.items.properties.signers.items);
  fields(model.signing_urls[0], contract.schemas.SigningUrl);
});

test('action recipes preserve complete documented response models and state-dependent omissions', async () => {
  const reference = await readFile(new URL('../docs/API.md', import.meta.url), 'utf8');
  for (const [name, action] of Object.entries(contract.actions)) {
    const section = reference.split(`### ${name}\n`)[1].split('\n### ')[0];
    const model = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1])).find(value => value.data).data;
    for (const recipe of worksheet.requests.filter(row => row.path === action.path && row.method === action.method)) {
      assert.deepEqual(Object.keys(recipe.response_model.data).sort(), Object.keys(model).sort(), recipe.id);
      if (name === 'create_document_from_template') {
        assert.equal(recipe.response_model.data.assignment, null);
        assert.equal(recipe.response_model.data.status, 'uploaded');
        assert.equal(Object.hasOwn(recipe.response_model.data, 'has_contract'), false);
      }
      if (name === 'request_signatures') assert.equal(recipe.response_model.data.method, recipe.body.method);
    }
  }
});
