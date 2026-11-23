import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import {
  loadSources,
  mergeSources,
  clearAllSources,
  setSourcesEnabled,
  deleteSources,
  updateSource,
  cacheBookMeta,
  getCachedBookMeta,
  initStorage,
  flushStorage,
  recordSourceResult,
  setCheckResult,
  getHealth,
  isCoolingDown,
  resetBreakers,
  rankSources,
  isSupportedSourceType,
  BREAKER_THRESHOLD,
} from './storage.js';
import {
  searchWithSource,
  fetchBookDetail,
  fetchChapterManifest,
  fetchChapterContent,
  fetchImageResource,
  exploreCategories,
  exploreWithSource,
  hasExplore,
  sourceUsesHtml,
  testSourceChain,
  decodeRef,
  encodeRef,
} from './legado-runner.js';
import { fetchLegado, initCookieStore, clearCookies, cookieStats, flushCookies } from './http.js';

const inFlight = new Map(); // rpcId -> AbortController

const SEARCH_BATCH_SIZE = 15;
const SEARCH_TIMEOUT_MS = 7000;
const PAGE_SIZE = 50;
const DEFAULT_TEST_KEYWORD = '凡人修仙传';

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code: String(code || 'PLUGIN_ERROR'), message: String(message || 'Unknown error') } });
}

function getDataDir(params) {
  return params?.host?.dataDir || params?.host?.instanceDataDir || '';
}

async function ensureInit(dataDir) {
  if (!dataDir) return;
  await Promise.all([initStorage(dataDir), initCookieStore(dataDir)]);
}

function isEnabled(s) {
  return s && s.enabled !== false;
}

async function getEnabledSources(dataDir) {
  const all = await loadSources(dataDir);
  return all.filter((s) => isEnabled(s) && s.searchUrl && isSupportedSourceType(s, { allowComic: true }));
}

async function findSourceByUrl(dataDir, sourceUrl) {
  const all = await loadSources(dataDir);
  return all.find((s) => s.bookSourceUrl === sourceUrl) || null;
}

function errMessage(err) {
  return String(err?.message || err || 'failed').slice(0, 200);
}

// ---------------------------------------------------------------------------
// Batched search with a stable per-session plan
//
// The order of sources depends on health statistics, which change while a
// search is running. The cursor therefore points into a frozen plan
// (`<planId>.<offset>`) so later batches never skip or repeat sources.
// ---------------------------------------------------------------------------
const plans = new Map(); // planId -> { urls, skipped, createdAt }
const PLAN_TTL_MS = 15 * 60 * 1000;
const MAX_PLANS = 200;

function prunePlans() {
  const now = Date.now();
  for (const [id, plan] of plans) if (now - plan.createdAt > PLAN_TTL_MS) plans.delete(id);
  while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value);
}

function createPlan(sources, excludeUrl) {
  prunePlans();
  const now = Date.now();
  const candidates = sources.filter((s) => s.bookSourceUrl !== excludeUrl);
  const active = candidates.filter((s) => !isCoolingDown(s.bookSourceUrl, now));
  const id = randomUUID().slice(0, 8);
  const plan = {
    urls: rankSources(active).map((s) => s.bookSourceUrl),
    skipped: candidates.length - active.length,
    createdAt: now,
  };
  plans.set(id, plan);
  return { id, plan };
}

function parseCursor(cursor) {
  const raw = cursor ? String(cursor) : '';
  const m = /^([0-9a-f]{8})\.(\d+)$/.exec(raw);
  if (m) return { planId: m[1], offset: Number(m[2]) };
  const n = Number.parseInt(raw, 10);
  return { planId: '', offset: Number.isNaN(n) ? 0 : n };
}

