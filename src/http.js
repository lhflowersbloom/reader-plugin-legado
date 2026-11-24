import iconv from 'iconv-lite';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

// ---------------------------------------------------------------------------
// Cookie jar
//
// key: host name (host-only cookies) or ".example.com" (Domain cookies)
// value: Map(name -> { value, expires, savedAt })
//   expires = 0 means a session cookie. Session cookies are still persisted so
//   that logins survive a container restart, but are dropped after
//   SESSION_COOKIE_TTL_MS.
// The jar lives in the main plugin process. The sync-fetch worker thread has
// its own module instance, so sync-fetch.js passes the Cookie header in and
// merges Set-Cookie results back (see sync-fetch.js).
// ---------------------------------------------------------------------------
const cookieJar = new Map();
const SESSION_COOKIE_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_COOKIES_PER_KEY = 64;
const SAVE_DEBOUNCE_MS = 1500;

let cookieFile = '';
let cookieLoadPromise = null;
let saveTimer = null;
let saving = false;
let saveAgain = false;

function cookieBag(key) {
  let bag = cookieJar.get(key);
  if (!bag) {
    bag = new Map();
    cookieJar.set(key, bag);
  }
  return bag;
}

function isExpired(c, now = Date.now()) {
  if (c.expires) return c.expires <= now;
  return c.savedAt ? now - c.savedAt > SESSION_COOKIE_TTL_MS : false;
}

/** Load cookies persisted in `<dataDir>/cookies.json` (idempotent). */
export function initCookieStore(dataDir) {
  if (!dataDir) return Promise.resolve();
  const file = join(dataDir, 'cookies.json');
  if (cookieFile === file && cookieLoadPromise) return cookieLoadPromise;
  cookieFile = file;
  cookieLoadPromise = (async () => {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      const now = Date.now();
      for (const [key, entries] of Object.entries(raw || {})) {
        if (!entries || typeof entries !== 'object') continue;
        const bag = cookieBag(key);
        for (const [name, c] of Object.entries(entries)) {
          if (!c || typeof c.value !== 'string') continue;
          const item = { value: c.value, expires: Number(c.expires) || 0, savedAt: Number(c.savedAt) || now };
          if (isExpired(item, now)) continue;
          // Cookies set during this run (before loading finished) win.
          if (!bag.has(name)) bag.set(name, item);
        }
      }
    } catch {
      // First run or corrupt file: start empty.
    }
  })();
  return cookieLoadPromise;
}

function serializeJar() {
  const now = Date.now();
  const out = {};
  for (const [key, bag] of cookieJar) {
    const entries = {};
    for (const [name, c] of bag) {
      if (!isExpired(c, now)) entries[name] = c;
    }
    if (Object.keys(entries).length > 0) out[key] = entries;
  }
  return out;
}

async function writeCookieFile() {
  if (!cookieFile) return;
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  try {
    const dir = cookieFile.replace(/[\\/][^\\/]+$/, '');
    await mkdir(dir, { recursive: true });
    const tmp = `${cookieFile}.tmp`;
    await writeFile(tmp, JSON.stringify(serializeJar()), 'utf8');
    await rename(tmp, cookieFile);
  } catch {
    // Persisting cookies is best effort.
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      scheduleCookieSave();
    }
  }
}

function scheduleCookieSave() {
  if (!cookieFile) return; // worker thread or no storage
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void writeCookieFile();
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

/** Write pending cookie changes immediately (used before shutdown/clear). */
export async function flushCookies() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await writeCookieFile();
}

export function clearCookies() {
  cookieJar.clear();
  scheduleCookieSave();
}

export function cookieStats() {
  let domains = 0;
  let cookies = 0;
  const now = Date.now();
  for (const bag of cookieJar.values()) {
    let n = 0;
    for (const c of bag.values()) if (!isExpired(c, now)) n++;
    if (n > 0) {
      domains++;
      cookies += n;
    }
  }
  return { domains, cookies };
}

