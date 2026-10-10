import { readFile } from 'node:fs/promises';
import event from '../examples/document-ready.json' with { type: 'json' };

// Only synthetic schema-capture data. Never sends an API key, customer record or real signing request.
try {
  const { url } = JSON.parse(await readFile(new URL('../.secrets/webhook.json', import.meta.url), 'utf8'));
  const parsed = new URL(url);
  if (parsed.origin !== 'https://hooks.pluga.co' || !parsed.pathname.startsWith('/v2/webhooks/') ||
    parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Unexpected destination.');
  const response = await fetch(parsed, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ ...event, id: Date.now(), created_at: Math.floor(Date.now() / 1000) }),
  });
  console.log(JSON.stringify({ received_by_pluga: response.ok, http_status: response.status, synthetic: true }));
  if (!response.ok) process.exitCode = 1;
} catch {
  console.error('Fixture delivery failed. Check the private webhook file and connectivity.');
  process.exitCode = 1;
}
