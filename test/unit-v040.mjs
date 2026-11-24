import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { RuleContext } from '../src/engine.js';
import { setCookieString, getCookieForUrl, removeCookie, parseLegadoUrl } from '../src/http.js';
import { initStorage, getSettings, updateSettings, recordSourceResult, isCoolingDown, mergeSources, loadSources } from '../src/storage.js';
import { decodeRef } from '../src/legado-runner.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  [PASS] ${name}`);
}

console.log('Running v0.4.0 unit tests...');

// 1. text.xxx.0 selector & ownText priority
await test('CSS text.下一页.0@href parses index and skips html/body/style wrappers', () => {
  const html = `
    <html><head><style>/* 下一页 */</style></head>
    <body>
      <div class="wrap">
        <a href="/prev">上一页</a>
        <a href="/next-1">下一页</a>
        <a href="/next-2">下一页</a>
      </div>
    </body></html>`;
  const ctx = new RuleContext({ baseUrl: 'https://example.com/book/1/', content: html });
  assert.equal(ctx.getString('text.下一页.0@href', true), 'https://example.com/next-1');
  assert.equal(ctx.getString('text.下一页.1@href', true), 'https://example.com/next-2');
});

// 2. XPath with inline <script> containing unescaped < and &
await test('XPath ignores <script> unescaped operators that previously broke XML parsing', () => {
  const html = `<!DOCTYPE html><html><head><script>if (a < b && c > d) { var x = 1 & 2; }</script></head>
    <body><div class="chapter clearfix"><a href="/ch/1">第一章</a><a href="/ch/2">第二章</a></div></body></html>`;
  const ctx = new RuleContext({ baseUrl: 'https://example.com', content: html });
  const els = ctx.getElements('//*[@class="chapter clearfix"]/a');
  assert.equal(els.length, 2);
});

// 3. Template interpolation inside @js: and <js>, plus {{@css:...}}
await test('{{$.id}} inside @js: and {{@css:...}} inside URL templates', () => {
  const json = JSON.stringify({ id: 153294, data: { bid: '9988' } });
  const ctx = new RuleContext({ baseUrl: 'https://api.example.com', content: json });
  const url = ctx.getString(`@js:var params = {'id': {{$.id}}}; "https://api.example.com/ch?id=" + params.id`, true);
  assert.equal(url, 'https://api.example.com/ch?id=153294');

  const xmlCtx = new RuleContext({
    baseUrl: 'https://m.example.com',
    content: '<cp><id>42</id><cn>第42章</cn></cp>',
    vars: { bid: '1001' },
  });
  const chUrl = xmlCtx.getString('https://m.example.com/book/@get:{bid}/{{@css:id@text}}.html', true);
  assert.equal(chUrl, 'https://m.example.com/book/1001/42.html');
});

// 4. Rhino JavaImporter + Packages.javax.crypto AES/CBC/PKCS5Padding decryption
await test('Rhino JavaImporter + Packages.javax.crypto Cipher AES-128-CBC decryption', () => {
  const keyStr = '242ccb8230d709e1';
  const iv = Buffer.from('0123456789abcdef', 'utf8');
  const plain = '这是加密章节的正文内容，包含中文与标点！';
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(keyStr, 'utf8'), iv);
  const enc = Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');

  const ctx = new RuleContext({ content: enc });
  const script = `@js:
    var javaImport = new JavaImporter();
    javaImport.importPackage(
      Packages.java.lang,
      Packages.javax.crypto.spec,
      Packages.javax.crypto,
      Packages.java.util
    );
    with (javaImport) {
      function decode(content) {
        var ivEncData = Base64.getDecoder().decode(String(content));
        var key = SecretKeySpec(String("${keyStr}").getBytes(), "AES");
        var iv = IvParameterSpec(Arrays.copyOfRange(ivEncData, 0, 16));
        var chipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        chipher.init(2, key, iv);
        return String(chipher.doFinal(Arrays.copyOfRange(ivEncData, 16, ivEncData.length)));
      }
    }
    decode(src);
  `;
  assert.equal(ctx.getString(script), plain);
});

