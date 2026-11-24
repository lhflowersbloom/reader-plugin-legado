import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleContext, jsTimeoutFor, JS_TIMEOUT_MS, JS_NET_TIMEOUT_MS } from '../src/engine.js';
import { initStorage, getSettings, updateSettings, DEFAULT_SETTINGS } from '../src/storage.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  [PASS] ${name}`);
}

console.log('Running v0.4.2 unit tests...');

// 1. timeout classification
await test('jsTimeoutFor: 20 s for blocking-HTTP scripts, 5 s otherwise', () => {
  assert.equal(JS_TIMEOUT_MS, 5000);
  assert.equal(JS_NET_TIMEOUT_MS, 20000);
  assert.equal(jsTimeoutFor('var html = java.ajax(source.getKey())'), JS_NET_TIMEOUT_MS);
  assert.equal(jsTimeoutFor('java.post(url, body, {})'), JS_NET_TIMEOUT_MS);
  assert.equal(jsTimeoutFor('java .get ("https://x")'), JS_NET_TIMEOUT_MS);
  assert.equal(jsTimeoutFor('java.connect(u)'), JS_NET_TIMEOUT_MS);
  assert.equal(jsTimeoutFor('result.replace(/a/g, "b")'), JS_TIMEOUT_MS);
  assert.equal(jsTimeoutFor('java.md5Encode(key)'), JS_TIMEOUT_MS);
});

// 2. real slow java.ajax (群小说网 pattern) no longer killed at 5 s
await test('searchUrl script with a 6 s java.ajax completes (was cut off at 5 s)', async () => {
  // HTTP server in its own thread: the main thread blocks inside java.ajax (Atomics.wait).
  const server = new Worker(
    `const http = require('node:http');
     const { parentPort } = require('node:worker_threads');
     const s = http.createServer((req, res) => {
       setTimeout(() => {
         res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
         res.end('<input name="_token" value="tok123">');
       }, 6000);
     });
     s.listen(0, '127.0.0.1', () => parentPort.postMessage(s.address().port));`,
    { eval: true },
  );
  try {
    const port = await new Promise((resolve) => server.once('message', resolve));
    const base = `http://127.0.0.1:${port}`;
    const ctx = new RuleContext({ source: { bookSourceUrl: base }, baseUrl: base, key: '凡人修仙传' });
    const started = Date.now();
    const out = ctx.getString(
      `@js:var html = java.ajax(source.getKey()); var t = /value="([^"]+)"/.exec(html)[1]; "/search,"+JSON.stringify({body:"_token="+t+"&keyword="+key, method:"POST"})`,
    );
    const ms = Date.now() - started;
    assert.ok(ms >= 5500, `took ${ms}ms`);
    assert.equal(out, '/search,{"body":"_token=tok123&keyword=凡人修仙传","method":"POST"}');
  } finally {
    await server.terminate();
  }
});

// 3. CPU-only scripts keep the 5 s guard
await test('a runaway script without network calls is still stopped at ~5 s', () => {
  const ctx = new RuleContext({ content: 'fallback' });
  const started = Date.now();
  const out = ctx.getString('@js:while (true) {}');
  const ms = Date.now() - started;
  assert.ok(ms < 9000, `took ${ms}ms`);
  assert.equal(out, 'fallback');
});

// 4. settings defaults and clamping
await test('settings: default timeout 15000, checkConcurrency default 4 and clamped to 1–16', async () => {
  assert.equal(DEFAULT_SETTINGS.searchTimeoutMs, 15000);
  assert.equal(DEFAULT_SETTINGS.checkConcurrency, 4);
  const dir = await mkdtemp(join(tmpdir(), 'legado-v042-'));
  try {
    await initStorage(dir);
    assert.equal(getSettings().searchTimeoutMs, 15000);
    assert.equal(getSettings().checkConcurrency, 4);
    await updateSettings({ checkConcurrency: 99 });
    assert.equal(getSettings().checkConcurrency, 16);
    await updateSettings({ checkConcurrency: 0 });
    assert.equal(getSettings().checkConcurrency, 1);
    await updateSettings({ searchTimeoutMs: 7000 });
    assert.equal(getSettings().checkConcurrency, 1, 'unrelated save keeps checkConcurrency');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

console.log(`\nAll ${passed} unit tests passed!`);