function hostOf(urlStr) {
  try {
    return new URL(String(urlStr).replace(/,\s*\{[\s\S]*\}\s*$/, '').trim()).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function getCookieForUrl(urlStr) {
  const host = hostOf(urlStr);
  if (!host) return '';
  const now = Date.now();
  const merged = new Map();
  // Domain cookies first, then host-only cookies override same-named ones.
  for (const [key, bag] of cookieJar) {
    if (!key.startsWith('.')) continue;
    const d = key.slice(1);
    if (host !== d && !host.endsWith(`.${d}`)) continue;
    for (const [name, c] of bag) if (!isExpired(c, now)) merged.set(name, c.value);
  }
  const own = cookieJar.get(host);
  if (own) for (const [name, c] of own) if (!isExpired(c, now)) merged.set(name, c.value);
  if (merged.size === 0) return '';
  return [...merged.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function parseSetCookie(raw, host, now) {
  const segs = String(raw).split(';');
  const first = segs.shift() || '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  let expires = 0;
  let maxAge = null;
  let domain = '';
  for (const seg of segs) {
    const i = seg.indexOf('=');
    const k = (i >= 0 ? seg.slice(0, i) : seg).trim().toLowerCase();
    const v = i >= 0 ? seg.slice(i + 1).trim() : '';
    if (k === 'max-age') {
      const n = Number.parseInt(v, 10);
      if (!Number.isNaN(n)) maxAge = n;
    } else if (k === 'expires') {
      const t = Date.parse(v);
      // Epoch (1970) is a common "delete" marker; 0 would mean "session cookie".
      if (!Number.isNaN(t)) expires = t > 0 ? t : 1;
    } else if (k === 'domain') {
      domain = v.replace(/^\./, '').toLowerCase();
    }
  }
  if (maxAge !== null) expires = maxAge <= 0 ? now - 1 : now + maxAge * 1000;
  let key = host;
  if (domain && (host === domain || host.endsWith(`.${domain}`))) key = `.${domain}`;
  return { key, name, item: { value, expires, savedAt: now } };
}

export function setCookieForUrl(urlStr, setCookieHeaders) {
  if (!setCookieHeaders || setCookieHeaders.length === 0) return;
  const host = hostOf(urlStr);
  if (!host) return;
  const now = Date.now();
  let changed = false;
  for (const raw of setCookieHeaders) {
    const parsed = parseSetCookie(raw, host, now);
    if (!parsed) continue;
    const bag = cookieBag(parsed.key);
    if (isExpired(parsed.item, now)) {
      if (bag.delete(parsed.name)) changed = true;
      continue;
    }
    const prev = bag.get(parsed.name);
    if (!prev || prev.value !== parsed.item.value || prev.expires !== parsed.item.expires) changed = true;
    bag.delete(parsed.name);
    bag.set(parsed.name, parsed.item);
    while (bag.size > MAX_COOKIES_PER_KEY) bag.delete(bag.keys().next().value);
  }
  if (changed) scheduleCookieSave();
}

/** Set cookies from a plain "a=1; b=2" string (used by scripts / login headers). */
export function setCookieString(urlStr, cookieStr) {
  const parts = String(cookieStr ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.includes('='));
  setCookieForUrl(urlStr, parts);
}

/** Remove cookies matching a URL / host (used by cookie.removeCookie). */
export function removeCookie(urlStr) {
  const host = hostOf(urlStr);
  if (!host) return;
  let changed = cookieJar.delete(host);
  for (const key of [...cookieJar.keys()]) {
    if (!key.startsWith('.')) continue;
    const d = key.slice(1);
    if (host === d || host.endsWith(`.${d}`)) {
      cookieJar.delete(key);
      changed = true;
    }
  }
  if (changed) scheduleCookieSave();
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
export function resolveUrl(baseUrl, target) {
  if (!target) return '';
  const trimmed = String(target).trim();
  const cleanBase = String(baseUrl ?? '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) {
    try {
      const proto = new URL(cleanBase).protocol || 'https:';
      return `${proto}${trimmed}`;
    } catch {
      return `https:${trimmed}`;
    }
  }
  try {
    return new URL(trimmed, cleanBase).href;
  } catch {
    return trimmed;
  }
}

/**
 * Parse Legado URL format: "https://example.com/search,{method:'POST',body:'q=1',headers:{...},charset:'gbk'}"
 */
export function parseLegadoUrl(rawUrl, baseUrl = '', sourceHeader = '') {
  let urlPart = String(rawUrl ?? '').trim();
  let opts = {};

  // Find trailing ",{...}" option object (allowing whitespace/newlines between , and {)
  const optMatch = /,\s*\{/.exec(urlPart);
  if (optMatch && urlPart.endsWith('}')) {
    const jsonPart = urlPart.slice(optMatch.index + 1).trim();
    urlPart = urlPart.slice(0, optMatch.index).trim();
    try {
      opts = JSON.parse(jsonPart);
    } catch {
      // Relaxed JSON (single quotes, smart quotes, or unquoted keys)
      try {
        const relaxed = jsonPart
          .replace(/[“”]/g, '"')
          .replace(/'/g, '"')
          .replace(/([{,]\s*)([a-zA-Z0-9_-]+)\s*:/g, '$1"$2":');
        opts = JSON.parse(relaxed);
      } catch {
        opts = {};
      }
    }
  }

  const finalUrl = resolveUrl(baseUrl, urlPart);
  const headers = { 'User-Agent': DEFAULT_UA };

  // Merge source-level headers
  if (sourceHeader && typeof sourceHeader === 'string' && sourceHeader.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(sourceHeader.replace(/'/g, '"'));
      Object.assign(headers, parsed);
    } catch {
      // ignore invalid source header
    }
  }

  // Merge URL-level headers
  if (opts.headers) {
    if (typeof opts.headers === 'string') {
      try {
        Object.assign(headers, JSON.parse(opts.headers.replace(/'/g, '"')));
      } catch {
        // ignore
      }
    } else if (typeof opts.headers === 'object') {
      Object.assign(headers, opts.headers);
    }
  }

  const method = String(opts.method || 'GET').toUpperCase();
  const charset = opts.charset ? String(opts.charset).toLowerCase() : '';
  const body =
    opts.body !== undefined && opts.body !== null
      ? (typeof opts.body === 'object' ? JSON.stringify(opts.body) : String(opts.body))
      : undefined;

  return { url: finalUrl, method, headers, body, charset, rawOpts: opts };
}

function detectCharset(contentType, buf, hintCharset) {
  if (hintCharset) return hintCharset;
  const ctMatch = /charset=([a-zA-Z0-9_-]+)/i.exec(contentType || '');
  if (ctMatch) return ctMatch[1].toLowerCase();
  // Peek first 2KB as latin1 for <meta charset="...">
  const head = buf.subarray(0, 2048).toString('latin1');
  const metaMatch = /<meta[^>]+charset=["']?\s*([a-zA-Z0-9_-]+)/i.exec(head);
  if (metaMatch) return metaMatch[1].toLowerCase();
  return 'utf-8';
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

/**
 * Fetch a Legado-style URL.
 *
 * options.cookieHeader: Cookie header to send instead of looking up the jar
 *   (the sync-fetch worker uses this, because its jar is not the real one).
 * options.binary: return the raw Buffer in `buffer` and skip text decoding.
 * options.maxBytes: abort bodies larger than this (binary downloads).
 */
export async function fetchLegado(rawUrl, options = {}) {
  const {
    baseUrl = '',
    sourceHeader = '',
    timeoutMs = 10_000,
    signal,
    cookieHeader,
    binary = false,
    maxBytes = 0,
    extraHeaders,
  } = options;

  const parsed = parseLegadoUrl(rawUrl, baseUrl, sourceHeader);
  if (!parsed.url || !/^https?:\/\//i.test(parsed.url)) {
    throw new Error(`Invalid URL: ${parsed.url}`);
  }

  const headers = { ...parsed.headers, ...(extraHeaders || {}) };
  const existingCookie = cookieHeader !== undefined ? cookieHeader : getCookieForUrl(parsed.url);
  if (existingCookie && !hasHeader(headers, 'cookie')) {
    headers.Cookie = existingCookie;
  }

  let bodyBuf;
  if (parsed.method !== 'GET' && parsed.method !== 'HEAD' && parsed.body !== undefined) {
    if (!hasHeader(headers, 'content-type')) {
      const trimmed = parsed.body.trim();
      headers['Content-Type'] =
        trimmed.startsWith('{') || trimmed.startsWith('[')
          ? 'application/json; charset=utf-8'
          : 'application/x-www-form-urlencoded';
    }
    if (parsed.charset && parsed.charset !== 'utf-8' && parsed.charset !== 'utf8' && iconv.encodingExists(parsed.charset)) {
      bodyBuf = iconv.encode(parsed.body, parsed.charset);
    } else {
      bodyBuf = parsed.body;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('HTTP_TIMEOUT')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(parsed.url, {
      method: parsed.method,
      headers,
      body: bodyBuf,
      redirect: 'follow',
      signal: controller.signal,
    });

    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [];
    setCookieForUrl(res.url || parsed.url, setCookies);

    const declared = Number(res.headers.get('content-length')) || 0;
    if (maxBytes && declared > maxBytes) {
      throw new Error(`RESPONSE_TOO_LARGE (${declared} bytes)`);
    }
    const arrBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrBuf);
    if (maxBytes && buf.length > maxBytes) {
      throw new Error(`RESPONSE_TOO_LARGE (${buf.length} bytes)`);
    }

    const base = {
      url: res.url || parsed.url,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      setCookies,
    };
    if (binary) return { ...base, buffer: buf };

    const cs = detectCharset(res.headers.get('content-type'), buf, parsed.charset);
    const text =
      cs === 'utf-8' || cs === 'utf8' || !iconv.encodingExists(cs)
        ? buf.toString('utf8')
        : iconv.decode(buf, cs);

    return { ...base, body: text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function encodeQueryParam(value, charset) {
  const str = String(value ?? '');
  if (!charset || charset.toLowerCase() === 'utf-8' || charset.toLowerCase() === 'utf8') {
    return encodeURIComponent(str);
  }
  if (iconv.encodingExists(charset)) {
    const buf = iconv.encode(str, charset);
    let out = '';
    for (const b of buf) {
      out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
  }
  return encodeURIComponent(str);
}
