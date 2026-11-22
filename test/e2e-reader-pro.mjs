import { readFile } from 'node:fs/promises';

const BASE = 'http://127.0.0.1:5889';
const TGZ_PATH = '/tmp/reader-plugin-legado/reader-plugin-legado-0.2.0.tgz';
const SOURCES_PATH = '/tmp/reader-plugin-legado/verified-e2e-sources.json';

async function req(method, path, body, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${typeof json === 'string' ? json.slice(0, 300) : JSON.stringify(json)}`);
  }
  return json;
}

// 1. Register admin user
const reg = await req('POST', '/api/v1/auth/register', { username: 'admin', password: 'TestPassword123!' });
let token = reg.accessToken || reg.access_token || reg.token || reg.tokens?.accessToken;
if (!token) {
  const login = await req('POST', '/api/v1/auth/login', { username: 'admin', password: 'TestPassword123!' });
  token = login.accessToken || login.access_token || login.token || login.tokens?.accessToken;
  if (!token) console.log('Auth response keys:', JSON.stringify(login));
}
console.log('1. Registered admin, got token:', Boolean(token));

// 2. Upload plugin .tgz
const tgzBuf = await readFile(TGZ_PATH);
const form = new FormData();
form.append('trusted', 'true');
form.append('file', new Blob([tgzBuf], { type: 'application/gzip' }), 'reader-plugin-legado-0.2.0.tgz');
const installed = await req('POST', '/api/v1/plugins/upload', form, token);
console.log('2. Uploaded & installed plugin:', installed.plugin?.pluginId, installed.plugin?.version, 'enabled:', installed.plugin?.enabled);

// 3. Create source instance
const created = await req('POST', '/api/v1/sources', {
  pluginId: 'legado-booksource',
  sourceType: 'legado',
  name: 'Legado 网络书源',
  config: {},
}, token);
const sourceId = created.source.id;
console.log('3. Created source instance:', sourceId, created.source.name);

// 4. Open extension manage page & import top 10 verified sources
const page = await req('GET', '/api/v1/plugins/legado-booksource/pages/manage', undefined, token);
console.log('4. Manage page loaded:', page.page?.title || page.title);

const verifiedSources = JSON.parse(await readFile(SOURCES_PATH, 'utf8'));
const top10 = verifiedSources.slice(0, 10);
const importRes = await req('POST', '/api/v1/plugins/legado-booksource/pages/manage', {
  action: 'import-json',
  values: { json_text: JSON.stringify(top10), skip_paid: true },
}, token);
console.log('5. Import action notice:', importRes.page?.notice || importRes.notice);

// 5. Search via SSE stream
const searchRes = await fetch(`${BASE}/api/v1/sources/${sourceId}/search`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query: '凡人修仙传', sessionId: 'test-session-1234567890' }),
});
const sseText = await searchRes.text();
const dataLines = sseText.split('\n').filter((l) => l.startsWith('data:'));
let firstItem = null;
let totalItems = 0;
for (const line of dataLines) {
  try {
    const evt = JSON.parse(line.slice(5).trim());
    if (Array.isArray(evt.items)) {
      totalItems += evt.items.length;
      if (!firstItem && evt.items.length > 0) firstItem = evt.items[0];
    }
  } catch {
    // ignore
  }
}
console.log(`6. Search SSE received ${dataLines.length} events, ${totalItems} books. First:`, firstItem?.title, 'from', firstItem?.sourceName);

if (!firstItem) throw new Error('No search results returned!');

// 6. Detail
const detail = await req('GET', `/api/v1/sources/${sourceId}/detail?ref=${encodeURIComponent(firstItem.ref)}`, undefined, token);
console.log('7. Detail fetched:', detail.entry?.title || detail.title);

// 7. Acquire book into shelf
const acq = await req('POST', `/api/v1/sources/${sourceId}/acquire`, { entryRef: firstItem.ref }, token);
console.log('8. Acquired book:', JSON.stringify(acq).slice(0, 200));

console.log('\nALL READER-PRO E2E CHECKS PASSED!');
