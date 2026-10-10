import { AssinafyClient, getSubscription, listWebhookEndpoints, runAction } from '../dist/index.js';
import { credentialsFromEnvironment } from './credentials.mjs';

// Reads only. Credentials come from the process environment, never CLI arguments or committed files.
try {
  const client = new AssinafyClient(credentialsFromEnvironment());
  await client.workspace();
  const subscription = await getSubscription(client);
  const endpoints = await listWebhookEndpoints(client);
  const types = await client.get('/webhooks/event-types');
  if (!Array.isArray(types) || !types.length) throw new Error('Event catalog is empty.');
  for (const kind of ['signers', 'templates', 'documents']) {
    await client.list(await client.accountPath(`/${kind}`));
  }
  if (process.env.ASSINAFY_DOCUMENT_ID) {
    await runAction('get_document', client, { document_id: process.env.ASSINAFY_DOCUMENT_ID });
  }
  console.log(JSON.stringify({ passed: true, environment: client.environment, writes: 0, webhook_endpoints: endpoints.length,
    workspace_access: true, event_catalog: true, resource_lists: true,
    subscription_exists: Boolean(subscription?.url), subscription_active: subscription?.is_active ?? false,
    document_checked: Boolean(process.env.ASSINAFY_DOCUMENT_ID) }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, code: error.code ?? 'SMOKE_FAILED',
    message: error.code ? error.message : 'Check the required environment variables and production connectivity.' }));
  process.exitCode = 1;
}
