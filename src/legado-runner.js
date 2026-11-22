import { createHash } from 'node:crypto';
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

function buildSearchUrl(source, query, page = 1) {
  const raw = String(source.searchUrl || '').trim();
  if (!raw) return '';

  // Check if searchUrl starts with @js: or <js>
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

export async function searchWithSource(source, query, { page = 1, timeoutMs = 8000, signal } = {}) {
  const searchUrl = buildSearchUrl(source, query, page);
  if (!searchUrl) return [];

  const res = await fetchLegado(searchUrl, {
    baseUrl: source.bookSourceUrl || '',
    sourceHeader: source.header || '',
    timeoutMs,
    signal,
  });

  const rule = source.ruleSearch || {};
  const ctx = new RuleContext({
    source,
    baseUrl: res.url || source.bookSourceUrl || '',
    content: res.body,
    key: query,
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
    } catch {
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

  // If tocUrl wasn't resolved yet and ruleBookInfo.tocUrl exists, fetch detail first
  if (!meta.tocUrl && source.ruleBookInfo?.tocUrl) {
    const detailed = await fetchBookDetail(source, meta, { timeoutMs, signal });
    currentUrl = detailed.meta.tocUrl || meta.bookUrl;
  }

  const chapters = [];
  const visitedPages = new Set();
  const seenChapterUrls = new Set();
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
      vars: meta.vars || {},
      book: { name: meta.title || '', author: meta.author || '', bookUrl: meta.bookUrl || '' },
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
      const item = {
        id: `ch-${seq}-${shortHash(chUrl || chTitle)}`,
        ref: encodeRef({ s: source.bookSourceUrl, c: chUrl }),
        title: chTitle,
        mediaType: 'text/plain',
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

  return {
    publicationRef,
    sourceName: source.bookSourceName || source.bookSourceUrl,
    items: chapters,
  };
}

export async function fetchChapterContent(source, chapterUrl, { timeoutMs = 12_000, signal } = {}) {
  const contentRule = source.ruleContent || {};
  let currentUrl = chapterUrl;
  const visited = new Set();
  const parts = [];
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

    let rawContent = ctx.getString(contentRule.content);
    if (contentRule.replaceRegex && rawContent) {
      // Apply Legado replaceRegex rules (newline-separated or ##pattern##rep)
      const rules = String(contentRule.replaceRegex).split('\n').map((l) => l.trim()).filter(Boolean);
      for (const r of rules) {
        if (r.startsWith('##')) {
          const segs = r.slice(2).split('##');
          try {
            rawContent = rawContent.replace(new RegExp(segs[0], 'g'), segs[1] ?? '');
          } catch {
            // ignore bad regex
          }
        }
      }
    }

    const cleaned = htmlToCleanText(rawContent);
    if (cleaned) parts.push(cleaned);

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

  return {
    mediaType: 'text/plain',
    text: parts.join('\n\n') || '（本章正文为空或解析失败）',
  };
}
