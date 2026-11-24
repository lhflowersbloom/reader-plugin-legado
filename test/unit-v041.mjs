import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { RuleContext, resolveSourceHeader } from '../src/engine.js';
import { fetchLegado } from '../src/http.js';
import {
  applyReplaceRegex,
  fetchBookDetail,
  fetchChapterManifest,
  fetchChapterContent,
  testSourceChain,
} from '../src/legado-runner.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  [PASS] ${name}`);
}

const realFetch = globalThis.fetch;
/** Replace global fetch with a router: (url, init) => { status, body, headers } | Error. */
function installFetch(route) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const r = route(u, init, calls);
    if (r instanceof Error) throw r;
    const { status = 200, body = '', headers = { 'content-type': 'text/html; charset=utf-8' } } = r || { status: 404 };
    return new Response(body, { status, headers });
  };
  return calls;
}

console.log('Running v0.4.1 unit tests...');

try {
  // 1. replaceRegex
  await test('replaceRegex: ### only-first no longer inserts "#", multi-line rules, $1 groups, @js:', () => {
    assert.equal(applyReplaceRegex('多余A多余B', '##多余###'), 'A多余B');
    assert.equal(applyReplaceRegex('多余A多余B', '##多余'), 'AB');
    assert.equal(applyReplaceRegex('第12章', '##第(\\d+)章##Chapter $1'), 'Chapter 12');
    assert.equal(applyReplaceRegex('a广告。b推荐。c', '##广告。\n##推荐。'), 'abc');
    const ctx = new RuleContext({ content: '' });
    assert.equal(applyReplaceRegex('hello', '@js:result.toUpperCase()', ctx), 'HELLO');
  });

  // 2. header scripts
  await test('source header given as @js: is evaluated to JSON (and cached)', () => {
    const src = { bookSourceUrl: 'https://h.example.com', header: '@js:JSON.stringify({"User-Agent":"UA-X","t":String(1+1)})' };
    assert.equal(resolveSourceHeader(src), '{"User-Agent":"UA-X","t":"2"}');
    assert.equal(resolveSourceHeader(src), '{"User-Agent":"UA-X","t":"2"}');
    assert.equal(resolveSourceHeader({ header: '{"a":"b"}' }), '{"a":"b"}');
    assert.equal(resolveSourceHeader({ bookSourceUrl: 'x', header: '<js>"not json"</js>' }), '');
  });

  // 3. script runtime
  await test('runJs: cache / source.setVariable / book.putVariable / chapter.title / let reuse / nested calls', () => {
    const src = { bookSourceUrl: 'https://js.example.com', jsLib: 'const LIB_K = "k1"; function libFn(x) { return x + "_lib"; }' };
    const ctx = new RuleContext({ source: src, content: 'hi', chapter: { title: '第一章', index: 0 } });
    // let/const must not collide between calls sharing one VM context
    assert.equal(ctx.getString('@js:let a = 1; a + 1'), '2');
    assert.equal(ctx.getString('@js:let a = 5; a + 1'), '6');
    assert.equal(ctx.getString('@js:libFn(LIB_K)'), 'k1_lib');
    assert.equal(ctx.getString('@js:cache.put("tok", "abc", 60); cache.get("tok")'), 'abc');
    assert.equal(ctx.getString('@js:String(cache.get("missing"))'), 'null');
    assert.equal(ctx.getString('@js:chapter.title + "|" + title'), '第一章|第一章');
    ctx.getString('@js:source.setVariable("sv-1"); book.putVariable("bk", "bv"); ""');
    const later = new RuleContext({ source: src, content: '' });
    assert.equal(later.getString('@js:source.getVariable()'), 'sv-1');
    assert.equal(ctx.vars.bk, 'bv');
    // A nested java.getString() must not clobber the outer script's `result`
    assert.equal(ctx.getString('@js:var x = java.getString("@js:result + \'!\'"); result + "|" + x'), 'hi|hi!');
    // jsLib given as a JSON map of remote libraries is ignored instead of breaking every script
    const jsonLib = new RuleContext({ source: { bookSourceUrl: 'https://j.example.com', jsLib: '{"lib":"https://x/lib.js"}' } });
    assert.equal(jsonLib.getString('@js:1 + 1'), '2');
  });

  // 4. charset & BOM
  await test('quoted charset="gbk" header is honoured; GBK decoded as GB18030; UTF-8 BOM stripped', async () => {
    installFetch((u) => {
      if (u.endsWith('/gbk')) {
        return { body: iconv.encode('<p>中文测试·镕</p>', 'gb18030'), headers: { 'content-type': 'text/html; charset="gbk"' } };
      }
      return { body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]), headers: { 'content-type': 'application/json' } };
    });
    const r1 = await fetchLegado('https://cs.example.com/gbk');
    assert.equal(r1.body, '<p>中文测试·镕</p>');
    const r2 = await fetchLegado('https://cs.example.com/bom');
    assert.equal(r2.body, '{"a":1}');
  });

  // 5. retries
  await test('retries: network error retried when retries>0 (or URL retry option), not by default', async () => {
    let n = 0;
    installFetch(() => (++n === 1 ? new TypeError('fetch failed') : { body: 'ok' }));
    assert.equal((await fetchLegado('https://r.example.com/a', { retries: 1 })).body, 'ok');
    n = 0;
    assert.equal((await fetchLegado('https://r.example.com/a,{"retry":2}')).body, 'ok');
    n = 0;
    await assert.rejects(() => fetchLegado('https://r.example.com/a'), /fetch failed/);
  });

  // 6. TOC: detail page reuse + nextTocUrl returning several URLs
  const tocSource = {
    bookSourceUrl: 'https://t.example.com',
    bookSourceName: 'TOC测试',
    ruleBookInfo: { name: 'h1@text' },
    ruleToc: { chapterList: '.list a', chapterName: 'text', chapterUrl: 'href', nextTocUrl: '.pages a@href' },
    ruleContent: { content: '#c@html', nextContentUrl: '#n@href', replaceRegex: '##广告.*?。\n##多余###' },
  };
  await test('TOC reuses the detail page response and follows multi-URL nextTocUrl in order', async () => {
    const pager = '<div class="pages"><a href="/book/1?p=2">2</a><a href="/book/1?p=3">3</a></div>';
    const calls = installFetch((u) => {
      if (u === 'https://t.example.com/book/1') {
        return { body: `<h1>测试书</h1><div class="list"><a href="/c/1">第一章</a><a href="/c/2">第二章</a></div>${pager}` };
      }
      if (u.endsWith('?p=2')) return { body: `<div class="list"><a href="/c/3">第三章</a></div>${pager}` };
      if (u.endsWith('?p=3')) return { body: `<div class="list"><a href="/c/4">第四章</a></div>${pager}` };
      return { status: 404 };
    });
    const { meta } = await fetchBookDetail(tocSource, { bookUrl: 'https://t.example.com/book/1', title: '' });
    assert.equal(meta.title, '测试书');
    const manifest = await fetchChapterManifest(tocSource, meta, 'ref');
    assert.deepEqual(manifest.items.map((i) => i.title), ['第一章', '第二章', '第三章', '第四章']);
    assert.equal(calls.filter((u) => u === 'https://t.example.com/book/1').length, 1, 'detail page fetched once');
  });

  // 7. content paging + replaceRegex on the formatted text
  await test('content: nextContentUrl paging and replaceRegex applied to the whole chapter text', async () => {
    installFetch((u) => {
      if (u.endsWith('/c/1')) return { body: '<div id="c">正文第一段。广告：请访问xx。多余多余</div><a id="n" href="/c/1_2">下一页</a>' };
      if (u.endsWith('/c/1_2')) return { body: '<div id="c">第二页内容</div>' };
      return { status: 404 };
    });
    const res = await fetchChapterContent(tocSource, 'https://t.example.com/c/1');
    assert.equal(res.text, '正文第一段。多余\n\n第二页内容');
  });

  // 8. health check: candidate choice and stage attribution
  await test('testSourceChain tests the exact-title result first and reports content errors as "content"', async () => {
    const src = {
      bookSourceUrl: 'https://s.example.com',
      searchUrl: 'https://s.example.com/search?q={{key}}',
      ruleSearch: { bookList: '.b', name: 'a@text', bookUrl: 'a@href' },
      ruleToc: { chapterList: '.list a', chapterName: 'text', chapterUrl: 'href' },
      ruleContent: { content: '#c@text' },
    };
    const calls = installFetch((u) => {
      if (u.includes('/search')) {
        return { body: '<div class="b"><a href="/book/8">别的书</a></div><div class="b"><a href="/book/9">目标书</a></div>' };
      }
      if (u.includes('/book/')) return { body: '<div class="list"><a href="/c/1">第一章</a><a href="/c/2">第二章</a></div>' };
      return { status: 404 };
    });
    const r = await testSourceChain(src, '目标书', { stepTimeoutMs: 3000 });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'content');
    assert.match(r.message, /HTTP 404/);
    assert.equal(calls.find((u) => u.includes('/book/')), 'https://s.example.com/book/9');
  });
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\nAll ${passed} unit tests passed!`);
