import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage', 'artifacts', '.secrets', '.agents', '.codex', 'AGENTS.md', 'CLAUDE.md']);
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).filter(entry => !ignored.has(entry.name))
    .flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
let checked = 0;
for (const path of files('.')) {
  if (path.endsWith('.mjs')) {
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, `Invalid JavaScript syntax: ${path}\n${result.stderr}`);
    checked++;
  }
  if (path.endsWith('.json')) {
    const text = readFileSync(path, 'utf8');
    JSON.parse(text);
    for (const email of text.matchAll(/[\w.+-]+@([\w.-]+\.[A-Za-z]{2,})/g)) {
      assert.match(email[1], /^(?:example\.(?:com|org|net)|test\.com)$/, `Use fictitious JSON contacts: ${path}`);
    }
    checked++;
  }
  if (path.endsWith('.md')) {
    const text = readFileSync(path, 'utf8');
    assert.ok(text.trim(), `Empty document: ${path}`);
    for (const email of text.matchAll(/[\w.+-]+@([\w.-]+\.[A-Za-z]{2,})/g)) {
      assert.match(email[1], /^(?:example\.(?:com|org|net)|test\.com)$/, `Use fictitious contacts: ${path}`);
    }
    for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (target.startsWith('#')) continue;
      if (/^https:\/\//.test(target)) { new URL(target); continue; }
      assert.ok(!/^[a-z]+:/i.test(target), `Use HTTPS or local file links: ${path}`);
      const local = resolve(dirname(path), decodeURIComponent(target.split('#')[0]));
      assert.ok(statSync(local).isFile(), `Missing local link: ${path}: ${target}`);
    }
    let width;
    for (const line of text.split('\n')) {
      if (!line.startsWith('|')) { width = undefined; continue; }
      const columns = line.split(/(?<!\\)\|/).length;
      width ??= columns;
      assert.equal(columns, width, `Inconsistent Markdown table: ${path}`);
    }
    checked++;
  }
}
assert.ok(checked > 0, 'No source or documentation files checked.');
console.log(`PASS: syntax, JSON and documentation (${checked} files).`);
