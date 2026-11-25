import crypto from 'node:crypto';
import vm from 'node:vm';
import * as cheerio from 'cheerio';
import { JSONPath } from 'jsonpath-plus';
import xpath from 'xpath';
import { DOMParser } from '@xmldom/xmldom';
import iconv from 'iconv-lite';
import { resolveUrl, getCookieForUrl, setCookieString, removeCookie, encodeQueryParam, DEFAULT_UA } from './http.js';
import { syncFetchLegado } from './sync-fetch.js';

const CN_NUM_MAP = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT_MAP = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

function cnToNumber(cn) {
  let section = 0;
  let total = 0;
  let num = 0;
  let hasUnit = false;
  for (const ch of cn) {
    if (ch in CN_NUM_MAP) {
      num = CN_NUM_MAP[ch];
    } else if (ch in CN_UNIT_MAP) {
      hasUnit = true;
      const u = CN_UNIT_MAP[ch];
      if (u === 10000) {
        section = (section + num) * u;
        total += section;
        section = 0;
      } else {
        section += (num || (u === 10 && section === 0 ? 1 : 0)) * u;
      }
      num = 0;
    }
  }
  if (!hasUnit) {
    let digits = '';
    for (const ch of cn) if (ch in CN_NUM_MAP) digits += String(CN_NUM_MAP[ch]);
    return digits ? Number(digits) : NaN;
  }
  return total + section + num;
}

function toNumChapter(str) {
  if (!str) return '';
  return String(str).replace(/第([零〇一二两三四五六七八九十百千万]+)([章节回卷集部篇])/g, (full, cn, tail) => {
    const n = cnToNumber(cn);
    return Number.isNaN(n) ? full : `第${n}${tail}`;
  });
}

function toNodeBytes(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (Array.isArray(input)) return Buffer.from(input.map((b) => (b < 0 ? b + 256 : b & 0xff)));
  return Buffer.from(String(input ?? ''), 'utf8');
}

/**
 * OpenSSL 3 disables single-DES (`des-cbc` / `des-ecb`) in the default provider,
 * whereas Triple-DES EDE with K1=K2=K3=K8 is mathematically identical to single-DES
 * and works natively on Node 22/24 without `--openssl-legacy-provider`.
 */
function normalizeDesKeyAndAlg(algBase, blockMode, rawKey) {
  if (algBase === 'DES') {
    const k8 = Buffer.alloc(8);
    rawKey.copy(k8, 0, 0, Math.min(8, rawKey.length));
    return {
      alg: blockMode === 'ECB' ? 'des-ede3-ecb' : 'des-ede3-cbc',
      keyBuf: Buffer.concat([k8, k8, k8]),
      ivLen: 8,
    };
  }
  if (algBase === 'DESEDE' || algBase === '3DES') {
    const k24 = Buffer.alloc(24);
    rawKey.copy(k24, 0, 0, Math.min(24, rawKey.length));
    if (rawKey.length > 8 && rawKey.length <= 16) {
      rawKey.copy(k24, 16, 0, 8);
    } else if (rawKey.length > 0 && rawKey.length <= 8) {
      k24.copy(k24, 8, 0, 8);
      k24.copy(k24, 16, 0, 8);
    }
    return {
      alg: blockMode === 'ECB' ? 'des-ede3-ecb' : 'des-ede3-cbc',
      keyBuf: k24,
      ivLen: 8,
    };
  }
  const bits = rawKey.length <= 16 ? 128 : rawKey.length <= 24 ? 192 : 256;
  const targetLen = bits / 8;
  const kAes = rawKey.length === targetLen ? rawKey : (() => {
    const b = Buffer.alloc(targetLen);
    rawKey.copy(b, 0, 0, Math.min(targetLen, rawKey.length));
    return b;
  })();
  return {
    alg: blockMode === 'ECB' ? `aes-${bits}-ecb` : `aes-${bits}-${blockMode.toLowerCase()}`,
    keyBuf: kAes,
    ivLen: 16,
  };
}

function buildRhinoShim() {
  function SecretKeySpec(keyBytes, alg) {
    return { key: toNodeBytes(keyBytes), alg: String(alg || 'AES') };
  }
  function DESKeySpec(keyBytes) {
    return { key: toNodeBytes(keyBytes).subarray(0, 8), alg: 'DES' };
  }
  function DESedeKeySpec(keyBytes) {
    return { key: toNodeBytes(keyBytes).subarray(0, 24), alg: 'DESede' };
  }
  function IvParameterSpec(ivBytes) {
    return { iv: toNodeBytes(ivBytes) };
  }
  const SecretKeyFactory = {
    getInstance(alg) {
      return {
        generateSecret(spec) {
          return spec?.key ? spec : { key: toNodeBytes(spec), alg: String(alg || 'DES') };
        },
      };
    },
  };
  const Cipher = {
    ENCRYPT_MODE: 1,
    DECRYPT_MODE: 2,
    getInstance(transformation) {
      let mode = 2;
      let rawKey = Buffer.alloc(16);
      let ivBuf = null;
      const parts = String(transformation || 'AES/CBC/PKCS5Padding').split('/');
      const algBase = parts[0].toUpperCase();
      const blockMode = (parts[1] || 'ECB').toUpperCase();
      const padding = (parts[2] || 'PKCS5PADDING').toUpperCase();
      return {
        init(opmode, keySpec, ivSpec) {
          mode = Number(opmode);
          rawKey = keySpec?.key ? toNodeBytes(keySpec.key) : toNodeBytes(keySpec);
          if (blockMode !== 'ECB') {
            const ivLen = algBase.startsWith('DES') ? 8 : 16;
            const rawIv = ivSpec?.iv ? toNodeBytes(ivSpec.iv) : (ivSpec ? toNodeBytes(ivSpec) : Buffer.alloc(ivLen));
            ivBuf = Buffer.alloc(ivLen);
            rawIv.copy(ivBuf, 0, 0, Math.min(ivLen, rawIv.length));
          }
        },
        doFinal(data) {
          const buf = toNodeBytes(data);
          const { alg, keyBuf } = normalizeDesKeyAndAlg(algBase, blockMode, rawKey);
          const fn = mode === 1 ? crypto.createCipheriv : crypto.createDecipheriv;
          const c = fn(alg, keyBuf, blockMode === 'ECB' ? null : ivBuf);
          if (padding === 'NOPADDING') c.setAutoPadding(false);
          return Buffer.concat([c.update(buf), c.final()]);
        },
      };
    },
  };
  const Base64 = {
    DEFAULT: 0,
    NO_WRAP: 2,
    getDecoder: () => ({ decode: (s) => Buffer.from(String(s ?? ''), 'base64') }),
    getMimeDecoder: () => ({ decode: (s) => Buffer.from(String(s ?? '').replace(/\s+/g, ''), 'base64') }),
    getEncoder: () => ({ encodeToString: (b) => toNodeBytes(b).toString('base64'), encode: (b) => Buffer.from(toNodeBytes(b).toString('base64')) }),
    decode: (s) => Buffer.from(String(s ?? ''), 'base64'),
    encodeToString: (b) => toNodeBytes(b).toString('base64'),
  };
  const Arrays = {
    copyOfRange: (arr, from, to) => toNodeBytes(arr).subarray(Number(from) || 0, to === undefined ? undefined : Number(to)),
    copyOf: (arr, len) => {
      const src = toNodeBytes(arr);
      const out = Buffer.alloc(Number(len) || 0);
      src.copy(out, 0, 0, Math.min(src.length, out.length));
      return out;
    },
  };
  const MessageDigest = {
    getInstance(alg) {
      let h = crypto.createHash(nodeHashName(alg));
      return {
        update(b) { h.update(toNodeBytes(b)); },
        digest(b) {
          if (b !== undefined) h.update(toNodeBytes(b));
          const res = h.digest();
          h = crypto.createHash(nodeHashName(alg));
          return res;
        },
      };
    },
  };
  function JString(v, cs) {
    let str;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array || Array.isArray(v)) {
      const b = toNodeBytes(v);
      const enc = cs ? String(cs).toLowerCase() : 'utf-8';
      str = enc !== 'utf-8' && enc !== 'utf8' && iconv.encodingExists(enc) ? iconv.decode(b, enc) : b.toString('utf8');
    } else {
      str = String(v ?? '');
    }
    return new.target ? new globalThis.String(str) : str;
  }
  Object.setPrototypeOf(JString, globalThis.String);
  JString.prototype = globalThis.String.prototype;

  const Packages = {
    java: {
      lang: {
        String: JString,
      },
      util: { Base64, Arrays },
      security: { MessageDigest },
    },
    javax: {
      crypto: {
        Cipher,
        SecretKeyFactory,
        spec: { SecretKeySpec, DESKeySpec, DESedeKeySpec, IvParameterSpec },
      },
    },
    android: {
      util: { Base64 },
    },
  };
  function JavaImporter(...pkgs) {
    const scope = {};
    const addPkg = (p) => {
      if (p && typeof p === 'object') {
        for (const [k, v] of Object.entries(p)) {
          scope[k] = v;
        }
      }
    };
    pkgs.forEach(addPkg);
    scope.importPackage = (...more) => more.forEach(addPkg);
    return scope;
  }
  return { Packages, JavaImporter };
}
const RHINO_SHIM = buildRhinoShim();

