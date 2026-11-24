import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { fetchLegado, encodeQueryParam, parseLegadoUrl, resolveUrl } from './http.js';
import { RuleContext, htmlToCleanText, resolveSourceHeader } from './engine.js';

function shortHash(input) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 16);
}

export function encodeRef(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

export function decodeRef(ref) {
  try {
    return JSON.parse(Buffer.from(String(ref), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rich (image) content mode
// ---------------------------------------------------------------------------

/**
 * Whether chapters of this source are delivered as HTML with embedded images
 * instead of plain text. Comic sources always are; text sources only when the
 * user switched the source to picture mode on the management page, so the
 * behaviour of existing text sources never changes silently.
 */
export function sourceUsesHtml(source) {
  if (!source) return false;
  if (source.readerHtml === true) return true;
  if (source.readerHtml === false) return false;
  if (String(source.bookSourceType) === '2') return true;
  return /['"`]<img\s+src=/i.test(String(source.ruleContent?.content || ''));
}

const IMAGE_URL_RE = /^(https?:)?\/\/\S+\.(jpe?g|png|gif|webp|bmp)(\?\S*)?(,\s*\{[\s\S]*\})?$/i;
const MAX_IMAGES_PER_CHAPTER = 32; // host limit (rich-content.ts)
// Host limit is 2 MiB per image, but the base64 JSON-RPC line itself must stay
// under the host's 2 MiB message limit (an oversized line kills the plugin).
const MAX_IMAGE_BYTES = Math.floor(1.45 * 1024 * 1024);

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Resolve an image URL that may carry Legado ",{headers}" options. */
function resolveImageUrl(baseUrl, raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.startsWith('data:')) return '';
  const optMatch = /,\s*\{/.exec(s);
  if (optMatch && s.endsWith('}')) {
    return resolveUrl(baseUrl, s.slice(0, optMatch.index).trim()) + s.slice(optMatch.index);
  }
  return resolveUrl(baseUrl, s);
}

/**
 * Turn raw chapter content (HTML or newline separated text / image URLs) into
 * HTML whose images point at plugin resources (`reader-res:<ref>`).
 */
function buildRichHtml(parts, source) {
  const blocks = [];
  let images = 0;
  let skipped = 0;
  const imageTag = (url, referer) => {
    if (!url) return '';
    if (images >= MAX_IMAGES_PER_CHAPTER) {
      skipped++;
      return '';
    }
    images++;
    const ref = encodeRef({ s: source.bookSourceUrl, i: url, r: referer || '' });
    return `<p><img src="reader-res:${ref}" alt=""></p>`;
  };

  for (const { raw, baseUrl } of parts) {
    if (!raw) continue;
    // Pre-fix Legado scripts that emit <img src="https://...,{\"headers\":{...}}"> with unescaped quotes
    const text = String(raw).replace(
      /<img\s+[^>]*?src="([^"]*?,\s*\{[\s\S]*?\})"[^>]*?>/gi,
      (_, u) => `<img src='${u.replace(/'/g, '"')}'>`,
    );
    if (/<[a-z][\s\S]*>/i.test(text)) {
      const $ = cheerio.load(`<div id="__root">${text}</div>`);
      $('script,style,noscript,iframe').remove();
      $('#__root img, #__root amp-img').each((_, el) => {
        const $el = $(el);
        const src =
          $el.attr('data-original') || $el.attr('data-src') || $el.attr('_src') || $el.attr('src') || '';
        const url = resolveImageUrl(baseUrl, src);
        $el.replaceWith(imageTag(url, baseUrl));
      });
      // Keep paragraphs readable: split text on <br>.
      let html = $('#__root').html() || '';
      html = html.replace(/<br\s*\/?>/gi, '</p><p>');
      blocks.push(html);
    } else {
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (IMAGE_URL_RE.test(t)) blocks.push(imageTag(resolveImageUrl(baseUrl, t), baseUrl));
        else blocks.push(`<p>${escapeHtml(t)}</p>`);
      }
    }
  }
  if (skipped > 0) blocks.push(`<p>（本章另有 ${skipped} 张图片超出单章 ${MAX_IMAGES_PER_CHAPTER} 张上限，未显示）</p>`);
  return { html: blocks.join('\n'), images };
}

function sniffImageType(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'image/webp';
  return '';
}

/** Download one chapter image for the host (binary, size and type checked). */
export async function fetchImageResource(source, imageUrl, referer, { timeoutMs = 15_000, signal } = {}) {
  const extraHeaders = referer ? { Referer: referer } : undefined;
  const res = await fetchLegado(imageUrl, {
    baseUrl: referer || source.bookSourceUrl || '',
    sourceHeader: resolveSourceHeader(source),
    timeoutMs,
    signal,
    binary: true,
    maxBytes: MAX_IMAGE_BYTES,
    extraHeaders,
  });
  if (res.status >= 400) throw new Error(`image HTTP ${res.status}`);
  const type = sniffImageType(res.buffer);
  if (!type) throw new Error('unsupported image format (only PNG/JPEG/GIF/WebP)');
  return { mediaType: type, base64: res.buffer.toString('base64') };
}

function assertLegadoResponse(res, stage = 'search') {
  if (!res) throw new Error('Empty HTTP response');
  const body = String(res.body || '');
  if (
    (res.status === 403 || res.status === 503) &&
    /Attention Required! \| Cloudflare|<title>Just a moment\.\.\.<\/title>|cf-browser-verification/i.test(body.slice(0, 2048))
  ) {
    throw new Error(`HTTP ${res.status} (Cloudflare 防护拦截)`);
  }
  if (stage === 'search' || stage === 'explore') {
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
      throw new Error(`HTTP ${res.status}`);
    }
  } else if (res.status >= 400) {
    throw new Error(`HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Book lists (search + explore share the same parser)
// ---------------------------------------------------------------------------
function buildSearchUrl(source, query, page = 1) {
  const raw = String(source.searchUrl || '').trim();
  if (!raw) return '';
  const baseUrl = String(source.bookSourceUrl || '').trim();

  const ctx = new RuleContext({
    source,
    baseUrl,
    content: '',
    key: query,
    page,
  });

  if (raw.startsWith('@js:') || raw.includes('<js>')) {
    return ctx.getString(raw);
  }

  // Detect charset in trailing ,{...} option
  const parsed = parseLegadoUrl(raw, baseUrl, source.header || '');
  const encodedKey = encodeQueryParam(query, parsed.charset);

  // Replace {{key}} and {{page}}
  return ctx.interpolateTemplate(raw, { encodedKey });
}

function parseBookList(source, res, rule, { key = '', page = 1 } = {}) {
  const baseUrl = res.url || String(source.bookSourceUrl || '').trim();
  const ctx = new RuleContext({
    source,
    baseUrl,
    content: res.body,
    key,
    page,
  });

  // Optional init rule (keep object/HTML intact, do not stringify!)
  if (rule.init) {
    const initEls = ctx.getElements(rule.init);
    if (initEls.length > 0) ctx.content = initEls[0];
  }

  const items = ctx.getElements(rule.bookList);
  const results = [];
  const seenUrls = new Set();

  for (const item of items) {
    const itemCtx = ctx.cloneWith({ content: item });
    const rawTitle = itemCtx.getString(rule.name || 'text');
    const title = htmlToCleanText(rawTitle).replace(/\s+/g, ' ').trim() || rawTitle.trim();
    const author = itemCtx.getString(rule.author);
    const kind = rule.kind ? itemCtx.getString(rule.kind) : '';
    const wordCount = rule.wordCount ? itemCtx.getString(rule.wordCount) : '';
    itemCtx.book = { ...itemCtx.book, name: title, author, kind, wordCount };

    const bookUrl = itemCtx.getString(rule.bookUrl || 'href', true) || itemCtx.getString('a@href', true);
    if (!title || !bookUrl || /^javascript:/i.test(bookUrl) || seenUrls.has(bookUrl)) continue;
    seenUrls.add(bookUrl);

    const intro = itemCtx.getString(rule.intro);
    const coverUrl = itemCtx.getString(rule.coverUrl, true);
    const lastChapter = itemCtx.getString(rule.lastChapter);

    const meta = {
      sourceUrl: source.bookSourceUrl,
      bookUrl,
      title,
      author,
      kind,
      wordCount,
      intro,
      coverUrl,
      lastChapter,
      vars: { ...itemCtx.vars },
    };

    const entry = {
      ref: encodeRef({ s: source.bookSourceUrl, u: bookUrl, t: title }),
      title,
      sourceName: source.bookSourceName || source.bookSourceUrl,
    };
    if (author) entry.authors = [author];
    if (intro) entry.description = htmlToCleanText(intro).slice(0, 2000);
    if (coverUrl && /^https?:\/\//i.test(coverUrl)) entry.coverUrl = coverUrl;
    if (lastChapter) entry.latestChapter = lastChapter;

    results.push({ entry, meta });
  }

  return results;
}

export async function searchWithSource(source, query, { page = 1, timeoutMs = 8000, signal } = {}) {
  const searchUrl = buildSearchUrl(source, query, page);
  if (!searchUrl) return [];

  const res = await fetchLegado(searchUrl, {
    baseUrl: String(source.bookSourceUrl || '').trim(),
    sourceHeader: resolveSourceHeader(source),
    timeoutMs,
    signal,
  });
  assertLegadoResponse(res, 'search');

  return parseBookList(source, res, source.ruleSearch || {}, { key: query, page });
}

// ---------------------------------------------------------------------------
// Explore (发现页)
// ---------------------------------------------------------------------------
export function hasExplore(source) {
  return !!(source && source.enabledExplore !== false && String(source.exploreUrl || '').trim());
}

function parseExploreValue(value) {
  let list = [];
  if (Array.isArray(value)) {
    list = value;
  } else if (value && typeof value === 'object') {
    list = [value];
  } else {
    const str = String(value ?? '').trim();
    if (!str) return [];
    if (str.startsWith('[') || str.startsWith('{')) {
      try {
        const parsed = JSON.parse(str);
        list = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        list = [];
      }
    }
    if (list.length === 0) {
      list = str
        .split(/(?:&&|\n)+/)
        .map((line) => {
          const idx = line.indexOf('::');
          if (idx < 0) return null;
          return { title: line.slice(0, idx).trim(), url: line.slice(idx + 2).trim() };
        })
        .filter(Boolean);
    }
  }
  return list
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({ title: String(x.title ?? '').trim(), url: String(x.url ?? '').trim() }))
    .filter((x) => x.title && x.url);
}

/** Categories of a source's explore page: [{ title, url }]. */
export function exploreCategories(source) {
  const raw = String(source.exploreUrl || '').trim();
  if (!raw) return [];
  const ctx = new RuleContext({ source, baseUrl: String(source.bookSourceUrl || '').trim(), content: '' });
  let value = raw;
  try {
    if (raw.startsWith('@js:')) {
      value = ctx.runJs(ctx.prepareJsCode(raw.slice(4)), '');
    } else if (/^<js>[\s\S]*<\/js>$/i.test(raw)) {
      value = ctx.runJs(ctx.prepareJsCode(raw.replace(/^<js>/i, '').replace(/<\/js>$/i, '')), '');
    }
  } catch {
    value = '';
  }
  return parseExploreValue(value);
}

export async function exploreWithSource(source, exploreUrl, { page = 1, timeoutMs = 10_000, signal } = {}) {
  const baseUrl = String(source.bookSourceUrl || '').trim();
  const ctx = new RuleContext({ source, baseUrl, content: '', page });
  const raw = String(exploreUrl || '').trim();
  const url = raw.startsWith('@js:') || raw.includes('<js>') ? ctx.getString(raw) : ctx.interpolateTemplate(raw);
  if (!url) return [];

  const res = await fetchLegado(url, {
    baseUrl,
    sourceHeader: resolveSourceHeader(source),
    timeoutMs,
    signal,
  });
  assertLegadoResponse(res, 'explore');

  const exploreRule = source.ruleExplore || {};
  const rule = exploreRule.bookList ? exploreRule : source.ruleSearch || {};
  return parseBookList(source, res, rule, { page });
}

// ---------------------------------------------------------------------------
// Detail / TOC / content
// ---------------------------------------------------------------------------

// Most sources have no tocUrl rule and use the detail page as the TOC page.
// Keep detail responses briefly so the TOC request can reuse them instead of
// downloading the same page twice (one-shot: later refreshes hit the network).
const PAGE_CACHE = new Map();
const PAGE_CACHE_TTL_MS = 2 * 60_000;
const PAGE_CACHE_MAX = 32;
const PAGE_FETCH_CONCURRENCY = 4;

function pageCacheKey(source, url) {
  return `${source?.bookSourceUrl || ''}\n${url}`;
}

function rememberPage(source, url, res) {
  if (!url || !res || res.status >= 400) return;
  const key = pageCacheKey(source, url);
  PAGE_CACHE.delete(key);
  PAGE_CACHE.set(key, { res, at: Date.now() });
  while (PAGE_CACHE.size > PAGE_CACHE_MAX) PAGE_CACHE.delete(PAGE_CACHE.keys().next().value);
}

function recallPage(source, url) {
  const key = pageCacheKey(source, url);
  const hit = PAGE_CACHE.get(key);
  if (!hit) return null;
  PAGE_CACHE.delete(key);
  return Date.now() - hit.at <= PAGE_CACHE_TTL_MS ? hit.res : null;
}

function requestOptions(source, extra = {}) {
  return {
    baseUrl: String(source.bookSourceUrl || '').trim(),
    sourceHeader: resolveSourceHeader(source),
    ...extra,
  };
}

/** Take up to `max` not-yet-visited URLs from the queue (marking them visited). */
function takeBatch(queue, visited, max) {
  const batch = [];
  while (queue.length > 0 && batch.length < max) {
    const u = queue.shift();
    if (u && !visited.has(u)) {
      visited.add(u);
      batch.push(u);
    }
  }
  return batch;
}

export async function fetchBookDetail(source, meta, { timeoutMs = 10_000, signal } = {}) {
  const bookUrl = meta.bookUrl;
  const infoRule = source.ruleBookInfo || {};

  let title = meta.title || '未命名';
  let author = meta.author || '';
  let kind = meta.kind || '';
  let wordCount = meta.wordCount || '';
  let intro = meta.intro || '';
  let coverUrl = meta.coverUrl || '';
  let lastChapter = meta.lastChapter || '';
  let tocUrl = meta.tocUrl || bookUrl;

  if (bookUrl && Object.keys(infoRule).length > 0) {
    try {
      const res = await fetchLegado(bookUrl, requestOptions(source, { timeoutMs, signal, retries: 1 }));
      rememberPage(source, bookUrl, res);

      const ctx = new RuleContext({
        source,
        baseUrl: res.url || bookUrl,
        content: res.body,
        vars: meta.vars || {},
        book: { name: title, author, bookUrl, kind, wordCount },
      });

      if (infoRule.init) {
        const initEls = ctx.getElements(infoRule.init);
        if (initEls.length > 0) ctx.content = initEls[0];
      }

      const nTitle = ctx.getString(infoRule.name);
      const nAuthor = ctx.getString(infoRule.author);
      const nKind = infoRule.kind ? ctx.getString(infoRule.kind) : '';
      const nWord = infoRule.wordCount ? ctx.getString(infoRule.wordCount) : '';
      const nIntro = ctx.getString(infoRule.intro);
      const nCover = ctx.getString(infoRule.coverUrl, true);
      const nLast = ctx.getString(infoRule.lastChapter);

      if (nTitle) title = htmlToCleanText(nTitle).replace(/\s+/g, ' ').trim() || nTitle;
      if (nAuthor) author = nAuthor;
      if (nKind) kind = nKind;
      if (nWord) wordCount = nWord;
      ctx.book = { ...ctx.book, name: title, author, kind, wordCount };

      const nToc = ctx.getString(infoRule.tocUrl, true);
      if (nIntro) intro = htmlToCleanText(nIntro);
      if (nCover && /^https?:\/\//i.test(nCover)) coverUrl = nCover;
      if (nLast) lastChapter = nLast;
      if (nToc && /^https?:\/\//i.test(nToc)) tocUrl = nToc;
      meta.vars = { ...(meta.vars || {}), ...ctx.vars };
    } catch (err) {
      if (signal?.aborted) throw err;
      // Fallback to search metadata if detail fetch fails
    }
  }

  const entry = {
    ref: encodeRef({ s: source.bookSourceUrl, u: bookUrl, t: title }),
    title,
    sourceName: source.bookSourceName || source.bookSourceUrl,
  };
  if (author) entry.authors = [author];
  if (intro) entry.description = intro.slice(0, 4000);
  if (coverUrl && /^https?:\/\//i.test(coverUrl)) entry.coverUrl = coverUrl;
  if (lastChapter) entry.latestChapter = lastChapter;

  return {
    entry,
    meta: { ...meta, title, author, kind, wordCount, intro, coverUrl, lastChapter, tocUrl },
  };
}

/**
 * Build the chapter manifest. nextTocUrl may return one URL (followed as a
 * chain) or several (fetched concurrently), as in Legado.
 * Returns { manifest, truncated }.
 */
async function buildChapterManifest(source, meta, publicationRef, { timeoutMs = 12_000, signal, maxTocPages = 100 } = {}) {
  const tocRule = source.ruleToc || {};
  let startUrl = meta.tocUrl || meta.bookUrl;
  let effectiveMeta = meta;

  // If tocUrl wasn't resolved yet and ruleBookInfo exists, fetch detail first so book.kind / vars / tocUrl are ready
  if (!meta.tocUrl && (source.ruleBookInfo?.tocUrl || source.ruleBookInfo?.kind || source.ruleBookInfo?.name)) {
    const detailed = await fetchBookDetail(source, meta, { timeoutMs, signal });
    effectiveMeta = detailed.meta;
    startUrl = detailed.meta.tocUrl || meta.bookUrl;
  }

  const html = sourceUsesHtml(source);
  const mediaType = html ? 'text/html' : 'text/plain';
  const chapters = [];
  const visitedPages = new Set();
  const seenChapterUrls = new Set();
  const usedIds = new Set();
  const maxPages = Math.max(1, Math.min(500, Number(maxTocPages) || 100));

  const contentRuleStr = JSON.stringify(source.ruleContent || '');
  const contentNeedsVars = /java\.get\s*\(|@get:\{|getVariable\s*\(/i.test(contentRuleStr);
  let sharedVars = null;
  if (contentNeedsVars && effectiveMeta.vars && Object.keys(effectiveMeta.vars).length > 0) {
    const picked = {};
    for (const [k, v] of Object.entries(effectiveMeta.vars)) {
      if (typeof v === 'string' && v.length <= 256 && Object.keys(picked).length < 8) picked[k] = v;
    }
    if (Object.keys(picked).length > 0 && JSON.stringify(picked).length <= 512) sharedVars = picked;
  }

  const queue = startUrl ? [startUrl] : [];
  let pages = 0;
  let truncated = false;
  let firstBatch = true;

  while (queue.length > 0 && pages < maxPages) {
    const batch = takeBatch(queue, visitedPages, Math.min(PAGE_FETCH_CONCURRENCY, maxPages - pages));
    if (batch.length === 0) continue;
    pages += batch.length;
    const cachedFirst = firstBatch ? recallPage(source, batch[0]) : null;
    firstBatch = false;
    const settled = await Promise.allSettled(
      batch.map((u, i) =>
        i === 0 && cachedFirst
          ? Promise.resolve(cachedFirst)
          : fetchLegado(u, requestOptions(source, { timeoutMs, signal, retries: 1 })),
      ),
    );

    for (let b = 0; b < batch.length; b++) {
      const pageUrl = batch[b];
      let res;
      try {
        if (settled[b].status === 'rejected') throw settled[b].reason;
        res = settled[b].value;
        assertLegadoResponse(res, 'toc');
      } catch (err) {
        // The first page must work; a failing later page only truncates the TOC.
        if (signal?.aborted || chapters.length === 0) throw err;
        truncated = true;
        continue;
      }

      const ctx = new RuleContext({
        source,
        baseUrl: res.url || pageUrl,
        content: res.body,
        vars: effectiveMeta.vars || {},
        book: {
          name: effectiveMeta.title || '',
          author: effectiveMeta.author || '',
          bookUrl: effectiveMeta.bookUrl || '',
          kind: effectiveMeta.kind || '',
          wordCount: effectiveMeta.wordCount || '',
        },
      });

      const listEls = ctx.getElements(tocRule.chapterList);
      for (const el of listEls) {
        const elCtx = ctx.cloneWith({ content: el });
        const chTitle = elCtx.getString(tocRule.chapterName || 'text');
        const chUrl =
          elCtx.getString(tocRule.chapterUrl || 'href', true) ||
          elCtx.getString('a@href', true) ||
          res.url ||
          pageUrl;
        if (!chTitle || /^javascript:/i.test(chUrl)) continue;
        if (chUrl && seenChapterUrls.has(`${chTitle}@@${chUrl}`)) continue;
        seenChapterUrls.add(`${chTitle}@@${chUrl}`);

        const seq = chapters.length;
        let id = `ch-${seq}-${shortHash(chUrl || chTitle)}`;
        while (usedIds.has(id)) id = `${id}x`;
        usedIds.add(id);
        const refObj = { s: source.bookSourceUrl, c: chUrl };
        if (sharedVars) refObj.v = sharedVars;
        if (html) refObj.h = 1;
        const item = {
          id,
          ref: encodeRef(refObj),
          title: chTitle,
          mediaType,
          kind: 'chapter',
          seq,
        };
        if (chUrl && /^https?:\/\//i.test(chUrl)) {
          try {
            const cleanUrl = chUrl.replace(/,\s*\{[\s\S]*\}$/, '').trim();
            const parsed = new URL(cleanUrl);
            if (!parsed.username && !parsed.password) {
              item.sourceUrl = parsed.href;
            }
          } catch {
            // ignore
          }
        }
        chapters.push(item);
      }

      if (tocRule.nextTocUrl) {
        for (const nextUrl of ctx.getStringList(tocRule.nextTocUrl, true)) {
          if (nextUrl && nextUrl !== pageUrl && !visitedPages.has(nextUrl) && !queue.includes(nextUrl)) {
            queue.push(nextUrl);
          }
        }
      }
    }
  }
  if (queue.some((u) => u && !visitedPages.has(u))) truncated = true;

  const manifest = {
    publicationRef,
    sourceName: source.bookSourceName || source.bookSourceUrl,
    items: chapters,
  };
  // The host rejects (and kills the plugin on) JSON lines over 2 MiB.
  // For very long books drop the optional per-chapter source links first.
  if (Buffer.byteLength(JSON.stringify(manifest)) > 1.8 * 1024 * 1024) {
    for (const item of chapters) delete item.sourceUrl;
    if (Buffer.byteLength(JSON.stringify(manifest)) > 1.9 * 1024 * 1024) {
      throw new Error(`目录过大（${chapters.length} 章），超过宿主 2MB 消息上限`);
    }
  }
  return { manifest, truncated };
}

export async function fetchChapterManifest(source, meta, publicationRef, opts = {}) {
  const { manifest } = await buildChapterManifest(source, meta, publicationRef, opts);
  return manifest;
}

/**
 * Apply a Legado replaceRegex rule: one or more lines of `##pattern##replacement`
 * (`###` suffix = replace first match only), or an @js: / <js> script.
 */
export function applyReplaceRegex(text, replaceRegex, ctx = null) {
  const rule = String(replaceRegex ?? '').trim();
  if (!rule || !text) return text;
  if (rule.startsWith('@js:') || /^<js>[\s\S]*<\/js>$/i.test(rule)) {
    if (!ctx) return text;
    const code = rule.startsWith('@js:') ? rule.slice(4) : rule.replace(/^<js>/i, '').replace(/<\/js>$/i, '');
    const out = ctx.runJs(ctx.prepareJsCode(code), text, text);
    return out === undefined || out === null ? text : String(out);
  }
  let out = String(text);
  for (const line of rule.split('\n')) {
    const r = line.trim();
    if (!r.startsWith('##')) continue;
    let body = r.slice(2);
    let onlyFirst = false;
    if (body.endsWith('###')) {
      onlyFirst = true;
      body = body.slice(0, -3);
    }
    const idx = body.indexOf('##');
    const pattern = idx >= 0 ? body.slice(0, idx) : body;
    const replacement = idx >= 0 ? body.slice(idx + 2) : '';
    if (!pattern) continue;
    try {
      out = out.replace(new RegExp(pattern, onlyFirst ? '' : 'g'), replacement);
    } catch {
      // ignore bad regex
    }
  }
  return out;
}

function normalizeTextBlocks(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Fetch chapter content.
 * asHtml=false -> { mediaType: 'text/plain', text }
 * asHtml=true  -> { mediaType: 'text/html', text: html with reader-res images }
 * nextContentUrl may return one URL (chain) or several (fetched concurrently).
 */
export async function fetchChapterContent(
  source,
  chapterUrl,
  { timeoutMs = 12_000, signal, asHtml = false, vars = {}, chapter = null, maxPages = 30 } = {},
) {
  const contentRule = source.ruleContent || {};
  const visited = new Set();
  const queue = chapterUrl ? [chapterUrl] : [];
  const parts = [];
  const rawParts = [];
  const limit = Math.max(1, Math.min(100, Number(maxPages) || 30));
  const chapterInfo = { url: chapterUrl, title: chapter?.title || '', index: chapter?.index ?? 0 };
  let lastCtx = null;
  let pages = 0;

  while (queue.length > 0 && pages < limit) {
    const batch = takeBatch(queue, visited, Math.min(PAGE_FETCH_CONCURRENCY, limit - pages));
    if (batch.length === 0) continue;
    pages += batch.length;
    const settled = await Promise.allSettled(
      batch.map((u) => fetchLegado(u, requestOptions(source, { timeoutMs, signal, retries: 1 }))),
    );

    for (let b = 0; b < batch.length; b++) {
      const pageUrl = batch[b];
      let res;
      try {
        if (settled[b].status === 'rejected') throw settled[b].reason;
        res = settled[b].value;
        assertLegadoResponse(res, 'content');
      } catch (err) {
        // The first page must work; a failing later page only shortens the chapter.
        if (signal?.aborted || (parts.length === 0 && rawParts.length === 0)) throw err;
        continue;
      }

      const ctx = new RuleContext({
        source,
        baseUrl: res.url || pageUrl,
        content: res.body,
        vars,
        chapter: chapterInfo,
      });
      lastCtx = ctx;

      const rawContent = ctx.getString(contentRule.content);
      if (asHtml) {
        const replaced = applyReplaceRegex(rawContent, contentRule.replaceRegex, ctx);
        if (replaced) rawParts.push({ raw: replaced, baseUrl: res.url || pageUrl });
      } else {
        const cleaned = htmlToCleanText(rawContent);
        if (cleaned) parts.push(cleaned);
      }

      if (contentRule.nextContentUrl) {
        for (const nextUrl of ctx.getStringList(contentRule.nextContentUrl, true)) {
          const abs = resolveUrl(res.url || pageUrl, nextUrl);
          if (abs && abs !== pageUrl && !visited.has(abs) && !queue.includes(abs)) queue.push(abs);
        }
      }
    }
  }

  if (asHtml) {
    const { html } = buildRichHtml(rawParts, source);
    return {
      mediaType: 'text/html',
      text: html.trim() ? html : '<p>（本章正文为空或解析失败）</p>',
    };
  }

  // Like Legado, replaceRegex runs on the formatted text of the whole chapter.
  let text = parts.join('\n\n');
  if (text && contentRule.replaceRegex) {
    text = normalizeTextBlocks(applyReplaceRegex(text, contentRule.replaceRegex, lastCtx));
  }
  return {
    mediaType: 'text/plain',
    text: text || '（本章正文为空或解析失败）',
  };
}

// ---------------------------------------------------------------------------
// Full-chain self test (search -> detail -> toc -> first chapter)
// ---------------------------------------------------------------------------

/**
 * Run `run(signal)` with a deadline. On timeout the underlying requests are
 * aborted too (they used to keep running in the background).
 */
function withDeadline(run, ms, label, parentSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal) {
    if (parentSignal.aborted) onAbort();
    else parentSignal.addEventListener('abort', onAbort, { once: true });
  }
  let timer;
  return Promise.race([
    Promise.resolve().then(() => run(controller.signal)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`${label} 超时`);
        controller.abort(err);
        reject(err);
      }, ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onAbort);
  });
}

function normTitle(s) {
  return String(s ?? '').replace(/[\s《》「」【】()（）]/g, '').toLowerCase();
}

/** Prefer results whose title equals / contains the keyword (the first hit is often an unrelated book). */
function pickCandidates(found, keyword, max = 2) {
  const k = normTitle(keyword);
  const exact = [];
  const partial = [];
  const rest = [];
  for (const f of found) {
    const t = normTitle(f.entry?.title);
    if (k && t === k) exact.push(f);
    else if (k && t.includes(k)) partial.push(f);
    else rest.push(f);
  }
  return [...exact, ...partial, ...rest].slice(0, max);
}

function chapterHasBody(content, asHtml) {
  const body = String(content?.text || '');
  if (!body || body.includes('正文为空或解析失败')) return false;
  return asHtml ? body.includes('reader-res:') || htmlToCleanText(body).length > 30 : body.length > 30;
}

async function testCandidate(source, candidate, { signal, stepTimeoutMs }) {
  let stage = 'toc';
  try {
    const detailed = await withDeadline(
      (s) => fetchBookDetail(source, candidate.meta, { timeoutMs: stepTimeoutMs, signal: s }),
      stepTimeoutMs + 1000,
      '详情',
      signal,
    );
    // A health check only needs the first TOC pages, not a 100-page book.
    const { manifest, truncated } = await withDeadline(
      (s) => buildChapterManifest(source, detailed.meta, candidate.entry.ref, { timeoutMs: stepTimeoutMs, signal: s, maxTocPages: 3 }),
      stepTimeoutMs * 2,
      '目录',
      signal,
    );
    if (!manifest.items.length) return { ok: false, stage: 'toc', message: '目录为空', chapters: 0 };

    stage = 'content';
    const asHtml = sourceUsesHtml(source);
    const tryChapter = async (item, s) => {
      const ch = decodeRef(item.ref) || {};
      const content = await fetchChapterContent(source, ch.c, {
        timeoutMs: stepTimeoutMs,
        signal: s,
        asHtml,
        vars: ch.v || detailed.meta.vars || {},
        chapter: { title: item.title, index: item.seq },
        maxPages: 3,
      });
      return chapterHasBody(content, asHtml);
    };
    const hasBody = await withDeadline(
      async (s) => {
        if (await tryChapter(manifest.items[0], s)) return true;
        // The first entry is often a notice / “作品相关” page with almost no text.
        return manifest.items.length > 1 ? tryChapter(manifest.items[1], s) : false;
      },
      stepTimeoutMs * 2,
      '正文',
      signal,
    );
    if (!hasBody) {
      return { ok: false, stage: 'content', message: '前两章正文为空', chapters: manifest.items.length, truncated };
    }
    return { ok: true, stage: 'ok', chapters: manifest.items.length, truncated };
  } catch (err) {
    if (signal?.aborted) throw err;
    const msg = String(err?.message || err).slice(0, 120);
    return { ok: false, stage, message: `${stage === 'toc' ? '目录' : '正文'}失败：${msg}` };
  }
}

/**
 * Returns { ok, stage, message, ms, results?, chapters? }.
 * stage: 'search' | 'search-empty' | 'toc' | 'content' | 'ok'
 * 'search-empty' means the keyword was simply not found: not a failure.
 */
export async function testSourceChain(source, keyword, { signal, stepTimeoutMs = 8000 } = {}) {
  const started = Date.now();
  const done = (r) => ({ ...r, ms: Date.now() - started });
  let found;
  try {
    found = await withDeadline(
      (s) => searchWithSource(source, keyword, { timeoutMs: stepTimeoutMs, signal: s }),
      stepTimeoutMs + 1000,
      '搜索',
      signal,
    );
  } catch (err) {
    return done({ ok: false, stage: 'search', message: `搜索失败：${String(err?.message || err).slice(0, 120)}` });
  }
  if (!found || found.length === 0) {
    return done({ ok: false, stage: 'search-empty', message: `搜索“${keyword}”无结果` });
  }

  const candidates = pickCandidates(found, keyword, 2);
  let last = null;
  for (let i = 0; i < candidates.length; i++) {
    // Only try a second book when the first one failed quickly (keeps the total time bounded).
    if (i > 0 && Date.now() - started > stepTimeoutMs * 1.5) break;
    let r;
    try {
      r = await testCandidate(source, candidates[i], { signal, stepTimeoutMs });
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 120);
      return done({ ok: false, stage: last?.stage || 'toc', message: `检测中止：${msg}`, results: found.length });
    }
    if (r.ok) {
      return done({
        ok: true,
        stage: 'ok',
        message: `搜索 ${found.length} 条，目录 ${r.chapters}${r.truncated ? '+' : ''} 章`,
        results: found.length,
        chapters: r.chapters,
      });
    }
    last = r;
  }
  return done({
    ok: false,
    stage: last.stage,
    message: last.message,
    results: found.length,
    ...(last.chapters ? { chapters: last.chapters } : {}),
  });
}
