import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { fetchLegado, encodeQueryParam, parseLegadoUrl, resolveUrl } from './http.js';
import { RuleContext, htmlToCleanText } from './engine.js';

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
  return String(source.bookSourceType) === '2';
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
    const text = String(raw);
    if (/<[a-z][\s\S]*>/i.test(text)) {
      const $ = cheerio.load(`<div id="__root">${text}</div>`);
      $('script,style,noscript,iframe').remove();
      $('#__root img').each((_, el) => {
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
    sourceHeader: source.header || '',
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

// ---------------------------------------------------------------------------
// Book lists (search + explore share the same parser)
// ---------------------------------------------------------------------------
function buildSearchUrl(source, query, page = 1) {
  const raw = String(source.searchUrl || '').trim();
  if (!raw) return '';

  const ctx = new RuleContext({
    source,
    baseUrl: source.bookSourceUrl || '',
    content: '',
    key: query,
    page,
  });

  if (raw.startsWith('@js:') || raw.includes('<js>')) {
    return ctx.getString(raw);
  }

  // Detect charset in trailing ,{...} option
  const parsed = parseLegadoUrl(raw, source.bookSourceUrl || '', source.header || '');
  const encodedKey = encodeQueryParam(query, parsed.charset);

  // Replace {{key}} and {{page}}
  return ctx.interpolateTemplate(raw, { encodedKey });
}

function parseBookList(source, res, rule, { key = '', page = 1 } = {}) {
  const ctx = new RuleContext({
    source,
    baseUrl: res.url || source.bookSourceUrl || '',
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
    const title = itemCtx.getString(rule.name || 'text');
    const bookUrl = itemCtx.getString(rule.bookUrl || 'href', true) || itemCtx.getString('a@href', true);
    if (!title || !bookUrl || seenUrls.has(bookUrl)) continue;
    seenUrls.add(bookUrl);

    const author = itemCtx.getString(rule.author);
    const intro = itemCtx.getString(rule.intro);
    const coverUrl = itemCtx.getString(rule.coverUrl, true);
    const lastChapter = itemCtx.getString(rule.lastChapter);

    const meta = {
      sourceUrl: source.bookSourceUrl,
      bookUrl,
      title,
      author,
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
    baseUrl: source.bookSourceUrl || '',
    sourceHeader: source.header || '',
    timeoutMs,
    signal,
  });
  if (res.status >= 500) throw new Error(`HTTP ${res.status}`);

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
  const ctx = new RuleContext({ source, baseUrl: source.bookSourceUrl || '', content: '' });
  let value = raw;
  try {
    if (raw.startsWith('@js:')) {
      value = ctx.runJs(raw.slice(4), '');
    } else if (/^<js>[\s\S]*<\/js>$/i.test(raw)) {
      value = ctx.runJs(raw.replace(/^<js>/i, '').replace(/<\/js>$/i, ''), '');
    }
  } catch {
    value = '';
  }
  return parseExploreValue(value);
}

export async function exploreWithSource(source, exploreUrl, { page = 1, timeoutMs = 10_000, signal } = {}) {
  const ctx = new RuleContext({ source, baseUrl: source.bookSourceUrl || '', content: '', page });
  const raw = String(exploreUrl || '').trim();
  const url = raw.startsWith('@js:') || raw.includes('<js>') ? ctx.getString(raw) : ctx.interpolateTemplate(raw);
  if (!url) return [];

  const res = await fetchLegado(url, {
    baseUrl: source.bookSourceUrl || '',
    sourceHeader: source.header || '',
    timeoutMs,
    signal,
  });
  if (res.status >= 500) throw new Error(`HTTP ${res.status}`);

  const exploreRule = source.ruleExplore || {};
  const rule = exploreRule.bookList ? exploreRule : source.ruleSearch || {};
  return parseBookList(source, res, rule, { page });
}

// ---------------------------------------------------------------------------
// Detail / TOC / content
// ---------------------------------------------------------------------------
export async function fetchBookDetail(source, meta, { timeoutMs = 10_000, signal } = {}) {
  const bookUrl = meta.bookUrl;
  const infoRule = source.ruleBookInfo || {};

  let title = meta.title || '未命名';
  let author = meta.author || '';
  let intro = meta.intro || '';
  let coverUrl = meta.coverUrl || '';
  let lastChapter = meta.lastChapter || '';
  let tocUrl = meta.tocUrl || bookUrl;

  if (bookUrl && Object.keys(infoRule).length > 0) {
    try {
      const res = await fetchLegado(bookUrl, {
        baseUrl: source.bookSourceUrl || '',
        sourceHeader: source.header || '',
        timeoutMs,
        signal,
      });

      const ctx = new RuleContext({
        source,
        baseUrl: res.url || bookUrl,
        content: res.body,
        vars: meta.vars || {},
        book: { name: title, author, bookUrl },
      });

      if (infoRule.init) {
        const initEls = ctx.getElements(infoRule.init);
        if (initEls.length > 0) ctx.content = initEls[0];
      }

      const nTitle = ctx.getString(infoRule.name);
      const nAuthor = ctx.getString(infoRule.author);
      const nIntro = ctx.getString(infoRule.intro);
      const nCover = ctx.getString(infoRule.coverUrl, true);
      const nLast = ctx.getString(infoRule.lastChapter);
      const nToc = ctx.getString(infoRule.tocUrl, true);

      if (nTitle) title = nTitle;
      if (nAuthor) author = nAuthor;
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
    meta: { ...meta, title, author, intro, coverUrl, lastChapter, tocUrl },
  };
}

export async function fetchChapterManifest(source, meta, publicationRef, { timeoutMs = 12_000, signal } = {}) {
  const tocRule = source.ruleToc || {};
  let currentUrl = meta.tocUrl || meta.bookUrl;
  let effectiveMeta = meta;

  // If tocUrl wasn't resolved yet and ruleBookInfo.tocUrl exists, fetch detail first
  if (!meta.tocUrl && source.ruleBookInfo?.tocUrl) {
    const detailed = await fetchBookDetail(source, meta, { timeoutMs, signal });
    effectiveMeta = detailed.meta;
    currentUrl = detailed.meta.tocUrl || meta.bookUrl;
  }

  const html = sourceUsesHtml(source);
  const mediaType = html ? 'text/html' : 'text/plain';
  const chapters = [];
  const visitedPages = new Set();
  const seenChapterUrls = new Set();
  const usedIds = new Set();
  const maxPages = 20;

  for (let p = 0; p < maxPages && currentUrl && !visitedPages.has(currentUrl); p++) {
    visitedPages.add(currentUrl);
    const res = await fetchLegado(currentUrl, {
      baseUrl: source.bookSourceUrl || '',
      sourceHeader: source.header || '',
      timeoutMs,
      signal,
    });

    const ctx = new RuleContext({
      source,
      baseUrl: res.url || currentUrl,
      content: res.body,
      vars: effectiveMeta.vars || {},
      book: {
        name: effectiveMeta.title || '',
        author: effectiveMeta.author || '',
        bookUrl: effectiveMeta.bookUrl || '',
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
        currentUrl;
      if (!chTitle) continue;
      if (chUrl && seenChapterUrls.has(`${chTitle}@@${chUrl}`)) continue;
      seenChapterUrls.add(`${chTitle}@@${chUrl}`);

      const seq = chapters.length;
      let id = `ch-${seq}-${shortHash(chUrl || chTitle)}`;
      while (usedIds.has(id)) id = `${id}x`;
      usedIds.add(id);
      const refObj = { s: source.bookSourceUrl, c: chUrl };
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
      const nextUrl = ctx.getString(tocRule.nextTocUrl, true);
      if (nextUrl && nextUrl !== currentUrl && !visitedPages.has(nextUrl)) {
        currentUrl = nextUrl;
      } else {
        break;
      }
    } else {
      break;
    }
  }

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
  return manifest;
}

function applyReplaceRegex(rawContent, replaceRegex) {
  if (!replaceRegex || !rawContent) return rawContent;
  // Apply Legado replaceRegex rules (newline-separated ##pattern##rep)
  let out = rawContent;
  const rules = String(replaceRegex).split('\n').map((l) => l.trim()).filter(Boolean);
  for (const r of rules) {
    if (r.startsWith('##')) {
      const segs = r.slice(2).split('##');
      try {
        out = out.replace(new RegExp(segs[0], 'g'), segs[1] ?? '');
      } catch {
        // ignore bad regex
      }
    }
  }
  return out;
}

/**
 * Fetch chapter content.
 * asHtml=false -> { mediaType: 'text/plain', text }
 * asHtml=true  -> { mediaType: 'text/html', text: html with reader-res images }
 */
export async function fetchChapterContent(source, chapterUrl, { timeoutMs = 12_000, signal, asHtml = false } = {}) {
  const contentRule = source.ruleContent || {};
  let currentUrl = chapterUrl;
  const visited = new Set();
  const parts = [];
  const rawParts = [];
  const maxPages = 10;

  for (let p = 0; p < maxPages && currentUrl && !visited.has(currentUrl); p++) {
    visited.add(currentUrl);
    const res = await fetchLegado(currentUrl, {
      baseUrl: source.bookSourceUrl || '',
      sourceHeader: source.header || '',
      timeoutMs,
      signal,
    });

    const ctx = new RuleContext({
      source,
      baseUrl: res.url || currentUrl,
      content: res.body,
    });

    const rawContent = applyReplaceRegex(ctx.getString(contentRule.content), contentRule.replaceRegex);
    if (asHtml) {
      if (rawContent) rawParts.push({ raw: rawContent, baseUrl: res.url || currentUrl });
    } else {
      const cleaned = htmlToCleanText(rawContent);
      if (cleaned) parts.push(cleaned);
    }

    if (contentRule.nextContentUrl) {
      const nextUrl = ctx.getString(contentRule.nextContentUrl, true);
      if (nextUrl && nextUrl !== currentUrl && !visited.has(nextUrl)) {
        currentUrl = resolveUrl(res.url || currentUrl, nextUrl);
      } else {
        break;
      }
    } else {
      break;
    }
  }

  if (asHtml) {
    const { html } = buildRichHtml(rawParts, source);
    return {
      mediaType: 'text/html',
      text: html.trim() ? html : '<p>（本章正文为空或解析失败）</p>',
    };
  }

  return {
    mediaType: 'text/plain',
    text: parts.join('\n\n') || '（本章正文为空或解析失败）',
  };
}

// ---------------------------------------------------------------------------
// Full-chain self test (search -> detail -> toc -> first chapter)
// ---------------------------------------------------------------------------
function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
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
      searchWithSource(source, keyword, { timeoutMs: stepTimeoutMs, signal }),
      stepTimeoutMs + 1000,
      '搜索',
    );
  } catch (err) {
    return done({ ok: false, stage: 'search', message: `搜索失败：${String(err?.message || err).slice(0, 120)}` });
  }
  if (!found || found.length === 0) {
    return done({ ok: false, stage: 'search-empty', message: `搜索“${keyword}”无结果` });
  }
  try {
    const first = found[0];
    const detailed = await withDeadline(
      fetchBookDetail(source, first.meta, { timeoutMs: stepTimeoutMs, signal }),
      stepTimeoutMs + 1000,
      '详情',
    );
    const manifest = await withDeadline(
      fetchChapterManifest(source, detailed.meta, first.entry.ref, { timeoutMs: stepTimeoutMs, signal }),
      stepTimeoutMs * 2,
      '目录',
    );
    if (!manifest.items.length) {
      return done({ ok: false, stage: 'toc', message: '目录为空', results: found.length });
    }
    const ch0 = decodeRef(manifest.items[0].ref);
    const asHtml = sourceUsesHtml(source);
    const content = await withDeadline(
      fetchChapterContent(source, ch0.c, { timeoutMs: stepTimeoutMs, signal, asHtml }),
      stepTimeoutMs * 2,
      '正文',
    );
    const body = String(content.text || '');
    const hasBody = asHtml
      ? body.includes('reader-res:') || htmlToCleanText(body).length > 30
      : body.length > 30;
    if (!hasBody || body.includes('正文为空或解析失败')) {
      return done({
        ok: false,
        stage: 'content',
        message: '第一章正文为空',
        results: found.length,
        chapters: manifest.items.length,
      });
    }
    return done({
      ok: true,
      stage: 'ok',
      message: `搜索 ${found.length} 条，目录 ${manifest.items.length} 章`,
      results: found.length,
      chapters: manifest.items.length,
    });
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 120);
    const stage = /正文/.test(msg) ? 'content' : 'toc';
    return done({ ok: false, stage, message: `${stage === 'toc' ? '目录' : '正文'}失败：${msg}`, results: found.length });
  }
}