// ---------------------------------------------------------------------------
// Cross-stage script state (Legado keeps these per source / per app)
// ---------------------------------------------------------------------------
const SOURCE_VARS = new Map(); // bookSourceUrl -> source.getVariable() value
const JS_CACHE = new Map(); // cache.put/get: key -> { value, expires }
const MEM_CACHE = new Map(); // cache.putMemory/getFromMemory: key -> raw value
const JS_CACHE_MAX = 500;

function boundedSet(map, key, value, max = JS_CACHE_MAX) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

function jsCachePut(key, value, saveSeconds) {
  const secs = Number(saveSeconds) || 0;
  boundedSet(JS_CACHE, String(key), {
    value: value === undefined || value === null ? '' : String(value),
    expires: secs > 0 ? Date.now() + secs * 1000 : 0,
  });
}

/** Legado's cache.get returns null for a missing / expired key. */
function jsCacheGet(key) {
  const k = String(key);
  const rec = JS_CACHE.get(k);
  if (!rec) return null;
  if (rec.expires && rec.expires <= Date.now()) {
    JS_CACHE.delete(k);
    return null;
  }
  return rec.value;
}

const JS_CACHE_API = {
  put: (k, v, t) => {
    jsCachePut(k, v, t);
    return v;
  },
  get: (k) => jsCacheGet(k),
  delete: (k) => {
    JS_CACHE.delete(String(k));
  },
  putMemory: (k, v) => {
    boundedSet(MEM_CACHE, String(k), v);
    return v;
  },
  getFromMemory: (k) => (MEM_CACHE.has(String(k)) ? MEM_CACHE.get(String(k)) : null),
  deleteMemory: (k) => {
    MEM_CACHE.delete(String(k));
  },
};

/** jsLib may be plain JS or a JSON map of remote libraries (unsupported): only run plain JS. */
function jsLibCode(source) {
  const lib = String(source?.jsLib ?? '').trim();
  if (!lib) return '';
  if (lib.startsWith('{')) {
    try {
      JSON.parse(lib);
      return '';
    } catch {
      // not JSON: treat as code
    }
  }
  return lib;
}

// Plain scripts get 5 s. Scripts doing blocking HTTP (java.ajax / java.get(url) / java.post ...)
// spend that time waiting on the network, so they get 20 s (群小说网 fetches its homepage for a token in ~5–6 s).
export const JS_TIMEOUT_MS = 5000;
export const JS_NET_TIMEOUT_MS = 20_000;
const JS_NET_RE = /\bjava\s*\.\s*(ajax|ajaxAll|get|post|connect)\s*\(/;

export function jsTimeoutFor(code) {
  return JS_NET_RE.test(String(code ?? '')) ? JS_NET_TIMEOUT_MS : JS_TIMEOUT_MS;
}

const GET_BYTES_POLYFILL =
  'if (!String.prototype.getBytes) { Object.defineProperty(String.prototype, "getBytes", { value: function(cs) { return __strToBytes(this, cs); }, configurable: true }); }';

function jsStaticGlobals() {
  return {
    org: {
      jsoup: {
        Jsoup: {
          parse(html) {
            const $ = cheerio.load(String(html ?? ''));
            return wrapCheerioEl($, $.root()[0]);
          },
        },
      },
    },
    Packages: RHINO_SHIM.Packages,
    JavaImporter: RHINO_SHIM.JavaImporter,
    cache: JS_CACHE_API,
    __strToBytes: (s, cs) => {
      const enc = cs ? String(cs).toLowerCase() : 'utf-8';
      return enc !== 'utf-8' && enc !== 'utf8' && iconv.encodingExists(enc)
        ? iconv.encode(String(s ?? ''), enc)
        : Buffer.from(String(s ?? ''), 'utf8');
    },
    Buffer,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    console: { log() {}, warn() {}, error() {} },
  };
}

// Book source `header` may itself be a script (@js: / <js>) returning a JSON object.
const HEADER_CACHE = new Map();
const HEADER_TTL_MS = 10 * 60_000;

/** Resolve a source's header to a JSON string (scripts are evaluated and cached for 10 minutes). */
export function resolveSourceHeader(source) {
  const raw = String(source?.header ?? '').trim();
  if (!raw) return '';
  const isJs = raw.startsWith('@js:') || /^<js>[\s\S]*<\/js>$/i.test(raw);
  if (!isJs) return raw;
  const cacheKey = `${source.bookSourceUrl || ''}\n${raw}`;
  const hit = HEADER_CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < HEADER_TTL_MS) return hit.value;
  const code = raw.startsWith('@js:') ? raw.slice(4) : raw.replace(/^<js>/i, '').replace(/<\/js>$/i, '');
  let value = '';
  try {
    // header: '' prevents the script's own java.ajax calls from recursing into this resolver.
    const ctx = new RuleContext({ source: { ...source, header: '' }, baseUrl: source.bookSourceUrl || '', content: '' });
    const out = ctx.runJs(ctx.prepareJsCode(code), '', '');
    value = out && typeof out === 'object' ? JSON.stringify(out) : String(out ?? '').trim();
  } catch {
    value = '';
  }
  if (!value.startsWith('{')) value = '';
  boundedSet(HEADER_CACHE, cacheKey, { value, at: Date.now() }, 200);
  return value;
}

function md5Hex(input) {
  return crypto.createHash('md5').update(String(input ?? ''), 'utf8').digest('hex');
}

/** Map Java digest / HMAC algorithm names (SHA-256, HmacSHA1 ...) to Node names. */
function nodeHashName(name) {
  const n = String(name || 'MD5').toLowerCase().replace(/^hmac/, '').replace(/-/g, '');
  if (n === 'sha') return 'sha1';
  return n;
}