async function runBatchedSearch(dataDir, req, signal, { excludeUrl = '', filter = null } = {}) {
  const query = String(req.query || '').trim();
  const limit = Number(req.limit) || 200;
  const resultLimit = Number(req.resultLimit) || 200;

  const sources = await getEnabledSources(dataDir);
  if (sources.length === 0) {
    return {
      items: [],
      batch: { completed: 0, total: 0 },
      errors: [{ source: 'legado', code: 'NO_SOURCES', message: '尚未导入任何可用的 Legado 书源，请先在插件管理页导入 JSON 书源。' }],
    };
  }
  if (!query) return { items: [], batch: { completed: 0, total: 0 } };

  const byUrl = new Map(sources.map((s) => [s.bookSourceUrl, s]));
  let { planId, offset } = parseCursor(req.cursor);
  let plan = planId ? plans.get(planId) : undefined;
  if (!plan) {
    const created = createPlan(sources, excludeUrl);
    planId = created.id;
    plan = created.plan;
  }

  const total = plan.urls.length;
  const sliceUrls = plan.urls.slice(offset, offset + SEARCH_BATCH_SIZE);
  const completed = Math.min(offset + sliceUrls.length, total);

  const items = [];
  const errors = [];
  if (offset === 0 && plan.skipped > 0) {
    errors.push({
      source: 'legado',
      code: 'SOURCES_PAUSED',
      message: `已暂时跳过 ${plan.skipped} 个连续失败 ${BREAKER_THRESHOLD} 次以上的书源（熔断中），可在插件管理页重置。`,
    });
  }

  await Promise.all(
    sliceUrls.map(async (url) => {
      const src = byUrl.get(url);
      if (!src || signal.aborted) return;
      const started = Date.now();
      try {
        const found = await searchWithSource(src, query, { page: 1, timeoutMs: SEARCH_TIMEOUT_MS, signal });
        if (signal.aborted) return;
        recordSourceResult(url, { ok: true, ms: Date.now() - started });
        for (const { entry, meta } of found) {
          if (filter && !filter(entry)) continue;
          cacheBookMeta(entry.ref, meta);
          items.push(entry);
        }
      } catch (err) {
        if (signal.aborted) return;
        recordSourceResult(url, { ok: false, ms: Date.now() - started, error: errMessage(err) });
        errors.push({
          source: src.bookSourceName || src.bookSourceUrl,
          code: 'SOURCE_SEARCH_FAILED',
          message: errMessage(err),
        });
      }
    }),
  );

  const capped = items.slice(0, Math.min(limit, resultLimit));
  const limitReached = items.length >= resultLimit;
  const hasMore = completed < total && !limitReached;

  const page = {
    items: capped,
    batch: { completed, total },
  };
  if (hasMore) page.nextCursor = `${planId}.${completed}`;
  if (limitReached) page.limitReached = true;
  if (errors.length > 0) page.errors = errors.slice(0, 20);
  return page;
}

async function handleSearch(params, signal) {
  return runBatchedSearch(getDataDir(params), params.request || {}, signal);
}

