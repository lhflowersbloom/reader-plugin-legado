import crypto from 'node:crypto';
import vm from 'node:vm';
import * as cheerio from 'cheerio';
import { JSONPath } from 'jsonpath-plus';
import xpath from 'xpath';
import { DOMParser } from '@xmldom/xmldom';
import { resolveUrl, getCookieForUrl, encodeQueryParam } from './http.js';
import { syncFetchLegado } from './sync-fetch.js';

function md5Hex(input) {
  return crypto.createHash('md5').update(String(input ?? ''), 'utf8').digest('hex');
}

function createSymmetricCrypto(transformation, key, iv) {
  const parts = String(transformation || 'AES/CBC/PKCS5Padding').split('/');
  const algBase = parts[0].toUpperCase();
  const mode = (parts[1] || 'CBC').toUpperCase();
  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(String(key ?? ''), 'utf8');
  const ivBuf = iv !== undefined && iv !== null
    ? (Buffer.isBuffer(iv) ? iv : Buffer.from(String(iv), 'utf8'))
    : Buffer.alloc(algBase === 'DES' || algBase === 'DESEDE' ? 8 : 16);

  let alg = 'aes-128-cbc';
  if (algBase === 'AES') {
    const bits = keyBuf.length <= 16 ? 128 : keyBuf.length <= 24 ? 192 : 256;
    alg = mode === 'ECB' ? `aes-${bits}-ecb` : `aes-${bits}-${mode.toLowerCase()}`;
  } else if (algBase === 'DES') {
    alg = mode === 'ECB' ? 'des-ecb' : 'des-cbc';
  } else if (algBase === 'DESEDE' || algBase === '3DES') {
    alg = mode === 'ECB' ? 'des-ede3-ecb' : 'des-ede3-cbc';
  }

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
    const els = $(sel).toArray();
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
      textFilter = part.slice(5);
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
        let found = $(el).find(selector).toArray();
        if (found.length === 0 && $(el).is(selector)) {
          found = [el];
        }
        if (textFilter !== null) {
          found = found.filter((n) => $(n).text().includes(textFilter));
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
    // Normalize messy HTML5 into well-formed XHTML via cheerio before xmldom + xpath
    const xhtml = cheerio.load(html).xml();
    const doc = new DOMParser({
      errorHandler: { warning() {}, error() {}, fatalError() {} },
    }).parseFromString(xhtml, 'text/xml');
    const nodes = xpath.select(expr, doc);
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
  constructor({ source, baseUrl = '', content = '', vars = {}, book = {}, key = '', page = 1 }) {
    this.source = source || {};
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
    });
    next._sourceVar = this._sourceVar;
    return next;
  }

  buildSourceProxy() {
    const self = this;
    return {
      ...this.source,
      getKey: () => String(self.source?.bookSourceUrl || ''),
      getTag: () => String(self.source?.bookSourceName || self.source?.bookSourceUrl || ''),
      getVariable: () => self._sourceVar || '',
      setVariable: (v) => { self._sourceVar = String(v ?? ''); },
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
            sourceHeader: self.source.header,
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
          sourceHeader: self.source.header,
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
          sourceHeader: self.source.header,
        });
        return res.body || '';
      },
      connect(url, header) {
        const optUrl = header ? `${url},${JSON.stringify({ headers: header })}` : String(url);
        const res = syncFetchLegado(optUrl, {
          baseUrl: self.baseUrl,
          sourceHeader: self.source.header,
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
      base64Decode(str) {
        return Buffer.from(String(str ?? ''), 'base64').toString('utf8');
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
      getCookie(tag, key) {
        const all = getCookieForUrl(tag || self.baseUrl);
        if (!key) return all;
        const m = new RegExp(`(?:^|;\\s*)${key}=([^;]*)`).exec(all);
        return m ? m[1] : '';
      },
      log() {},
      toast() {},
      longToast() {},
    };
  }

  runJs(code, result) {
    const java = this.buildJavaApi();
    const decoratedResult = Array.isArray(result) ? decorateElementsArray(result) : result;
    const jsoupShim = {
      parse(html) {
        const $ = cheerio.load(String(html ?? ''));
        return wrapCheerioEl($, $.root()[0]);
      },
    };
    const bookProxy = {
      origin: this.source?.bookSourceUrl || '',
      getVariable: () => '',
      putVariable: () => {},
      ...this.book,
    };
    const sandbox = {
      java,
      result: decoratedResult,
      baseUrl: this.baseUrl,
      src: this.content,
      book: bookProxy,
      source: this.buildSourceProxy(),
      key: this.key,
      page: this.page,
      org: { jsoup: { Jsoup: jsoupShim } },
      cookie: {
        getCookie: (url) => getCookieForUrl(url || this.baseUrl),
        getKey: (url, k) => java.getCookie(url, k),
      },
      String,
      Number,
      Boolean,
      Array,
      Object,
      JSON,
      Math,
      Date,
      RegExp,
      Map,
      Set,
      parseInt,
      parseFloat,
      isNaN,
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,
      console: { log() {}, warn() {}, error() {} },
    };
    const ctx = vm.createContext(sandbox);
    try {
      const out = vm.runInContext(code, ctx, { timeout: 5000 });
      return out !== undefined ? out : sandbox.result;
    } catch {
      return result;
    }
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
      if (trimmed.startsWith('$.') || trimmed.startsWith('$[')) {
        const vals = evalJsonRule(this.content, trimmed);
        return vals.length > 0 ? String(vals[0]) : '';
      }
      if (trimmed.startsWith('@@')) {
        return this.getString(trimmed.slice(2));
      }
      const val = this.runJs(trimmed, this.content);
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
          cur = this.runJs(seg.val, cur);
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
      let cur = returnElements
        ? decorateElementsArray(result)
        : (result.length <= 1 ? (result[0] ?? '') : result.join('\n'));
      for (const code of jsParts) {
        cur = this.runJs(code, cur);
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
          cur = this.runJs(code, cur);
        }
        collected = Array.isArray(cur) ? cur : (cur ? [cur] : []);
      }
    }

    if (reverse) collected.reverse();
    return collected;
  }

  getStringList(rule, isUrl = false) {
    const raw = String(rule ?? '').trim();
    if (!raw) return [];

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
            cur = this.runJs(code, cur);
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