function digestBuf(data, algorithm) {
  return crypto.createHash(nodeHashName(algorithm)).update(String(data ?? ''), 'utf8').digest();
}

function hmacBuf(data, algorithm, key) {
  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(String(key ?? ''), 'utf8');
  return crypto.createHmac(nodeHashName(algorithm), keyBuf).update(String(data ?? ''), 'utf8').digest();
}

function createSymmetricCrypto(transformation, key, iv) {
  const parts = String(transformation || 'AES/CBC/PKCS5Padding').split('/');
  const algBase = parts[0].toUpperCase();
  const mode = (parts[1] || 'CBC').toUpperCase();
  const rawKey = Buffer.isBuffer(key) ? key : Buffer.from(String(key ?? ''), 'utf8');
  const { alg, keyBuf, ivLen } = normalizeDesKeyAndAlg(algBase, mode, rawKey);
  const rawIv = iv !== undefined && iv !== null
    ? (Buffer.isBuffer(iv) ? iv : Buffer.from(String(iv), 'utf8'))
    : Buffer.alloc(ivLen);
  const ivBuf = Buffer.alloc(ivLen);
  rawIv.copy(ivBuf, 0, 0, Math.min(ivLen, rawIv.length));
  const effectiveIv = mode === 'ECB' ? null : ivBuf;

  return {
    encryptBase64(plain) {
      const cipher = crypto.createCipheriv(alg, keyBuf, effectiveIv);
      return Buffer.concat([cipher.update(String(plain ?? ''), 'utf8'), cipher.final()]).toString('base64');
    },
    encryptHex(plain) {
      const cipher = crypto.createCipheriv(alg, keyBuf, effectiveIv);
      return Buffer.concat([cipher.update(String(plain ?? ''), 'utf8'), cipher.final()]).toString('hex');
    },
    decryptStr(input) {
      const buf = Buffer.isBuffer(input)
        ? input
        : /^[0-9a-fA-F]+$/.test(String(input)) && String(input).length % 2 === 0 && !String(input).includes('=')
          ? Buffer.from(String(input), 'hex')
          : Buffer.from(String(input ?? ''), 'base64');
      const decipher = crypto.createDecipheriv(alg, keyBuf, effectiveIv);
      return Buffer.concat([decipher.update(buf), decipher.final()]).toString('utf8');
    },
    decrypt(input) {
      return this.decryptStr(input);
    },
  };
}

/**
 * Lightweight Jsoup wrapper around cheerio for scripts calling org.jsoup.Jsoup.parse(html)
 */
function wrapCheerioEl($, el) {
  const $el = $(el);
  return {
    text: () => $el.text().trim(),
    ownText: () => $el.contents().filter((_, n) => n.type === 'text').text().trim(),
    html: () => $el.html() || '',
    outerHtml: () => $.html(el) || '',
    attr: (k) => $el.attr(k) || '',
    select: (sel) => wrapCheerioList($, $el.find(sel).toArray()),
    selectFirst: (sel) => {
      const f = $el.find(sel).first()[0];
      return f ? wrapCheerioEl($, f) : null;
    },
    toString: () => $.html(el) || '',
  };
}

function wrapCheerioList($, els) {
  const arr = els.map((el) => wrapCheerioEl($, el));
  arr.size = () => arr.length;
  arr.get = (i) => arr[i];
  arr.first = () => arr[0] || null;
  arr.last = () => arr[arr.length - 1] || null;
  arr.toArray = () => arr.slice();
  arr.text = () => arr.map((e) => e.text()).join(' ').trim();
  arr.html = () => arr.map((e) => e.html()).join('\n');
  arr.attr = (k) => (arr[0] ? arr[0].attr(k) : '');
  arr.select = (sel) => {
    const found = [];
    for (const el of els) found.push(...$(el).find(sel).toArray());
    return wrapCheerioList($, found);
  };
  return arr;
}

function decorateElementsArray(arr) {
  if (!Array.isArray(arr)) return arr;
  arr.size = () => arr.length;
  arr.get = (i) => arr[i];
  arr.toArray = () => arr.slice();
  return arr;
}

