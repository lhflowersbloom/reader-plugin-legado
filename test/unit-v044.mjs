import assert from 'node:assert/strict';
import { hardened } from '../src/harden.js';
import { RuleContext } from '../src/engine.js';
import { fetchLegado, getCookieForUrl, setCookieString, DEFAULT_MAX_TEXT_BYTES } from '../src/http.js';

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

function mockRes(body, { status = 200, url = '', headers = {} } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const hdrs = new Headers({ 'content-type': 'text/html; charset=utf-8', ...headers });
  return {
    status,
    url,
    headers: hdrs,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
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

console.log('Running v0.4.4 unit tests...');

await test('harden: process.getBuiltinModule / binding are disabled, and a vm escape cannot load fs', () => {
  if ('getBuiltinModule' in process) assert.ok(hardened.includes('getBuiltinModule'));
  if ('getBuiltinModule' in process) assert.throws(() => process.getBuiltinModule('fs'), /disabled/);
  const ctx = new RuleContext({ source: { bookSourceUrl: 'https://h.test' }, content: 'x' });
  const out = ctx.getString('@js:Buffer.constructor("return process")().getBuiltinModule("fs").readFileSync ? "LEAK" : "no"');
  assert.notEqual(out, 'LEAK');
});

await test('redirects: Set-Cookie of a 302 hop is stored and sent on the next hop; final url is reported', async () => {
  const seen = [];
  await withMockFetch(
    async (url, init) => {
      seen.push({ url, cookie: init.headers.Cookie || '', method: init.method, redirect: init.redirect });
      if (url === 'https://login.redir.test/start') {
        return mockRes('', { status: 302, url, headers: { location: '/landing', 'set-cookie': 'sid=abc123; Path=/' } });
      }
      if (url === 'https://login.redir.test/landing') return mockRes('<p>ok</p>', { url });
      return mockRes('', { status: 404, url });
    },
    async () => {
      const res = await fetchLegado('https://login.redir.test/start');
      assert.equal(res.status, 200);
      assert.equal(res.url, 'https://login.redir.test/landing');
      assert.equal(res.body, '<p>ok</p>');
    },
  );
  assert.equal(seen.length, 2);
  assert.equal(seen[0].redirect, 'manual');
  assert.equal(seen[1].cookie, 'sid=abc123');
  assert.equal(getCookieForUrl('https://login.redir.test/x'), 'sid=abc123');
});

await test('redirects: POST + 302 continues as GET without body; 307 keeps POST; source Cookie survives same-host hop', async () => {
  const seen = [];
  await withMockFetch(
    async (url, init) => {
      seen.push({ url, method: init.method, body: init.body, cookie: init.headers.Cookie || '' });
      if (url.endsWith('/p302')) return mockRes('', { status: 302, url, headers: { location: 'https://r.redir.test/after' } });
      if (url.endsWith('/p307')) return mockRes('', { status: 307, url, headers: { location: 'https://r.redir.test/after307' } });
      if (url.endsWith('/u302')) {
        return mockRes('', { status: 302, url, headers: { location: 'https://r.redir.test/uafter', 'set-cookie': 'usid=u1; Path=/' } });
      }
      return mockRes('done', { url });
    },
    async () => {
      await fetchLegado('https://r.redir.test/p302,{"method":"POST","body":"a=1"}');
      await fetchLegado('https://r.redir.test/p307,{"method":"POST","body":"a=1"}');
      await fetchLegado('https://r.redir.test/u302,{"method":"POST","body":"a=1","headers":{"Cookie":"manual=1"}}');
    },
  );
  assert.deepEqual(seen.map((s) => s.method), ['POST', 'GET', 'POST', 'POST', 'POST', 'GET']);
  assert.equal(seen[1].body, undefined);
  assert.equal(seen[3].body, 'a=1');
  assert.equal(seen[5].cookie, 'manual=1; usid=u1');
});

await test('size limit: oversized text responses are rejected (declared and actual size)', async () => {
  await withMockFetch(
    async (url) => mockRes('x', { url, headers: { 'content-length': String(DEFAULT_MAX_TEXT_BYTES + 1) } }),
    async () => {
      await assert.rejects(() => fetchLegado('https://big.test/a'), /RESPONSE_TOO_LARGE/);
    },
  );
  await withMockFetch(
    async (url) => mockRes('0123456789', { url }),
    async () => {
      await assert.rejects(() => fetchLegado('https://big.test/b', { maxBytes: 5 }), /RESPONSE_TOO_LARGE/);
      assert.equal((await fetchLegado('https://big.test/c', { maxBytes: 50 })).body, '0123456789');
    },
  );
});

await test('java.getCookie: cookie names with regex characters are matched literally', () => {
  setCookieString('https://ck.test/', 'a.b=1; a+b=2; ab=3');
  const ctx = new RuleContext({ source: { bookSourceUrl: 'https://ck.test' }, baseUrl: 'https://ck.test/', content: '' });
  assert.equal(ctx.getString('@js:java.getCookie("https://ck.test/", "a+b")'), '2');
  assert.equal(ctx.getString('@js:java.getCookie("https://ck.test/", "a.b")'), '1');
  assert.equal(ctx.getString('@js:String(java.getCookie("https://ck.test/", "("))'), '');
});

await test('parse cache: repeated rules on the same page and on different pages stay correct', () => {
  const page1 = '<div class="t">书一</div><div class="a">作者一</div>';
  const page2 = '<div class="t">书二</div><div class="a">作者二</div>';
  const c1 = new RuleContext({ source: { bookSourceUrl: 'https://p.test' }, content: page1 });
  const c2 = new RuleContext({ source: { bookSourceUrl: 'https://p.test' }, content: page2 });
  for (let i = 0; i < 3; i++) {
    assert.equal(c1.getString('class.t@text'), '书一');
    assert.equal(c2.getString('class.t@text'), '书二');
    assert.equal(c1.getString('class.a@text'), '作者一');
    assert.equal(c2.getString('.a@text'), '作者二');
  }
});

console.log(`\nAll ${passed} unit tests passed!`);