// ---------------------------------------------------------------------------
// content.alternatives (换源)
// ---------------------------------------------------------------------------
function normTitle(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[（(【\[][^）)】\]]*(全本|完本|精校|校对|无删|全集|连载)[^）)】\]]*[）)】\]]/g, '')
    .replace(/[\s·•・\-—_:：,，.。!！?？'"“”‘’《》<>()（）[\]【】]/g, '');
}

function normAuthor(s) {
  return normTitle(String(s ?? '').replace(/^\s*(作者|作\s*者)\s*[:：]?/, ''));
}

async function handleAlternatives(params, signal) {
  const dataDir = getDataDir(params);
  const req = params.request || {};
  const decoded = decodeRef(req.publicationRef);
  const wantTitle = normTitle(req.query);
  const wantAuthors = (Array.isArray(req.authors) ? req.authors : []).map(normAuthor).filter(Boolean);
  const filter = (entry) => {
    if (!wantTitle || normTitle(entry.title) !== wantTitle) return false;
    const authors = (entry.authors || []).map(normAuthor).filter(Boolean);
    if (wantAuthors.length === 0 || authors.length === 0) return true;
    return authors.some((a) => wantAuthors.some((w) => a.includes(w) || w.includes(a)));
  };
  return runBatchedSearch(dataDir, req, signal, { excludeUrl: decoded?.s || '', filter });
}

// ---------------------------------------------------------------------------
// browse (发现页)
// ---------------------------------------------------------------------------
async function handleBrowse(params, signal) {
  const dataDir = getDataDir(params);
  const req = params.request || {};
  const decoded = req.ref ? decodeRef(req.ref) : null;

  if (!decoded) {
    const sources = (await getEnabledSources(dataDir)).filter(hasExplore);
    return {
      title: '发现',
      items: [],
      navigation: sources.map((s) => ({
        ref: encodeRef({ k: 'src', s: s.bookSourceUrl }),
        title: s.bookSourceName || s.bookSourceUrl,
        kind: 'catalog',
      })),
      ...(sources.length === 0
        ? { errors: [{ source: 'legado', code: 'NO_EXPLORE', message: '已启用的书源中没有配置发现页（exploreUrl）。' }] }
        : {}),
    };
  }

  const source = await findSourceByUrl(dataDir, decoded.s);
  if (!source) throw new Error(`Book source not found: ${decoded.s}`);
  const name = source.bookSourceName || source.bookSourceUrl;

  if (decoded.k === 'src') {
    const cats = exploreCategories(source);
    return {
      title: name,
      items: [],
      navigation: cats.map((c) => ({
        ref: encodeRef({ k: 'exp', s: source.bookSourceUrl, u: c.url, t: c.title }),
        title: c.title,
        kind: 'catalog',
      })),
      ...(cats.length === 0
        ? { errors: [{ source: name, code: 'EXPLORE_EMPTY', message: '该书源的发现页没有可用分类（可能依赖登录或不受支持的脚本）。' }] }
        : {}),
    };
  }

  if (decoded.k === 'exp') {
    const page = Math.max(1, Number.parseInt(String(req.cursor || '1'), 10) || 1);
    try {
      const found = await exploreWithSource(source, decoded.u, { page, signal });
      const items = [];
      for (const { entry, meta } of found) {
        cacheBookMeta(entry.ref, meta);
        items.push(entry);
      }
      const paged = /\{\{\s*page\s*\}\}|\bpage\b/.test(String(decoded.u));
      const result = { title: `${name} · ${decoded.t || '发现'}`, items };
      if (paged && items.length > 0 && page < 100) result.nextCursor = String(page + 1);
      return result;
    } catch (err) {
      if (signal.aborted) throw err;
      return {
        title: `${name} · ${decoded.t || '发现'}`,
        items: [],
        errors: [{ source: name, code: 'EXPLORE_FAILED', message: errMessage(err) }],
      };
    }
  }

  throw new Error('Invalid browse ref');
}

// ---------------------------------------------------------------------------
// Detail / acquire / manifest / resources
// ---------------------------------------------------------------------------
async function handleDetail(params, signal) {
  const dataDir = getDataDir(params);
  const entryRef = params.entryRef;
  const decoded = decodeRef(entryRef);
  if (!decoded || !decoded.s || !decoded.u) {
    throw new Error('Invalid entryRef');
  }
  const source = await findSourceByUrl(dataDir, decoded.s);
  if (!source) {
    throw new Error(`Book source not found: ${decoded.s}`);
  }
  const cached = getCachedBookMeta(entryRef) || {
    sourceUrl: decoded.s,
    bookUrl: decoded.u,
    title: decoded.t || '未命名',
  };
  const { entry, meta } = await fetchBookDetail(source, cached, { signal });
  cacheBookMeta(entryRef, meta);
  cacheBookMeta(entry.ref, meta);
  return entry;
}

async function handleAcquire(params) {
  const entryRef = params.request?.entryRef;
  if (!entryRef) throw new Error('Missing entryRef');
  return {
    kind: 'chapters',
    publicationRef: entryRef,
  };
}

async function handleGetManifest(params, signal) {
  const dataDir = getDataDir(params);
  const publicationRef = params.publicationRef;
  const decoded = decodeRef(publicationRef);
  if (!decoded || !decoded.s || !decoded.u) {
    throw new Error('Invalid publicationRef');
  }
  const source = await findSourceByUrl(dataDir, decoded.s);
  if (!source) {
    throw new Error(`Book source not found: ${decoded.s}`);
  }
  const cached = getCachedBookMeta(publicationRef) || {
    sourceUrl: decoded.s,
    bookUrl: decoded.u,
    title: decoded.t || '未命名',
  };
  return fetchChapterManifest(source, cached, publicationRef, { signal });
}

async function handleReadResource(params, signal) {
  const dataDir = getDataDir(params);
  const ref = params.request?.ref;
  const decoded = decodeRef(ref);
  if (!decoded || !decoded.s || (!decoded.c && !decoded.i)) {
    throw new Error('Invalid resource ref');
  }
  const source = await findSourceByUrl(dataDir, decoded.s);
  if (!source) {
    throw new Error(`Book source not found (已删除？): ${decoded.s}`);
  }
  if (decoded.i) {
    return fetchImageResource(source, decoded.i, decoded.r || '', { signal });
  }
  // The media type is fixed by the manifest (h flag), never by current settings.
  return fetchChapterContent(source, decoded.c, { signal, asHtml: decoded.h === 1 });
}

// ---------------------------------------------------------------------------
// Background health check (测活)
// ---------------------------------------------------------------------------
const checkJob = {
  running: false,
  total: 0,
  done: 0,
  ok: 0,
  empty: 0,
  failed: 0,
  keyword: '',
  startedAt: 0,
  finishedAt: 0,
  autoDisable: false,
  disabled: 0,
  controller: null,
  failures: [], // { name, stage, message }
};

const STAGE_LABEL = {
  ok: '通过',
  search: '搜索失败',
  'search-empty': '未搜到',
  toc: '目录失败',
  content: '正文失败',
};

function isFailedCheck(check) {
  return !!check && !check.ok && check.stage !== 'search-empty';
}

async function runPool(items, concurrency, fn, signal) {
  let next = 0;
  async function worker() {
    while (next < items.length && !signal.aborted) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

function startCheckJob(dataDir, { keyword, scope, concurrency, autoDisable }) {
  if (checkJob.running) return false;
  const controller = new AbortController();
  Object.assign(checkJob, {
    running: true,
    total: 0,
    done: 0,
    ok: 0,
    empty: 0,
    failed: 0,
    keyword,
    startedAt: Date.now(),
    finishedAt: 0,
    autoDisable,
    disabled: 0,
    controller,
    failures: [],
  });

  void (async () => {
    try {
      const all = await loadSources(dataDir);
      const targets = all.filter(
        (s) => s.searchUrl && isSupportedSourceType(s, { allowComic: true }) && (scope === 'all' || isEnabled(s)),
      );
      checkJob.total = targets.length;
      const failedUrls = [];
      await runPool(
        targets,
        concurrency,
        async (src) => {
          const url = src.bookSourceUrl;
          let r;
          try {
            r = await testSourceChain(src, keyword, { signal: controller.signal, stepTimeoutMs: 8000 });
          } catch (err) {
            r = { ok: false, stage: 'search', message: errMessage(err), ms: 0 };
          }
          if (controller.signal.aborted) return;
          setCheckResult(url, { ok: r.ok, stage: r.stage, message: r.message, ms: r.ms, keyword });
          recordSourceResult(url, { ok: r.stage !== 'search', ms: r.ms, error: r.message });
          checkJob.done++;
          if (r.ok) checkJob.ok++;
          else if (r.stage === 'search-empty') checkJob.empty++;
          else {
            checkJob.failed++;
            failedUrls.push(url);
            if (checkJob.failures.length < 300) {
              checkJob.failures.push({ name: src.bookSourceName || url, stage: r.stage, message: r.message });
            }
          }
        },
        controller.signal,
      );
      if (!controller.signal.aborted && autoDisable && failedUrls.length > 0) {
        checkJob.disabled = await setSourcesEnabled(dataDir, failedUrls, false);
      }
    } catch (err) {
      checkJob.failures.push({ name: '检测任务', stage: 'search', message: errMessage(err) });
    } finally {
      checkJob.running = false;
      checkJob.finishedAt = Date.now();
      checkJob.controller = null;
      await flushStorage();
    }
  })();
  return true;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function checkJobText() {
  const j = checkJob;
  if (!j.startedAt) return '尚未运行过测活。';
  const lines = [];
  const state = j.running ? '进行中' : '已结束';
  lines.push(`状态：${state}　关键词：${j.keyword}　开始：${fmtTime(j.startedAt)}${j.finishedAt ? `　结束：${fmtTime(j.finishedAt)}` : ''}`);
  lines.push(`进度：${j.done} / ${j.total}　通过 ${j.ok}　未搜到 ${j.empty}　失败 ${j.failed}`);
  if (!j.running && j.autoDisable) lines.push(`已自动禁用失败书源：${j.disabled} 条`);
  if (j.failures.length > 0) {
    lines.push('', '失败明细：');
    for (const f of j.failures) lines.push(`[${STAGE_LABEL[f.stage] || f.stage}] ${f.name}：${f.message}`);
  }
  const text = lines.join('\n');
  return text.length > 60000 ? `${text.slice(0, 60000)}\n…` : text;
}

// ---------------------------------------------------------------------------
// Management page
// ---------------------------------------------------------------------------
const viewStates = new Map(); // userId -> { q, status, page }

function viewState(userId) {
  const key = userId || '_';
  let st = viewStates.get(key);
  if (!st) {
    st = { q: '', status: 'all', page: 1 };
    viewStates.set(key, st);
  }
  return st;
}

const STATUS_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'enabled', label: '已启用' },
  { value: 'disabled', label: '已禁用' },
  { value: 'failed', label: '测活失败' },
  { value: 'empty', label: '测活未搜到' },
  { value: 'passed', label: '测活通过' },
  { value: 'paused', label: '熔断中' },
  { value: 'untested', label: '未测活' },
];

function matchesStatus(s, status, now) {
  const rec = getHealth(s.bookSourceUrl);
  const check = rec?.check;
  switch (status) {
    case 'enabled':
      return isEnabled(s);
    case 'disabled':
      return !isEnabled(s);
    case 'failed':
      return isFailedCheck(check);
    case 'empty':
      return check?.stage === 'search-empty';
    case 'passed':
      return !!check?.ok;
    case 'paused':
      return isCoolingDown(s.bookSourceUrl, now);
    case 'untested':
      return !check;
    default:
      return true;
  }
}

function describeSource(s, now) {
  const rec = getHealth(s.bookSourceUrl);
  const parts = [];
  parts.push(isEnabled(s) ? '✅ 启用' : '⛔ 禁用');
  if (String(s.bookSourceType) === '2') parts.push('漫画');
  if (sourceUsesHtml(s)) parts.push('图文模式');
  if (hasExplore(s)) parts.push('有发现页');
  if (rec) {
    if (rec.avgMs) parts.push(`平均 ${rec.avgMs}ms`);
    if (rec.cooldownUntil > now) parts.push(`🔌 熔断至 ${fmtTime(rec.cooldownUntil)}`);
    else if (rec.consecutiveFails > 0) parts.push(`连续失败 ${rec.consecutiveFails} 次`);
    if (rec.check) {
      const label = STAGE_LABEL[rec.check.stage] || rec.check.stage;
      parts.push(`测活：${label}（${fmtTime(rec.check.at)}）`);
    }
  }
  const head = `${s.bookSourceGroup ? `[${s.bookSourceGroup}] ` : ''}${s.bookSourceUrl}`;
  let tail = '';
  if (rec?.check && !rec.check.ok) tail = `\n${rec.check.message}`;
  else if (rec?.lastError && rec.consecutiveFails > 0) tail = `\n最近错误：${rec.lastError}`;
  return `${head}\n${parts.join(' · ')}${tail}`.slice(0, 8000);
}

function sourceItem(s, now) {
  const url = s.bookSourceUrl;
  const enabled = isEnabled(s);
  const html = sourceUsesHtml(s);
  return {
    title: s.bookSourceName || url,
    description: describeSource(s, now),
    collapsible: true,
    selectable: true,
    key: url,
    forms: [
      { id: 'toggle', title: '', submit: enabled ? '禁用' : '启用', fields: [], values: { url } },
      { id: 'test-one', title: '', submit: '立即测活', fields: [], values: { url } },
      { id: 'reset-one', title: '', submit: '重置熔断', fields: [], values: { url } },
      { id: 'html-mode', title: '', submit: html ? '切换为纯文本模式' : '切换为图文模式', fields: [], values: { url } },
      {
        id: 'delete-one',
        title: '',
        submit: '删除',
        confirm: `确定删除书源“${(s.bookSourceName || url).slice(0, 100)}”吗？`,
        fields: [],
        values: { url },
      },
    ],
  };
}

async function renderManagePage(dataDir, userId, { notice, noticeKind, activeTab } = {}) {
  const sources = await loadSources(dataDir);
  const now = Date.now();
  const enabledCount = sources.filter(isEnabled).length;
  const pausedCount = sources.filter((s) => isCoolingDown(s.bookSourceUrl, now)).length;
  const failedCount = sources.filter((s) => isFailedCheck(getHealth(s.bookSourceUrl)?.check)).length;
  const st = viewState(userId);

  const q = st.q.trim().toLowerCase();
  const filtered = sources.filter((s) => {
    if (!matchesStatus(s, st.status, now)) return false;
    if (!q) return true;
    return [s.bookSourceName, s.bookSourceUrl, s.bookSourceGroup].some((v) => String(v || '').toLowerCase().includes(q));
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  st.page = Math.min(Math.max(1, st.page), pageCount);
  const start = (st.page - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);
  const cookies = cookieStats();

  const listForms = [
    {
      id: 'filter',
      layout: 'inline',
      title: '',
      submit: '筛选',
      fields: [
        { key: 'q', label: '关键词（名称 / 网址 / 分组）', type: 'text', value: st.q, placeholder: '留空显示全部' },
        { key: 'status', label: '状态', type: 'select', value: st.status, options: STATUS_OPTIONS },
        { key: 'page', label: `页码（共 ${pageCount} 页）`, type: 'number', value: st.page, min: 1, max: pageCount },
      ],
    },
    {
      id: 'batch',
      layout: 'inline',
      title: '',
      submit: '对勾选的书源执行',
      fields: [
        {
          key: 'op',
          label: '批量操作',
          type: 'select',
          value: 'disable',
          options: [
            { value: 'enable', label: '启用' },
            { value: 'disable', label: '禁用' },
            { value: 'reset', label: '重置熔断' },
            { value: 'delete', label: '删除' },
          ],
        },
      ],
    },
  ];
  if (st.page > 1) listForms.push({ id: 'goto-page', layout: 'inline', title: '', submit: '上一页', fields: [], values: { page: st.page - 1 } });
  if (st.page < pageCount)
    listForms.push({ id: 'goto-page-next', layout: 'inline', title: '', submit: '下一页', fields: [], values: { page: st.page + 1 } });

  const tabs = [
    {
      id: 'sources',
      title: '书源列表',
      description: `共 ${sources.length} 条（启用 ${enabledCount}，熔断中 ${pausedCount}，测活失败 ${failedCount}）。勾选书源后可批量操作；每条书源的“管理”菜单支持启用/禁用、单独测活、删除等。`,
      forms: listForms,
      sections: [
        {
          title: `筛选结果 ${filtered.length} 条 · 第 ${st.page} / ${pageCount} 页（第 ${filtered.length ? start + 1 : 0}–${start + pageItems.length} 条）`,
          emptyText: sources.length ? '没有符合条件的书源。' : '暂无书源，请在“导入”页导入。',
          items: pageItems.map((s) => sourceItem(s, now)),
        },
      ],
    },
    {
      id: 'check',
      title: checkJob.running ? `测活（${checkJob.done}/${checkJob.total}）` : '测活',
      description:
        '在后台对书源逐个执行“搜索 → 详情 → 目录 → 第一章正文”全链路检测。“未搜到”只表示该源没有这本书，不算失败。检测期间可离开本页，回来后点“刷新进度”。',
      forms: [
        {
          id: 'check-start',
          title: '开始测活',
          submit: checkJob.running ? '检测进行中…' : '开始检测',
          fields: [
            { key: 'keyword', label: '测试关键词（选热门书更准确）', type: 'text', value: checkJob.keyword || DEFAULT_TEST_KEYWORD, required: true },
            {
              key: 'scope',
              label: '检测范围',
              type: 'select',
              value: 'enabled',
              options: [
                { value: 'enabled', label: '仅已启用的书源' },
                { value: 'all', label: '全部书源' },
              ],
            },
            { key: 'concurrency', label: '并发数', type: 'number', value: 8, min: 1, max: 16 },
            { key: 'auto_disable', label: '检测完成后自动禁用失败的书源', type: 'boolean', value: false },
          ],
        },
        { id: 'check-refresh', layout: 'inline', title: '', submit: '刷新进度', fields: [] },
        { id: 'check-stop', layout: 'inline', title: '', submit: '停止检测', fields: [] },
        {
          id: 'disable-failed',
          layout: 'inline',
          title: '',
          submit: '禁用所有测活失败的书源',
          confirm: `将禁用 ${failedCount} 条测活失败的书源，确定吗？`,
          fields: [],
        },
        {
          id: 'delete-failed',
          layout: 'inline',
          title: '',
          submit: '删除所有测活失败的书源',
          confirm: `将永久删除 ${failedCount} 条测活失败的书源，确定吗？`,
          fields: [],
        },
        { id: 'reset-breakers', layout: 'inline', title: '', submit: '重置全部熔断状态', fields: [] },
      ],
      outputs: [{ title: '测活结果', text: checkJobText(), format: 'log' }],
    },
    {
      id: 'import',
      title: '导入',
      description: '支持订阅 URL 或直接粘贴 Legado JSON。按 bookSourceUrl 去重，重新导入时保留你设置的启用/禁用状态。',
      forms: [
        {
          id: 'import-url',
          title: '通过网络链接导入书源（JSON URL）',
          submit: '拉取并导入',
          fields: [
            {
              key: 'url',
              label: '书源 JSON 链接',
              type: 'text',
              placeholder: 'https://raw.githubusercontent.com/XIU2/Yuedu/master/shuyuan',
              required: true,
            },
            { key: 'skip_paid', label: '自动跳过带 💰 标记的付费书源', type: 'boolean', value: true },
            { key: 'allow_comic', label: '同时导入漫画书源（实验，图文模式显示）', type: 'boolean', value: false },
          ],
        },
        {
          id: 'import-json',
          title: '粘贴 Legado 书源 JSON 导入',
          submit: '解析并导入',
          fields: [
            {
              key: 'json_text',
              label: '书源 JSON 内容',
              type: 'textarea',
              placeholder: '[{"bookSourceUrl": "...", "bookSourceName": "..."}]',
              required: true,
            },
            { key: 'skip_paid', label: '自动跳过带 💰 标记的付费书源', type: 'boolean', value: true },
            { key: 'allow_comic', label: '同时导入漫画书源（实验，图文模式显示）', type: 'boolean', value: false },
          ],
        },
        {
          id: 'clear-all',
          title: '清空全部已导入书源',
          submit: '清空书源',
          confirm: '确定要清空所有已导入的 Legado 书源吗？',
          fields: [],
        },
      ],
    },
    {
      id: 'maintenance',
      title: '维护',
      description: `Cookie 已持久化保存（当前 ${cookies.domains} 个站点、${cookies.cookies} 条），容器重启后登录态仍然有效。搜索结果元数据缓存也已持久化。`,
      forms: [
        {
          id: 'clear-cookies',
          title: '清除全部 Cookie',
          submit: '清除 Cookie',
          confirm: '清除后需要登录的书源会失去登录状态，确定吗？',
          fields: [],
        },
      ],
    },
  ];

  const page = {
    title: 'Legado 书源管理',
    description: `已导入 ${sources.length} 条书源（启用 ${enabledCount} 条）。`,
    forms: [],
    tabs,
    activeTab: activeTab || (checkJob.running ? 'check' : 'sources'),
  };
  if (notice) {
    page.notice = String(notice).slice(0, 8000);
    page.noticeKind = noticeKind || 'info';
  }
  return page;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function handleExtensionAction(params, signal) {
  const dataDir = getDataDir(params);
  const userId = params.userId || '';
  const action = params.action;
  const values = params.values || {};
  const render = (notice, noticeKind = 'info', activeTab) => renderManagePage(dataDir, userId, { notice, noticeKind, activeTab });
  const st = viewState(userId);
  const url = typeof values.url === 'string' ? values.url : '';

  switch (action) {
    // ----- list / navigation
    case 'filter': {
      st.q = String(values.q ?? '');
      st.status = STATUS_OPTIONS.some((o) => o.value === values.status) ? values.status : 'all';
      st.page = Math.max(1, Number.parseInt(String(values.page ?? '1'), 10) || 1);
      return render(undefined, undefined, 'sources');
    }
    case 'goto-page':
    case 'goto-page-next': {
      st.page = Math.max(1, Number.parseInt(String(values.page ?? '1'), 10) || 1);
      return render(undefined, undefined, 'sources');
    }
    case 'batch': {
      const ids = Array.isArray(values.ids) ? values.ids.filter((x) => typeof x === 'string') : [];
      if (ids.length === 0) return render('请先勾选要操作的书源。', 'error', 'sources');
      const op = String(values.op || '');
      if (op === 'enable') return render(`已启用 ${await setSourcesEnabled(dataDir, ids, true)} 条书源。`, 'info', 'sources');
      if (op === 'disable') return render(`已禁用 ${await setSourcesEnabled(dataDir, ids, false)} 条书源。`, 'info', 'sources');
      if (op === 'delete') return render(`已删除 ${await deleteSources(dataDir, ids)} 条书源。`, 'info', 'sources');
      if (op === 'reset') {
        resetBreakers(ids);
        return render(`已重置 ${ids.length} 条书源的熔断状态。`, 'info', 'sources');
      }
      return render(`未知批量操作：${op}`, 'error', 'sources');
    }

    // ----- single source
    case 'toggle': {
      const src = await findSourceByUrl(dataDir, url);
      if (!src) return render('书源不存在或已被删除。', 'error', 'sources');
      const next = !isEnabled(src);
      await setSourcesEnabled(dataDir, [url], next);
      return render(`已${next ? '启用' : '禁用'}：${src.bookSourceName || url}`, 'info', 'sources');
    }
    case 'delete-one': {
      const n = await deleteSources(dataDir, [url]);
      return render(n ? '已删除 1 条书源。' : '书源不存在或已被删除。', n ? 'info' : 'error', 'sources');
    }
    case 'reset-one': {
      resetBreakers([url]);
      return render('已重置该书源的熔断状态。', 'info', 'sources');
    }
    case 'html-mode': {
      const src = await findSourceByUrl(dataDir, url);
      if (!src) return render('书源不存在或已被删除。', 'error', 'sources');
      const next = !sourceUsesHtml(src);
      await updateSource(dataDir, url, { readerHtml: next });
      return render(
        `已将“${src.bookSourceName || url}”切换为${next ? '图文模式（正文保留图片）' : '纯文本模式'}。只影响之后新加入书架或重新获取目录的书。`,
        'info',
        'sources',
      );
    }
    case 'test-one': {
      const src = await findSourceByUrl(dataDir, url);
      if (!src) return render('书源不存在或已被删除。', 'error', 'sources');
      const keyword = checkJob.keyword || DEFAULT_TEST_KEYWORD;
      let r;
      try {
        r = await withTimeout(
          testSourceChain(src, keyword, { signal, stepTimeoutMs: 5000 }),
          24_000,
          '检测超过 24 秒，已中止（可在“测活”页用后台检测）',
        );
      } catch (err) {
        r = { ok: false, stage: 'search', message: errMessage(err), ms: 24_000 };
      }
      setCheckResult(url, { ok: r.ok, stage: r.stage, message: r.message, ms: r.ms, keyword });
      recordSourceResult(url, { ok: r.stage !== 'search', ms: r.ms, error: r.message });
      return render(
        `测活“${src.bookSourceName || url}”（关键词：${keyword}）：${STAGE_LABEL[r.stage] || r.stage}，${r.message}，耗时 ${r.ms}ms`,
        r.ok || r.stage === 'search-empty' ? 'info' : 'error',
        'sources',
      );
    }

    // ----- health check job
    case 'check-start': {
      const keyword = String(values.keyword || '').trim() || DEFAULT_TEST_KEYWORD;
      const scope = values.scope === 'all' ? 'all' : 'enabled';
      const concurrency = Math.min(16, Math.max(1, Number.parseInt(String(values.concurrency ?? '8'), 10) || 8));
      const started = startCheckJob(dataDir, { keyword, scope, concurrency, autoDisable: values.auto_disable === true });
      return render(started ? '测活已在后台开始，稍后点击“刷新进度”查看。' : '已有测活任务在运行。', started ? 'info' : 'error', 'check');
    }
    case 'check-refresh':
      return render(undefined, undefined, 'check');
    case 'check-stop': {
      if (checkJob.running && checkJob.controller) {
        checkJob.controller.abort(new Error('CANCELLED'));
        return render('已请求停止测活。', 'info', 'check');
      }
      return render('当前没有运行中的测活任务。', 'info', 'check');
    }
    case 'disable-failed':
    case 'delete-failed': {
      const sources = await loadSources(dataDir);
      const urls = sources.filter((s) => isFailedCheck(getHealth(s.bookSourceUrl)?.check)).map((s) => s.bookSourceUrl);
      if (urls.length === 0) return render('没有测活失败的书源。', 'info', 'check');
      if (action === 'disable-failed') return render(`已禁用 ${await setSourcesEnabled(dataDir, urls, false)} 条测活失败的书源。`, 'info', 'check');
      return render(`已删除 ${await deleteSources(dataDir, urls)} 条测活失败的书源。`, 'info', 'check');
    }
    case 'reset-breakers': {
      resetBreakers();
      return render('已重置全部书源的熔断状态。', 'info', 'check');
    }

    // ----- import
    case 'import-url': {
      const importUrl = String(values.url || '').trim();
      if (!/^https?:\/\//i.test(importUrl)) {
        return render('请输入有效的 http:// 或 https:// 链接。', 'error', 'import');
      }
      try {
        const res = await fetchLegado(importUrl, { timeoutMs: 20_000, signal });
        const parsed = JSON.parse(res.body);
        const stats = await mergeSources(dataDir, parsed, {
          skipPaid: values.skip_paid !== false,
          allowComic: values.allow_comic === true,
        });
        return render(
          `导入完成：新增 ${stats.added} 条，更新 ${stats.updated} 条，跳过 ${stats.skipped} 条，当前共 ${stats.total} 条。`,
          'info',
          'import',
        );
      } catch (err) {
        return render(`网络导入失败：${errMessage(err)}`, 'error', 'import');
      }
    }
    case 'import-json': {
      const raw = String(values.json_text || '').trim();
      try {
        const parsed = JSON.parse(raw);
        const stats = await mergeSources(dataDir, parsed, {
          skipPaid: values.skip_paid !== false,
          allowComic: values.allow_comic === true,
        });
        return render(
          `导入完成：新增 ${stats.added} 条，更新 ${stats.updated} 条，跳过 ${stats.skipped} 条，当前共 ${stats.total} 条。`,
          'info',
          'import',
        );
      } catch (err) {
        return render(`JSON 解析失败：${errMessage(err)}`, 'error', 'import');
      }
    }
    case 'clear-all': {
      await clearAllSources(dataDir);
      return render('已清空全部书源。', 'info', 'import');
    }

    // ----- maintenance
    case 'clear-cookies': {
      clearCookies();
      await flushCookies();
      return render('已清除全部 Cookie。', 'info', 'maintenance');
    }

    default:
      return render(`未知操作：${action}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------
async function dispatch(msg) {
  if (msg.method === '$/cancelRequest') {
    const targetId = msg.params?.id;
    const ctrl = inFlight.get(targetId);
    if (ctrl) {
      ctrl.abort(new Error('CANCELLED'));
      inFlight.delete(targetId);
    }
    return;
  }

  const { id, method, params = {} } = msg;
  const ctrl = new AbortController();
  inFlight.set(id, ctrl);

  try {
    await ensureInit(getDataDir(params));
    let result;
    switch (method) {
      case 'validateConfig':
        result = { ok: true };
        break;
      case 'search':
        result = await handleSearch(params, ctrl.signal);
        break;
      case 'alternatives':
        result = await handleAlternatives(params, ctrl.signal);
        break;
      case 'browse':
        result = await handleBrowse(params, ctrl.signal);
        break;
      case 'detail':
        result = await handleDetail(params, ctrl.signal);
        break;
      case 'acquire':
        result = await handleAcquire(params);
        break;
      case 'getManifest':
        result = await handleGetManifest(params, ctrl.signal);
        break;
      case 'readResource':
        result = await handleReadResource(params, ctrl.signal);
        break;
      case 'extension.page':
        result = await renderManagePage(getDataDir(params), params.userId || '');
        break;
      case 'extension.action':
        result = await handleExtensionAction(params, ctrl.signal);
        break;
      default:
        throw new Error(`Unsupported RPC method: ${method}`);
    }
    sendResult(id, result);
  } catch (err) {
    sendError(id, err?.code || 'PLUGIN_ERROR', err?.message || String(err));
  } finally {
    inFlight.delete(id);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  void dispatch(msg);
});
rl.on('close', () => {
  // Host closed stdin: persist pending caches before exiting.
  Promise.allSettled([flushStorage(), flushCookies()]).finally(() => process.exit(0));
});
