import iconv from 'iconv-lite';

const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

// Lightweight in-memory cookie jar keyed by hostname
const cookieJar = new Map();

export function getCookieForUrl(urlStr) {
  try {
    const host = new URL(urlStr).hostname;
    const bag = cookieJar.get(host);
    if (!bag || bag.size === 0) return '';
    return [...bag.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  } catch {
    return '';
  }
}

export function setCookieForUrl(urlStr, setCookieHeaders) {
  if (!setCookieHeaders || setCookieHeaders.length === 0) return;
  try {
    const host = new URL(urlStr).hostname;
    let bag = cookieJar.get(host);
    if (!bag) {
      bag = new Map();
      cookieJar.set(host, bag);
    }
    for (const raw of setCookieHeaders) {
      const first = String(raw).split(';')[0];
      const eq = first.indexOf('=');
      if (eq > 0) {
        const k = first.slice(0, eq).trim();
        const v = first.slice(eq + 1).trim();
        if (k) bag.set(k, v);
      }
    }
  } catch {
    // ignore
  }
}

export function resolveUrl(baseUrl, target) {
  if (!target) return '';
  const trimmed = String(target).trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) {
    try {
      const proto = new URL(baseUrl).protocol || 'https:';
      return `${proto}${trimmed}`;
    } catch {
      return `https:${trimmed}`;
    }
  }
  try {
    return new URL(trimmed, baseUrl).href;
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
      // Relaxed JSON (single quotes or unquoted keys)
      try {
        const relaxed = jsonPart
          .replace(/'/g, '"')
          .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
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

export async function fetchLegado(rawUrl, options = {}) {
  const {
    baseUrl = '',
    sourceHeader = '',
    timeoutMs = 10_000,
    signal,
  } = options;

  const parsed = parseLegadoUrl(rawUrl, baseUrl, sourceHeader);
  if (!parsed.url || !/^https?:\/\//i.test(parsed.url)) {
    throw new Error(`Invalid URL: ${parsed.url}`);
  }

  const headers = { ...parsed.headers };
  const existingCookie = getCookieForUrl(parsed.url);
  if (existingCookie && !headers.Cookie && !headers.cookie) {
    headers.Cookie = existingCookie;
  }

  let bodyBuf;
  if (parsed.method !== 'GET' && parsed.method !== 'HEAD' && parsed.body !== undefined) {
    if (!headers['Content-Type'] && !headers['content-type']) {
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

    const arrBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrBuf);
    const cs = detectCharset(res.headers.get('content-type'), buf, parsed.charset);
    const text =
      cs === 'utf-8' || cs === 'utf8' || !iconv.encodingExists(cs)
        ? buf.toString('utf8')
        : iconv.decode(buf, cs);

    return {
      url: res.url || parsed.url,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: text,
    };
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