// 5. +@js: prefix, source.jsLib, java.toNumChapter, cookie.removeCookie
await test('+@js: prefix, source.jsLib, java.toNumChapter, and cookie.removeCookie', () => {
  setCookieString('https://cookie-test.example.com/a', 'sid=xyz123; token=abc');
  assert.match(getCookieForUrl('https://cookie-test.example.com/b'), /sid=xyz123/);

  const ctx = new RuleContext({
    source: { bookSourceUrl: 'https://cookie-test.example.com', jsLib: 'function helperAdd(s) { return s + "_ok"; }' },
    baseUrl: 'https://cookie-test.example.com',
    content: '<div data-u="/c/1/"></div><div data-u="/c/2/"></div>',
  });
  const els = ctx.getElements('+@js:cookie.removeCookie(source.getKey()); result.match(/\\/c\\/\\d+\\//g).map(x => helperAdd(x))');
  assert.deepEqual([...els], ['/c/1/_ok', '/c/2/_ok']);
  assert.equal(getCookieForUrl('https://cookie-test.example.com/b'), '');
  assert.equal(ctx.getString('@js:java.toNumChapter("第一百二十三章 初入仙界")'), '第123章 初入仙界');
  removeCookie('https://cookie-test.example.com');
});

// 6. Relaxed Legado URL option parsing (smart quotes & hyphenated header keys)
await test('parseLegadoUrl handles smart quotes and hyphenated keys', () => {
  const p = parseLegadoUrl(`https://example.com/ch/1,{webView:“true”, headers:{Content-Type:'text/plain'}}`);
  assert.equal(p.url, 'https://example.com/ch/1');
  assert.equal(p.headers['Content-Type'], 'text/plain');
});

// 7. Storage settings persistence + dynamic breaker + re-import readerHtml preservation
await test('Storage settings, dynamic breaker threshold, and readerHtml preservation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'legado-v040-'));
  try {
    await initStorage(dir);
    await updateSettings({ breakerThreshold: 2, breakerBaseMinutes: 5, searchBatchSize: 20 });
    assert.equal(getSettings().breakerThreshold, 2);
    assert.equal(getSettings().searchBatchSize, 20);

    recordSourceResult('https://s1.example.com', { ok: false, error: 'HTTP 403' });
    assert.equal(isCoolingDown('https://s1.example.com'), false);
    recordSourceResult('https://s1.example.com', { ok: false, error: 'HTTP 403' });
    assert.equal(isCoolingDown('https://s1.example.com'), true);

    await mergeSources(dir, [{ bookSourceUrl: 'https://pic.example.com', bookSourceName: '插图源', enabled: false, readerHtml: true }]);
    await mergeSources(dir, [{ bookSourceUrl: 'https://pic.example.com', bookSourceName: '插图源v2' }]);
    const loaded = await loadSources(dir);
    assert.equal(loaded[0].enabled, false);
    assert.equal(loaded[0].readerHtml, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 8. JSON-RPC smoke test: extension.page, save-settings, extension.task, fuzzy alternatives
await test('JSON-RPC extension.page, save-settings, and extension.task protocol', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'legado-rpc-'));
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: join(import.meta.dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let seq = 0;
  const pending = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    }
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, host: { dataDir: dir } } }) + '\n');
    });

  try {
    const page = await call('extension.page', { userId: 'u1' });
    assert.equal(page.tabs.length, 4);
    const maint = page.tabs.find((t) => t.id === 'maintenance');
    assert.ok(maint.forms.some((f) => f.id === 'save-settings'));

    const updated = await call('extension.action', {
      userId: 'u1',
      action: 'save-settings',
      values: {
        search_batch_size: 18,
        search_timeout_ms: 6000,
        breaker_threshold: 4,
        breaker_base_minutes: 15,
        breaker_max_hours: 8,
        auto_check_enabled: true,
        auto_check_hours: 12,
        auto_check_keyword: '凡人修仙传',
        auto_check_disable_failed: false,
      },
    });
    assert.match(updated.notice, /每批 18 源/);

    const taskRes = await call('extension.task', { taskId: 'auto-check' });
    assert.equal(taskRes.ok, true);
    assert.equal(taskRes.started, true);
  } finally {
    child.stdin.end();
    await new Promise((r) => child.once('close', r));
    await rm(dir, { recursive: true, force: true });
  }
});

console.log(`\nAll ${passed} unit tests passed!`);