function tryParseJson(input) {
  if (input && typeof input === 'object') return input;
  if (typeof input !== 'string') return null;
  const t = input.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function isLikelyHtml(str) {
  if (typeof str !== 'string') return false;
  const t = str.trimStart().slice(0, 64).toLowerCase();
  return t.startsWith('<!doctype') || t.startsWith('<html') || t.startsWith('<div') || t.startsWith('<body');
}

function normalizeUrlResult(s, baseUrl) {
  if (!s || s.length > 4096 || isLikelyHtml(s)) return '';
  // Preserve Legado multiline URL options: "https://...,{\n  \"method\": \"POST\"...\n}"
  const optMatch = /,\s*\{/.exec(s);
  if (optMatch && s.trimEnd().endsWith('}')) {
    const urlPart = s.slice(0, optMatch.index).trim();
    const optPart = s.slice(optMatch.index);
    return resolveUrl(baseUrl, urlPart) + optPart;
  }
  const firstLine = s.split('\n')[0].trim();
  return resolveUrl(baseUrl, firstLine);
}

function splitTopLevel(str, sep) {
  const parts = [];
  let cur = '';
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const prev = i > 0 ? str[i - 1] : '';
    if (ch === "'" && !inDouble && prev !== '\\') inSingle = !inSingle;
    else if (ch === '"' && !inSingle && prev !== '\\') inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === '(') depthParen++;
      else if (ch === ')' && depthParen > 0) depthParen--;
      else if (ch === '[') depthBracket++;
      else if (ch === ']' && depthBracket > 0) depthBracket--;
      else if (ch === '{') depthBrace++;
      else if (ch === '}' && depthBrace > 0) depthBrace--;
    }

    if (
      !inSingle && !inDouble &&
      depthParen === 0 && depthBracket === 0 && depthBrace === 0 &&
      str.startsWith(sep, i)
    ) {
      parts.push(cur);
      cur = '';
      i += sep.length - 1;
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/**
 * Split a rule into main rule part and trailing JS script (@js:... or <js>...</js>)
 */
function splitRuleAndJs(rule) {
  const raw = String(rule ?? '').trim();
  if (!raw) return { rulePart: '', jsParts: [] };

  // Handle <js>...</js> blocks
  if (/<js>[\s\S]*?<\/js>/i.test(raw)) {
    const jsParts = [];
    const rulePart = raw.replace(/<js>([\s\S]*?)<\/js>/gi, (_, code) => {
      jsParts.push(code.trim());
      return '';
    }).trim();
    return { rulePart, jsParts };
  }

  // Handle @js:
  const atJsIdx = raw.indexOf('@js:');
  if (atJsIdx >= 0) {
    return {
      rulePart: raw.slice(0, atJsIdx).trim(),
      jsParts: [raw.slice(atJsIdx + 4).trim()],
    };
  }

  return { rulePart: raw, jsParts: [] };
}

/**
 * Extract @put:{key:rule,...} directives from a rule string
 */
function extractPutDirectives(ruleStr) {
  const puts = [];
  const cleaned = String(ruleStr ?? '').replace(/@put:\{([^}]+)\}/gi, (_, body) => {
    const pairs = splitTopLevel(body, ',');
    for (const pair of pairs) {
      const colon = pair.indexOf(':');
      if (colon > 0) {
        const k = pair.slice(0, colon).trim().replace(/^["']|["']$/g, '');
        const v = pair.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
        if (k && v) puts.push([k, v]);
      }
    }
    return '';
  });
  return { cleaned: cleaned.trim(), puts };
}

/**
 * Parse trailing regex replace: rule##pattern##replacement or rule##pattern##replacement###
 */
function splitRegexReplace(ruleStr) {
  const idx = ruleStr.indexOf('##');
  if (idx < 0) return { base: ruleStr, regex: null };
  const base = ruleStr.slice(0, idx).trim();
  const rest = ruleStr.slice(idx + 2);
  const parts = rest.split('##');
  const pattern = parts[0] ?? '';
  const replacement = parts[1] ?? '';
  const onlyFirst = parts.length >= 3 && parts[2] === '#';
  return { base, regex: { pattern, replacement, onlyFirst } };
}

function applyRegexReplace(text, regex) {
  if (!regex || !regex.pattern) return text;
  try {
    const re = new RegExp(regex.pattern, regex.onlyFirst ? '' : 'g');
    return String(text ?? '').replace(re, regex.replacement);
  } catch {
    return text;
  }
}

function sliceElements(arr, indexSpec) {
  if (!indexSpec) return arr;
  const spec = indexSpec.trim();
  if (!spec) return arr;

  if (spec.startsWith('!')) {
    const excl = spec
      .slice(1)
      .split(':')
      .map((x) => Number.parseInt(x, 10))
      .filter((n) => !Number.isNaN(n))
      .map((n) => (n < 0 ? arr.length + n : n));
    const exclSet = new Set(excl);
    return arr.filter((_, i) => !exclSet.has(i));
  }

  if (/^-?\d+$/.test(spec)) {
    const idx = Number.parseInt(spec, 10);
    const target = idx < 0 ? arr.length + idx : idx;
    return target >= 0 && target < arr.length ? [arr[target]] : [];
  }

  const rangeMatch = /^\[?(-?\d*):(-?\d*)\]?$/.exec(spec);
  if (rangeMatch) {
    const start = rangeMatch[1] === '' ? 0 : Number.parseInt(rangeMatch[1], 10);
    const end = rangeMatch[2] === '' ? arr.length : Number.parseInt(rangeMatch[2], 10);
    return arr.slice(start, end);
  }

  return arr;
}

function extractFromCheerio($, elements, attr) {
  const a = (attr || 'text').trim();
  const out = [];
  for (const el of elements) {
    const $el = $(el);
    if (a === 'text') {
      out.push($el.text().trim());
    } else if (a === 'ownText') {
      const own = $el.contents().filter((_, n) => n.type === 'text').text().trim();
      out.push(own);
    } else if (a === 'textNodes') {
      const lines = $el
        .contents()
        .filter((_, n) => n.type === 'text')
        .map((_, n) => $(n).text().trim())
        .get()
        .filter(Boolean);
      out.push(lines.join('\n'));
    } else if (a === 'html') {
      out.push($el.html() || '');
    } else if (a === 'all') {
      out.push($.html(el) || '');
    } else {
      const v = $el.attr(a);
      if (v !== undefined) out.push(String(v).trim());
    }
  }
  return out;
}

function getFragmentTopElements($) {
  const bodyChildren = $('body').children().toArray();
  if (bodyChildren.length > 0) return bodyChildren;
  const rootChildren = $.root().children().toArray();
  return rootChildren.length > 0 ? rootChildren : [$.root()[0]];
}

function fixCssAttrQuotes(selector) {
  return String(selector).replace(/\[([a-zA-Z-]+)\s*=\s*([^\]"'<>]+?)\s*\]/g, (m, name, raw) => {
    if (!/[ ;]/.test(raw)) return m;
    return `[${name}="${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
  });
}

function cssSelectSafe($, root, selector) {
  let els = [];
  try { els = $(root).find(selector).toArray(); } catch { els = []; }
  if (els.length === 0) {
    const fixed = fixCssAttrQuotes(selector);
    if (fixed !== selector) {
      try { els = $(root).find(fixed).toArray(); } catch { /* keep empty */ }
    }
  }
  return els;
}

function evalCssRule(content, ruleStr, returnElements = false) {
  const html = typeof content === 'string' ? content : (content?.outerHtml ? content.outerHtml() : String(content ?? ''));
  const $ = cheerio.load(html);
  const raw = ruleStr.trim();

  if (raw.startsWith('@css:')) {
    const rest = raw.slice(5).trim();
    const lastAt = rest.lastIndexOf('@');
    let sel = rest;
    let attr = '';
    if (lastAt > 0 && /^[a-zA-Z0-9_-]+$/.test(rest.slice(lastAt + 1))) {
      sel = rest.slice(0, lastAt).trim();
      attr = rest.slice(lastAt + 1).trim();
    }
    const els = cssSelectSafe($, $.root()[0], sel);
    if (returnElements) return els.map((el) => $.html(el));
    return extractFromCheerio($, els, attr || 'text');
  }

  const tokens = raw.split('@').map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return [];

  const TERMINAL_ATTRS = new Set([
    'text', 'textNodes', 'ownText', 'html', 'all',
    'href', 'src', 'data-src', 'data-original', 'title', 'alt', 'content', 'value',
  ]);
  let attr = '';
  if (!returnElements && tokens.length >= 1) {
    const last = tokens[tokens.length - 1];
    if (
      TERMINAL_ATTRS.has(last) ||
      (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(last) && tokens.length > 1 && !last.includes('.'))
    ) {
      attr = tokens.pop();
    }
  }

  // If no selector tokens remain (e.g. rule was just "href" or "text"), operate on fragment top-level elements!
  if (tokens.length === 0) {
    const topEls = getFragmentTopElements($);
    if (returnElements) return topEls.map((el) => $.html(el));
    return extractFromCheerio($, topEls, attr || 'text');
  }

  let current = [$.root()[0]];

  for (let tIdx = 0; tIdx < tokens.length; tIdx++) {
    let part = tokens[tIdx];
    let indexSpec = '';

    const exclMatch = /^(.*?)!(-?\d+(?::-?\d+)*)$/.exec(part);
    if (exclMatch) {
      part = exclMatch[1];
      indexSpec = '!' + exclMatch[2];
    } else {
      const bracketSlice = /^(.*?)\[(-?\d*:-?\d*)\]$/.exec(part);
      if (bracketSlice) {
        part = bracketSlice[1];
        indexSpec = bracketSlice[2];
      } else {
        const bracketIdx = /^(.*?)\[(-?\d+)\]$/.exec(part);
        if (bracketIdx && !bracketIdx[1].endsWith(']')) {
          part = bracketIdx[1];
          indexSpec = bracketIdx[2];
        }
      }
    }

    let selector = '';
    let textFilter = null;

    if (part === 'children') {
      const next = [];
      for (const el of current) {
        const targets = el === $.root()[0] ? getFragmentTopElements($) : [el];
        for (const t of targets) next.push(...$(t).children().toArray());
      }
      current = sliceElements(next, indexSpec);
      continue;
    }

    if (part.startsWith('class.')) {
      const body = part.slice(6);
      const m = /^(.*?)\.(-?\d+)$/.exec(body);
      const clsName = (m ? m[1] : body).trim();
      if (m && !indexSpec) indexSpec = m[2];
      selector = clsName
        .split(/\s+/)
        .filter(Boolean)
        .map((c) => `.${c.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1')}`)
        .join('');
    } else if (part.startsWith('id.')) {
      const body = part.slice(3);
      const m = /^(.*?)\.(-?\d+)$/.exec(body);
      const idName = (m ? m[1] : body).trim();
      if (m && !indexSpec) indexSpec = m[2];
      selector = `#${idName}`;
    } else if (part.startsWith('tag.')) {
      const body = part.slice(4);
      const m = /^(.*?)\.(-?\d+)$/.exec(body);
      selector = (m ? m[1] : body).trim();
      if (m && !indexSpec) indexSpec = m[2];
    } else if (part.startsWith('text.')) {
      const body = part.slice(5);
      const m = /^(.*?)\.(-?\d+)$/.exec(body);
      textFilter = m ? m[1] : body;
      if (m && !indexSpec) indexSpec = m[2];
      selector = '*';
    } else {
      const m = /^(.*?)\.(-?\d+)$/.exec(part);
      if (m && m[1]) {
        selector = m[1];
        if (!indexSpec) indexSpec = m[2];
      } else {
        selector = part;
      }
    }

    const next = [];
    for (const el of current) {
      try {
        let found = cssSelectSafe($, el, selector);
        if (found.length === 0) {
          try { if ($(el).is(selector)) found = [el]; } catch { /* ignore */ }
        }
        if (textFilter !== null) {
          const candidates = found.filter((n) => !['html', 'head', 'body', 'script', 'style', 'noscript'].includes(n.tagName));
          const target = String(textFilter).trim();
          const targetTight = target.replace(/\s+/g, '');
          const rank = (n) => {
            const own = $(n).contents().filter((_, c) => c.type === 'text').text();
            const all = $(n).text();
            const tests = [
              (t) => t.trim() === target,
              (t) => t.replace(/\s+/g, '') === targetTight,
              (t) => t.trim().startsWith(target),
              (t) => t.includes(target),
            ];
            for (let i = 0; i < tests.length; i++) if (tests[i](own) || tests[i](all)) return i;
            return 99;
          };
          const scored = candidates
            .map((n) => ({ n, r: rank(n), len: $(n).text().trim().length }))
            .filter((x) => x.r < 99);
          scored.sort((a, b) => a.r - b.r || a.len - b.len);
          found = scored.map((x) => x.n);
        }
        next.push(...found);
      } catch {
        // invalid selector
      }
    }
    current = sliceElements(next, indexSpec);
  }

  if (returnElements) {
    return current.map((el) => $.html(el));
  }
  return extractFromCheerio($, current, attr || 'text');
}

function evalJsonRule(content, ruleStr, returnElements = false) {
  const obj = tryParseJson(content);
  if (obj === null) return [];
  let path = ruleStr.startsWith('@Json:') ? ruleStr.slice(6).trim() : ruleStr.trim();
  if (!path.startsWith('$')) path = `$.${path}`;
  try {
    const res = JSONPath({ path, json: obj, wrap: true });
    const filtered = res.filter((v) => v !== undefined && v !== null);
    // Unwrap single array result when selecting element lists (e.g. $.books or data.books)
    if (returnElements && filtered.length === 1 && Array.isArray(filtered[0])) {
      return filtered[0];
    }
    return filtered;
  } catch {
    return [];
  }
}

function evalXPathRule(content, ruleStr, returnElements = false) {
  const html = typeof content === 'string' ? content : String(content ?? '');
  const expr = ruleStr.startsWith('@XPath:') ? ruleStr.slice(7).trim() : ruleStr.trim();
  try {
    // Strip <script>/<style>, DOCTYPE, and default xmlns so XPath 1.0 unprefixed '//a' always works!
    const $ = cheerio.load(html);
    $('script,style,noscript').remove();
    const xhtml = $.xml()
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/\s+xmlns=["'][^"']*["']/gi, '');
    const doc = new DOMParser({ onError: () => {} }).parseFromString(xhtml, 'text/xml');
    let nodes = xpath.select(expr, doc);
    if (Array.isArray(nodes) && nodes.length === 0) {
      // Some pages nest the predicate element deeper, or add whitespace around text().
      const alt = expr
        .replace(/\[([a-zA-Z][\w:-]*)\]/g, (m, tag) => `[.//${tag}]`)
        .replace(/text\(\)\s*=\s*("([^"]*)"|'([^']*)')/g, (m, _q, a, b) => `text()[normalize-space(.)=${JSON.stringify(a ?? b)}]`);
      if (alt !== expr) {
        try { nodes = xpath.select(alt, doc); } catch { /* keep empty result */ }
      }
    }
    if (!Array.isArray(nodes)) return nodes !== undefined && nodes !== null ? [String(nodes)] : [];
    return nodes.map((n) => {
      if (returnElements) return n.toString();
      if (typeof n === 'string' || typeof n === 'number') return String(n);
      return (n.value !== undefined ? n.value : n.textContent || '').trim();
    });
  } catch {
    return [];
  }
}

export class RuleContext {
  constructor({ source, baseUrl = '', content = '', vars = {}, book = {}, key = '', page = 1, chapter = null, jsHost = null }) {
    this.source = source || {};
    this.chapter = chapter;
    // Shared (per root context) JS VM so jsLib is compiled once, not once per rule call.
    this._jsHost = jsHost || {};
    this.baseUrl = baseUrl || source?.bookSourceUrl || '';
    this.content = content;
    this.vars = { ...vars };
    this.book = book;
    this.key = key;
    this.page = page;
    this._sourceVar = '';
  }

  cloneWith(overrides) {
    const next = new RuleContext({
      source: this.source,
      baseUrl: overrides.baseUrl ?? this.baseUrl,
      content: overrides.content ?? this.content,
      vars: this.vars,
      book: overrides.book ?? this.book,
      key: overrides.key ?? this.key,
      page: overrides.page ?? this.page,
      chapter: overrides.chapter ?? this.chapter,
      jsHost: this._jsHost,
    });
    next._sourceVar = this._sourceVar;
    return next;
  }

  buildSourceProxy() {
    const self = this;
    const srcKey = String(self.source?.bookSourceUrl || '');
    return {
      ...this.source,
      getKey: () => srcKey,
      getTag: () => String(self.source?.bookSourceName || self.source?.bookSourceUrl || ''),
      getVariable: () => (SOURCE_VARS.has(srcKey) ? SOURCE_VARS.get(srcKey) : self._sourceVar || ''),
      setVariable: (v) => {
        self._sourceVar = String(v ?? '');
        if (srcKey) boundedSet(SOURCE_VARS, srcKey, self._sourceVar);
      },
      put: (k, v) => {
        jsCachePut(`${srcKey}::${k}`, v, 0);
        return v;
      },
      get: (k) => jsCacheGet(`${srcKey}::${k}`) ?? '',
      getLoginInfoMap: () => ({}),
      getLoginHeader: () => self.source?.header || '',
    };
  }

  buildJavaApi() {
    const self = this;
    return {
      put(k, v) {
        self.vars[String(k)] = v === undefined || v === null ? '' : String(v);
        return self.vars[String(k)];
      },
      get(k, headers) {
        if (headers !== undefined || /^https?:\/\//i.test(String(k))) {
          const optUrl = headers
            ? `${k},${JSON.stringify({ method: 'GET', headers })}`
            : String(k);
          const res = syncFetchLegado(optUrl, {
            baseUrl: self.baseUrl,
            sourceHeader: resolveSourceHeader(self.source),
          });
          return {
            body: () => res.body,
            url: () => res.url,
            headers: () => res.headers,
            code: () => res.status,
            raw: () => ({ request: () => ({ url: () => res.url }), code: () => res.status }),
          };
        }
        return self.vars[String(k)] ?? '';
      },
      post(url, body, headers) {
        const optUrl = `${url},${JSON.stringify({ method: 'POST', body: String(body ?? ''), headers: headers || {} })}`;
        const res = syncFetchLegado(optUrl, {
          baseUrl: self.baseUrl,
          sourceHeader: resolveSourceHeader(self.source),
        });
        return {
          body: () => res.body,
          url: () => res.url,
          headers: () => res.headers,
          code: () => res.status,
          raw: () => ({ request: () => ({ url: () => res.url }), code: () => res.status }),
        };
      },
      ajax(url) {
        const target = Array.isArray(url) ? url[0] : url;
        const res = syncFetchLegado(String(target), {
          baseUrl: self.baseUrl,
          sourceHeader: resolveSourceHeader(self.source),
        });
        return res.body || '';
      },
      connect(url, header) {
        const optUrl = header ? `${url},${JSON.stringify({ headers: header })}` : String(url);
        const res = syncFetchLegado(optUrl, {
          baseUrl: self.baseUrl,
          sourceHeader: resolveSourceHeader(self.source),
        });
        return {
          body: () => res.body,
          url: () => res.url,
          headers: () => res.headers,
          code: () => res.status,
          raw: () => ({ request: () => ({ url: () => res.url }), code: () => res.status }),
        };
      },
      setContent(content, baseUrl) {
        self.content = content;
        if (baseUrl) self.baseUrl = baseUrl;
      },
      getString(rule, isUrl = false) {
        return self.getString(rule, isUrl);
      },
      getStringList(rule, isUrl = false) {
        return decorateElementsArray(self.getStringList(rule, isUrl));
      },
      getElements(rule) {
        return decorateElementsArray(self.getElements(rule));
      },
      getElement(rule) {
        const els = self.getElements(rule);
        return els[0] ?? '';
      },
      md5Encode(str) {
        return md5Hex(str);
      },
      md5Encode16(str) {
        return md5Hex(str).slice(8, 24);
      },
      base64Decode(str, charset) {
        const buf = Buffer.from(String(str ?? ''), 'base64');
        const cs = typeof charset === 'string' ? charset.toLowerCase() : 'utf-8';
        return cs !== 'utf-8' && cs !== 'utf8' && iconv.encodingExists(cs) ? iconv.decode(buf, cs) : buf.toString('utf8');
      },
      hexEncodeToString(str) {
        return Buffer.from(String(str ?? ''), 'utf8').toString('hex');
      },
      hexDecodeToByteArray(hex) {
        return [...Buffer.from(String(hex ?? ''), 'hex')].map((b) => (b > 127 ? b - 256 : b));
      },
      base64Encode(str) {
        return Buffer.from(String(str ?? ''), 'utf8').toString('base64');
      },
      hexDecodeToString(hex) {
        return Buffer.from(String(hex ?? ''), 'hex').toString('utf8');
      },
      encodeURI(str, charset) {
        return encodeQueryParam(str, charset);
      },
      timeFormat(ts) {
        const d = new Date(Number(ts));
        if (Number.isNaN(d.getTime())) return String(ts ?? '');
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      },
      timeFormatUTC(ts, fmt = 'yyyy-MM-dd HH:mm:ss', offset = 8) {
        const d = new Date(Number(ts) + Number(offset) * 3600 * 1000);
        if (Number.isNaN(d.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return String(fmt)
          .replace('yyyy', String(d.getUTCFullYear()))
          .replace('MM', pad(d.getUTCMonth() + 1))
          .replace('dd', pad(d.getUTCDate()))
          .replace('HH', pad(d.getUTCHours()))
          .replace('mm', pad(d.getUTCMinutes()))
          .replace('ss', pad(d.getUTCSeconds()));
      },
      createSymmetricCrypto(transformation, key, iv) {
        return createSymmetricCrypto(transformation, key, iv);
      },
      // --- Legado JsExtensions crypto helpers (subset) ---
      aesDecodeToString(data, key, transformation, iv) {
        try {
          return createSymmetricCrypto(transformation || 'AES/CBC/PKCS5Padding', key, iv).decryptStr(data);
        } catch {
          return '';
        }
      },
      aesBase64DecodeToString(data, key, transformation, iv) {
        try {
          const buf = Buffer.from(String(data ?? ''), 'base64');
          return createSymmetricCrypto(transformation || 'AES/CBC/PKCS5Padding', key, iv).decryptStr(buf);
        } catch {
          return '';
        }
      },
      aesEncodeToString(data, key, transformation, iv) {
        return createSymmetricCrypto(transformation || 'AES/CBC/PKCS5Padding', key, iv).encryptHex(data);
      },
      aesEncodeToBase64String(data, key, transformation, iv) {
        return createSymmetricCrypto(transformation || 'AES/CBC/PKCS5Padding', key, iv).encryptBase64(data);
      },
      desDecodeToString(data, key, transformation, iv) {
        try {
          return createSymmetricCrypto(transformation || 'DES/CBC/PKCS5Padding', key, iv).decryptStr(data);
        } catch {
          return '';
        }
      },
      desBase64DecodeToString(data, key, transformation, iv) {
        try {
          const buf = Buffer.from(String(data ?? ''), 'base64');
          return createSymmetricCrypto(transformation || 'DES/CBC/PKCS5Padding', key, iv).decryptStr(buf);
        } catch {
          return '';
        }
      },
      desEncodeToBase64String(data, key, transformation, iv) {
        return createSymmetricCrypto(transformation || 'DES/CBC/PKCS5Padding', key, iv).encryptBase64(data);
      },
      tripleDESDecodeStr(data, key, mode, padding, iv) {
        try {
          return createSymmetricCrypto(`DESede/${mode || 'CBC'}/${padding || 'PKCS5Padding'}`, key, iv).decryptStr(data);
        } catch {
          return '';
        }
      },
      tripleDESEncodeBase64Str(data, key, mode, padding, iv) {
        return createSymmetricCrypto(`DESede/${mode || 'CBC'}/${padding || 'PKCS5Padding'}`, key, iv).encryptBase64(data);
      },
      digestHex(data, algorithm) {
        return digestBuf(data, algorithm).toString('hex');
      },
      digestBase64Str(data, algorithm) {
        return digestBuf(data, algorithm).toString('base64');
      },
      HMacHex(data, algorithm, key) {
        return hmacBuf(data, algorithm, key).toString('hex');
      },
      HMacBase64(data, algorithm, key) {
        return hmacBuf(data, algorithm, key).toString('base64');
      },
      randomUUID() {
        return crypto.randomUUID();
      },
      base64DecodeToByteArray(str) {
        return [...Buffer.from(String(str ?? ''), 'base64')].map((b) => (b > 127 ? b - 256 : b));
      },
      strToBytes(str, charset = 'utf-8') {
        const buf = iconv.encodingExists(charset) ? iconv.encode(String(str ?? ''), charset) : Buffer.from(String(str ?? ''));
        return [...buf].map((b) => (b > 127 ? b - 256 : b));
      },
      bytesToStr(bytes, charset = 'utf-8') {
        const buf = Buffer.from((Array.isArray(bytes) ? bytes : []).map((b) => (b < 0 ? b + 256 : b)));
        return iconv.encodingExists(charset) ? iconv.decode(buf, charset) : buf.toString('utf8');
      },
      utf8ToGbk(str) {
        return iconv.decode(iconv.encode(String(str ?? ''), 'gbk'), 'gbk');
      },
      htmlFormat(str) {
        return htmlToCleanText(str);
      },
      getWebViewUA() {
        return DEFAULT_UA;
      },
      ajaxAll(urls) {
        const list = Array.isArray(urls) ? urls : [urls];
        return list.map((u) => {
          const res = syncFetchLegado(String(u), { baseUrl: self.baseUrl, sourceHeader: resolveSourceHeader(self.source) });
          return {
            body: () => res.body,
            url: () => res.url,
            headers: () => res.headers,
            code: () => res.status,
          };
        });
      },
      getCookie(tag, key) {
        const all = getCookieForUrl(tag || self.baseUrl);
        if (!key) return all;
        const m = new RegExp(`(?:^|;\\s*)${key}=([^;]*)`).exec(all);
        return m ? m[1] : '';
      },
      removeCookie(tag) {
        removeCookie(tag || self.baseUrl);
      },
      toNumChapter(str) {
        return toNumChapter(str);
      },
      log(msg) {
        return msg;
      },
      toast() {},
      longToast() {},
    };
  }

  /** Per-call globals (bound to this context). */
  buildJsEnv(result) {
    const self = this;
    const java = this.buildJavaApi();
    const bookProxy = {
      origin: this.source?.bookSourceUrl || '',
      ...this.book,
      getVariable: (k) => (k === undefined || k === null ? self.vars.__bookVariable || '' : self.vars[String(k)] ?? ''),
      putVariable: (k, v) => {
        if (v === undefined) self.vars.__bookVariable = String(k ?? '');
        else self.vars[String(k)] = v === null ? '' : String(v);
      },
    };
    const chapterProxy = {
      title: '',
      url: '',
      index: 0,
      ...(this.chapter || {}),
      getVariable: () => '',
      putVariable: () => {},
    };
    return {
      java,
      result: Array.isArray(result) ? decorateElementsArray(result) : result,
      baseUrl: this.baseUrl,
      src: this.content,
      book: bookProxy,
      chapter: chapterProxy,
      title: chapterProxy.title || '',
      source: this.buildSourceProxy(),
      key: this.key,
      page: this.page,
      cookie: {
        getCookie: (url) => getCookieForUrl(url || this.baseUrl),
        getKey: (url, k) => java.getCookie(url, k),
        setCookie: (url, value) => setCookieString(url || this.baseUrl, value),
        replaceCookie: (url, value) => setCookieString(url || this.baseUrl, value),
        removeCookie: (url) => removeCookie(url || this.baseUrl),
      },
    };
  }

  /** Lazily create the shared VM context (globals + getBytes polyfill + jsLib, once). */
  getJsContext() {
    const host = this._jsHost;
    if (host.ctx) return host.ctx;
    const sandbox = jsStaticGlobals();
    const ctx = vm.createContext(sandbox);
    vm.runInContext(GET_BYTES_POLYFILL, ctx, { timeout: 1000 });
    const lib = jsLibCode(this.source);
    if (lib) {
      try {
        vm.runInContext(lib, ctx, { timeout: jsTimeoutFor(lib) });
      } catch {
        // a broken jsLib only breaks the scripts that use it
      }
    }
    host.sandbox = sandbox;
    host.ctx = ctx;
    return ctx;
  }

  /** Legacy path: fresh VM context for one script (used for nested calls and as fallback). */
  runJsIsolated(code, result, fallbackOnErr = result) {
    const sandbox = { ...jsStaticGlobals(), ...this.buildJsEnv(result) };
    const ctx = vm.createContext(sandbox);
    try {
      vm.runInContext(GET_BYTES_POLYFILL, ctx, { timeout: 1000 });
      const lib = jsLibCode(this.source);
      const out = vm.runInContext(`${lib ? `${lib}\n` : ''}${code}`, ctx, { timeout: jsTimeoutFor(code) });
      return out !== undefined ? out : sandbox.result;
    } catch {
      return fallbackOnErr;
    }
  }

  runJs(code, result, fallbackOnErr = result) {
    const host = this._jsHost;
    // A script calling java.getString(...) can re-enter here: never clobber the running script's globals.
    if (host.busy) return this.runJsIsolated(code, result, fallbackOnErr);
    let ctx;
    try {
      ctx = this.getJsContext();
    } catch {
      return this.runJsIsolated(code, result, fallbackOnErr);
    }
    Object.assign(host.sandbox, this.buildJsEnv(result));
    host.busy = true;
    try {
      // Block wrapper: let/const stay local to this call, completion value is kept.
      const out = vm.runInContext(`{\n${code}\n}`, ctx, { timeout: jsTimeoutFor(code) });
      return out !== undefined ? out : host.sandbox.result;
    } catch (err) {
      if (err && err.name === 'SyntaxError') {
        host.busy = false;
        return this.runJsIsolated(code, result, fallbackOnErr);
      }
      return fallbackOnErr;
    } finally {
      host.busy = false;
    }
  }

  prepareJsCode(code) {
    const raw = String(code ?? '');
    if (!raw.includes('{{') && !raw.includes('@get:')) return raw;
    return this.interpolateTemplate(raw);
  }

  interpolateTemplate(str, extra = {}) {
    const raw = String(str ?? '');
    if (!raw.includes('{{') && !raw.includes('{$.') && !raw.includes('@get:')) return raw;

    // 1. Replace @get:{key}
    let out = raw.replace(/@get:\{([^}]+)\}/gi, (_, k) => this.vars[k.trim()] ?? '');

    // 2. Replace {{...}} blocks FIRST (before single-brace {$.foo} so {{$.foo}} is never corrupted into {})
    out = out.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr) => {
      const trimmed = expr.trim();
      if (trimmed === 'key') return extra.encodedKey ?? this.key;
      if (trimmed === 'page') return String(this.page);
      if (trimmed.startsWith('$.') || trimmed.startsWith('$[') || trimmed.startsWith('@Json:')) {
        const vals = evalJsonRule(this.content, trimmed);
        return vals.length > 0 ? String(vals[0]) : '';
      }
      if (trimmed.startsWith('@@')) {
        return this.getString(trimmed.slice(2));
      }
      if (trimmed.startsWith('@css:') || trimmed.startsWith('@XPath:') || trimmed.startsWith('//')) {
        return this.getString(trimmed);
      }
      const val = this.runJs(trimmed, this.content, '');
      return val !== undefined && val !== null ? String(val) : '';
    });

    // 3. Replace single-brace {$.foo} JSONPath shorthand
    out = out.replace(/\{(\$\.[^}]+)\}/g, (_, jp) => {
      const vals = evalJsonRule(this.content, jp);
      return vals.length > 0 ? String(vals[0]) : '';
    });

    return out;
  }

  evalAtomicRule(base, content, returnElements = false) {
    if (!base) return [];
    if (base.startsWith('@get:{') && base.endsWith('}')) {
      const k = base.slice(6, -1).trim();
      return this.vars[k] ? [this.vars[k]] : [];
    }
    if (base.startsWith('@Json:') || base.startsWith('$.') || base.startsWith('$[')) {
      return evalJsonRule(content, base, returnElements);
    }
    if (base.startsWith('@XPath:') || base.startsWith('//') || base.startsWith('./')) {
      return evalXPathRule(content, base, returnElements);
    }
    if (base.startsWith(':')) {
      try {
        const re = new RegExp(base.slice(1), 'g');
        const str = typeof content === 'string' ? content : JSON.stringify(content);
        return [...str.matchAll(re)].map((m) => (m[1] !== undefined ? m[1] : m[0]));
      } catch {
        return [];
      }
    }
    if (!returnElements && (base.includes('{{') || base.includes('{$.') || base.includes('@get:'))) {
      const subCtx = content === this.content ? this : this.cloneWith({ content });
      return [subCtx.interpolateTemplate(base)];
    }
    const jsonObj = tryParseJson(content);
    if (jsonObj !== null && /^[a-zA-Z0-9_.*[\]-]+$/.test(base) && !base.startsWith('class.') && !base.startsWith('id.') && !base.startsWith('tag.')) {
      return evalJsonRule(jsonObj, base, returnElements);
    }
    return evalCssRule(content, base, returnElements);
  }

  evalSingleRule(ruleStr, returnElements = false) {
    const { cleaned, puts } = extractPutDirectives(ruleStr);
    for (const [k, vRule] of puts) {
      const v = this.getString(vRule);
      if (v) this.vars[k] = v;
    }

    // Pipeline execution when <js>...</js> appears anywhere (including before a trailing rule!)
    if (/<js>[\s\S]*?<\/js>/i.test(cleaned)) {
      const segments = [];
      let lastIdx = 0;
      const re = /<js>([\s\S]*?)<\/js>/gi;
      let m;
      while ((m = re.exec(cleaned)) !== null) {
        const before = cleaned.slice(lastIdx, m.index).trim();
        if (before) segments.push({ type: 'rule', val: before });
        segments.push({ type: 'js', val: m[1].trim() });
        lastIdx = m.index + m[0].length;
      }
      const after = cleaned.slice(lastIdx).trim();
      if (after) segments.push({ type: 'rule', val: after });

      let cur = this.content;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const isLast = i === segments.length - 1;
        if (seg.type === 'js') {
          cur = this.runJs(this.prepareJsCode(seg.val), cur);
        } else {
          // Support || and && inside pipeline rule segments
          const orParts = splitTopLevel(seg.val, '||');
          let res = [];
          for (const op of orParts) {
            const andParts = splitTopLevel(op, '&&');
            const sub = [];
            for (const ap of andParts) {
              const { base, regex } = splitRegexReplace(ap.trim());
              let r = this.evalAtomicRule(base, cur, isLast ? returnElements : true);
              if (regex) {
                r = r.map((item) => (typeof item === 'string' ? applyRegexReplace(item, regex) : item));
              }
              if (Array.isArray(r) && r.length > 0) sub.push(...r);
            }
            if (sub.length > 0) {
              res = sub;
              break;
            }
          }
          cur = isLast ? res : (res.length <= 1 ? (res[0] ?? '') : decorateElementsArray(res));
        }
      }
      if (Array.isArray(cur)) return cur;
      return cur !== undefined && cur !== null && cur !== '' ? [cur] : [];
    }

    const { rulePart, jsParts } = splitRuleAndJs(cleaned);
    const { base, regex } = splitRegexReplace(rulePart);

    let result;
    if (!base) {
      result = jsParts.length > 0 ? [this.content] : [];
    } else {
      result = this.evalAtomicRule(base, this.content, returnElements);
    }

    if (regex) {
      result = result.map((item) => (typeof item === 'string' ? applyRegexReplace(item, regex) : item));
    }

    if (jsParts.length > 0) {
      let cur = !base
        ? this.content
        : returnElements
          ? decorateElementsArray(result)
          : (result.length <= 1 ? (result[0] ?? '') : result.join('\n'));
      for (const code of jsParts) {
        cur = this.runJs(this.prepareJsCode(code), cur);
      }
      if (Array.isArray(cur)) return cur;
      return cur !== undefined && cur !== null && cur !== '' ? [cur] : [];
    }

    return result;
  }

  getElements(rule) {
    const raw = String(rule ?? '').trim();
    if (!raw) return [];

    let reverse = false;
    let effective = raw;
    if (effective.startsWith('-')) {
      reverse = true;
      effective = effective.slice(1).trim();
    }
    if (effective.startsWith('+')) {
      effective = effective.slice(1).trim();
    }

    // If rule contains <js>...</js>, use ordered pipeline execution directly
    if (/<js>[\s\S]*?<\/js>/i.test(effective)) {
      const collected = this.evalSingleRule(effective, true);
      if (reverse) collected.reverse();
      return collected;
    }

    // Handle trailing @js: on the whole expression AFTER || / &&
    const { rulePart, jsParts } = splitRuleAndJs(effective);
    const orParts = splitTopLevel(rulePart, '||');
    let collected = [];

    if (!rulePart && jsParts.length > 0) {
      collected = this.evalSingleRule(effective, true);
    } else {
      for (const part of orParts) {
        const andParts = splitTopLevel(part, '&&');
        const sub = [];
        for (const ap of andParts) {
          const res = this.evalSingleRule(ap.trim(), true);
          if (Array.isArray(res) && res.length > 0) {
            sub.push(...res);
          }
        }
        if (sub.length > 0) {
          collected = sub;
          break;
        }
      }
      if (jsParts.length > 0) {
        let cur = decorateElementsArray(collected);
        for (const code of jsParts) {
          cur = this.runJs(this.prepareJsCode(code), cur);
        }
        collected = Array.isArray(cur) ? cur : (cur ? [cur] : []);
      }
    }

    if (reverse) collected.reverse();
    return collected;
  }

  getStringList(rule, isUrl = false) {
    let raw = String(rule ?? '').trim();
    if (!raw) return [];
    if (raw.startsWith('+')) raw = raw.slice(1).trim();

    if (/<js>[\s\S]*?<\/js>/i.test(raw)) {
      const res = this.evalSingleRule(raw, false);
      return res.map((v) => {
        const s = typeof v === 'string' ? v.trim() : (v !== undefined && v !== null ? String(v).trim() : '');
        if (!s) return '';
        return isUrl ? normalizeUrlResult(s, this.baseUrl) : s;
      }).filter(Boolean);
    }

    // Check if the entire rule has a trailing @js: after ||/&&
    const { rulePart, jsParts } = splitRuleAndJs(raw);
    const orParts = splitTopLevel(rulePart, '||');

    const normalizeVal = (v) => {
      const s = typeof v === 'string' ? v.trim() : (v !== undefined && v !== null ? String(v).trim() : '');
      if (!s) return '';
      return isUrl ? normalizeUrlResult(s, this.baseUrl) : s;
    };

    if (!rulePart && jsParts.length > 0) {
      const res = this.evalSingleRule(raw, false);
      return res.map(normalizeVal).filter(Boolean);
    }

    for (const part of orParts) {
      const andParts = splitTopLevel(part, '&&');
      let collected = [];
      for (const ap of andParts) {
        const res = this.evalSingleRule(ap.trim(), false);
        for (const v of res) {
          const s = typeof v === 'string' ? v.trim() : (v !== undefined && v !== null ? String(v).trim() : '');
          if (s) collected.push(s);
        }
      }
      if (collected.length > 0) {
        if (jsParts.length > 0) {
          let cur = collected.join('\n');
          for (const code of jsParts) {
            cur = this.runJs(this.prepareJsCode(code), cur);
          }
          collected = Array.isArray(cur) ? cur : (cur !== undefined && cur !== null ? [cur] : []);
        }
        const out = collected.map(normalizeVal).filter(Boolean);
        if (out.length > 0) return out;
      }
    }
    return [];
  }

  getString(rule, isUrl = false) {
    const list = this.getStringList(rule, isUrl);
    if (isUrl) return list[0] || '';
    return list.join('\n').trim();
  }
}

export function htmlToCleanText(raw) {
  if (!raw) return '';
  let text = String(raw);
  if (/<[a-z][\s\S]*>/i.test(text)) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<p[^>]*>/gi, '\n');
    const $ = cheerio.load(`<div>${text}</div>`);
    text = $('div').text();
  }
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n\n');
}
