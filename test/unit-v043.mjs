import assert from 'node:assert/strict';
import { RuleContext } from '../src/engine.js';
import { sanitizeHeaders, resolveUrl, DESKTOP_UA, MOBILE_UA } from '../src/http.js';
import {
  fetchChapterManifest,
  fetchChapterContent,
  searchWithSource,
  decodeRef,
  hasLoginUrl,
  ruleNeedsWebView,
} from '../src/legado-runner.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    throw err;
  }
}

async function withMockFetch(handler, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

function mockRes(body, { status = 200, url = 'http://example.com/', headers = { 'content-type': 'text/html; charset=utf-8' } } = {}) {
  const buf = Buffer.from(body, 'utf8');
  const hdrs = new Headers(headers);
  return {
    status,
    url,
    headers: hdrs,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

const BASE = 'http://example.com/';

function ctxFor(html, extra = {}) {
  return new RuleContext({ source: { bookSourceUrl: BASE }, baseUrl: BASE, content: html, key: 'k', page: 1, ...extra });
}

console.log('Running v0.4.3 unit tests...');

await test('P1: XPath nested predicate fallback //li[span]/a', () => {
  const html = '<ul><li><div><span>1</span></div><a href="/c1">第一章</a></li></ul>';
  const ctx = ctxFor(html);
  assert.equal(ctx.getString('//li[span]/a/@href', true), 'http://example.com/c1');
});

await test('P1: desktop UA retry runs ONLY when mobile TOC parses 0 chapters (no extra request on working m.* source)', async () => {
  const calls = [];
  await withMockFetch(
    async (url, init) => {
      const ua = init?.headers?.['User-Agent'] || init?.headers?.['user-agent'] || '';
      calls.push({ url, ua });
      // Working mobile source: returns chapters on first mobile request -> must NOT fire a 2nd desktop request!
      if (url.startsWith('https://m.good.test/')) {
        return mockRes('<ul class="list"><a href="/c1">第1章</a></ul>', { url });
      }
      // Site that redirects mobile UA from www -> w2 mobile page where PC TOC selector returns 0 chapters:
      if (url === 'https://www.heiyan.test/book/1') {
        if (ua.includes('Mobile')) {
          return mockRes('<div class="wap-empty">手机端不含电脑目录结构</div>', { url: 'https://w2.heiyan.test/book/1' });
        }
        return mockRes('<ul class="pc-toc"><li><a href="/book/1/ch1">第一章 仙路</a></li></ul>', { url: 'https://www.heiyan.test/book/1' });
      }
      return mockRes('', { status: 404, url });
    },
    async () => {
      const mobileSrc = {
        bookSourceUrl: 'https://m.good.test',
        ruleToc: { chapterList: '.list a', chapterName: 'text', chapterUrl: 'href' },
      };
      const m1 = await fetchChapterManifest(mobileSrc, { bookUrl: 'https://m.good.test/b/1' }, 'ref1');
      assert.equal(m1.items.length, 1);
      assert.equal(calls.length, 1, 'working m.* source should only be fetched once');

      calls.length = 0;
      const pcRedirectSrc = {
        bookSourceUrl: 'https://www.heiyan.test',
        ruleBookInfo: { name: 'h1@text' },
        ruleToc: { chapterList: '.pc-toc li a', chapterName: 'text', chapterUrl: 'href' },
      };
      const m2 = await fetchChapterManifest(pcRedirectSrc, { bookUrl: 'https://www.heiyan.test/book/1' }, 'ref2');
      assert.equal(m2.items.length, 1);
      assert.equal(m2.items[0].title, '第一章 仙路');
      assert.ok(calls.some((c) => c.ua === DESKTOP_UA), 'retried with desktop UA');
      assert.ok(calls.every((c) => c.url === 'https://www.heiyan.test/book/1'), 'never rewrote hostname via regex');
    },
  );
});

await test('P2: text selector prefers exact match over substring', () => {
  const html = '<div><a href="/long">查看章节目录</a><a href="/exact">目录</a></div>';
  const ctx = ctxFor(html);
  assert.equal(ctx.getString('text.目录@href', true), 'http://example.com/exact');
});

await test('P2: text selector ignores surrounding whitespace', () => {
  const html = '<div><a href="/w">  目录  </a><a href="/x">目录大全</a></div>';
  const ctx = ctxFor(html);
  assert.equal(ctx.getString('text.目录@href', true), 'http://example.com/w');
});

await test('P3: empty standard/restricted headers are cleaned while custom empty headers stay for API signing', () => {
  const out = sanitizeHeaders({
    'User-Agent': MOBILE_UA,
    'user-agent': 'CustomUA/1.0',
    'Keep-Alive': '',
    Connection: 'keep-alive',
    Host: 'x',
    'Content-Length': '10',
    AUTHORIZATION: '',
    'qm-params': '',
    'X-Test': 'ok',
    Referer: '  ',
  });
  assert.deepEqual(out, { 'user-agent': 'CustomUA/1.0', AUTHORIZATION: '', 'qm-params': '', 'X-Test': 'ok' });
});

await test('P4: unquoted CSS attribute value with spaces/semicolon is retried', () => {
  const html = '<div style="text-indent: 2em;">正文内容</div><div style="color:red">x</div>';
  const ctx = ctxFor(html);
  assert.equal(ctx.getString('div[style=text-indent: 2em;]@text'), '正文内容');
});

await test('P5: non-http base throws for relative URL, absolute still works', () => {
  assert.throws(() => resolveUrl('DragonQuestQBall', '/search?q=1'), /不是有效的 http\(s\) 地址/);
  assert.equal(resolveUrl('DragonQuestQBall', 'https://api.example.com/x'), 'https://api.example.com/x');
  assert.equal(resolveUrl('', 'https://api.example.com/x'), 'https://api.example.com/x');
});

await test('P6: webView and loginUrl hints trigger ONLY when chapter fails, never breaking working webView sources', async () => {
  assert.equal(hasLoginUrl({ loginUrl: 'null' }), false);
  assert.equal(hasLoginUrl({ loginUrl: '{"url":""}' }), false);
  assert.equal(hasLoginUrl({ loginUrl: 'https://example.com/login' }), true);
  assert.equal(ruleNeedsWebView("https://example.com/ch1,{'webView': true}", {}), true);
  assert.equal(ruleNeedsWebView('https://example.com/ch1', { webJs: '' }), false);

  await withMockFetch(
    async (url) => {
      if (url.includes('/works')) return mockRes('<div id="nr">' + '正文内容充足'.repeat(10) + '</div>', { url });
      if (url.includes('/empty')) return mockRes('<div id="showReading"></div>', { url });
      return mockRes('Forbidden', { status: 403, url });
    },
    async () => {
      // 1. Source with webView:true in chapterUrl that actually works over plain HTTP (like 17k / 红袖添香 / 桃桃书)
      const workingWvSrc = {
        bookSourceUrl: 'https://wv.test',
        ruleContent: { content: '#nr@text' },
      };
      const okRes = await fetchChapterContent(workingWvSrc, "https://wv.test/works,{'webView': true}");
      assert.match(okRes.text, /正文内容充足/);

      // 2. Source with webView:true whose static HTML is empty (like 猫九小说) -> clear WebView error
      const failWvSrc = {
        bookSourceUrl: 'https://maojiu.test',
        loginUrl: 'https://maojiu.test/login',
        ruleContent: { content: '#showReading@text' },
      };
      await assert.rejects(
        () => fetchChapterContent(failWvSrc, "https://maojiu.test/empty,{'webView': true}"),
        /需要 WebView 渲染，插件不支持/,
      );

      // 3. Source with real loginUrl that returns empty / 403 -> clear login hint
      const loginSrc = {
        bookSourceUrl: 'https://vip.test',
        loginUrl: 'https://vip.test/login',
        ruleContent: { content: '#vip@text' },
      };
      await assert.rejects(() => fetchChapterContent(loginSrc, 'https://vip.test/empty'), /此书源需要登录/);
      await assert.rejects(() => fetchChapterContent(loginSrc, 'https://vip.test/403'), /HTTP 403（此书源需要登录）/);
    },
  );
});

await test('Compat: OpenSSL 3 DESKeySpec + SecretKeyFactory + new String(bytes, charset) + java.desDecodeToString', () => {
  const ctx = ctxFor('plain');
  const encBase64 = ctx.getString("@js:java.desEncodeToBase64String('凡人修仙传DES测试', 'KK!%G3JdCHJxpAF3', 'DES/CBC/PKCS5Padding', '1ae2c94b')");
  assert.ok(encBase64.length > 8);
  const dec1 = ctx.getString(`@js:java.desBase64DecodeToString('${encBase64}', 'KK!%G3JdCHJxpAF3', 'DES/CBC/PKCS5Padding', '1ae2c94b')`);
  assert.equal(dec1, '凡人修仙传DES测试');

  const rhinoDec = ctx.getString(`<js>
var javaImport = new JavaImporter();
javaImport.importPackage(Packages.java.lang, Packages.javax.crypto.spec, Packages.javax.crypto, Packages.java.util);
with (javaImport) {
  let dks = new DESKeySpec(String("KK!%G3JdCHJxpAF3%Vg9pN").getBytes());
  let kf = SecretKeyFactory.getInstance("DES");
  let sk = kf.generateSecret(dks);
  let cipher = Cipher.getInstance("DES/CBC/PKCS5Padding");
  let iv = new IvParameterSpec(String("1ae2c94b").getBytes("utf-8"));
  cipher.init(Cipher.DECRYPT_MODE, sk, iv);
  String(new String(cipher.doFinal(Base64.getDecoder().decode("${encBase64}")), "utf-8"));
}
</js>`);
  assert.equal(rhinoDec, '凡人修仙传DES测试');
});

await test('Compat: searchUrl java.put vars propagate to book meta & book.totalChapterNum propagates to content', async () => {
  await withMockFetch(
    async (url) => {
      if (url.startsWith('https://api.test/search')) {
        return mockRes(JSON.stringify({ list: [{ name: '测试漫画', id: '99' }] }), {
          url,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('https://api.test/toc')) {
        return mockRes(JSON.stringify({ chapters: [{ name: '第1话', u: 'https://api.test/ch/1' }, { name: '第2话', u: 'https://api.test/ch/2' }] }), {
          url,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('https://api.test/ch/1')) {
        return mockRes('ok', { url });
      }
      return mockRes('', { status: 404, url });
    },
    async () => {
      const src = {
        bookSourceUrl: 'https://api.test',
        searchUrl: '@js:java.put("tok","secret123");"https://api.test/search?q="+key',
        ruleSearch: { bookList: '$.list[*]', name: '$.name', bookUrl: 'https://api.test/toc?id={{$.id}}&t={{java.get("tok")}}' },
        ruleToc: { chapterList: '$.chapters[*]', chapterName: '$.name', chapterUrl: '$.u' },
        ruleContent: { content: '@js:"total=" + book.totalChapterNum + ",tok=" + java.get("tok") + ",body=超过三十个字符的正文测试内容用于校验通过"' },
      };
      const found = await searchWithSource(src, '测试');
      assert.equal(found.length, 1);
      assert.equal(found[0].meta.vars.tok, 'secret123');
      assert.equal(found[0].meta.bookUrl, 'https://api.test/toc?id=99&t=secret123');

      const manifest = await fetchChapterManifest(src, found[0].meta, found[0].entry.ref);
      assert.equal(manifest.items.length, 2);
      const dec = decodeRef(manifest.items[0].ref);
      assert.equal(dec.n, 2);
      assert.equal(dec.v.tok, 'secret123');

      const content = await fetchChapterContent(src, dec.c, { vars: dec.v, totalChapterNum: dec.n });
      assert.match(content.text, /total=2,tok=secret123/);
    },
  );
});

console.log(`\nAll ${passed} unit tests passed!`);
