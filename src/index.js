import { createInterface } from 'node:readline';
import { loadSources, saveSources, mergeSources, cacheBookMeta, getCachedBookMeta } from './storage.js';
import {
  searchWithSource,
  fetchBookDetail,
  fetchChapterManifest,
  fetchChapterContent,
  decodeRef,
} from './legado-runner.js';
import { fetchLegado } from './http.js';

const inFlight = new Map(); // rpcId -> AbortController

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

async function getEnabledSources(dataDir) {
  const all = await loadSources(dataDir);
  return all.filter((s) => s && s.enabled !== false && s.searchUrl && (s.bookSourceType === undefined || s.bookSourceType === 0));
}

async function findSourceByUrl(dataDir, sourceUrl) {
  const all = await loadSources(dataDir);
  return all.find((s) => s.bookSourceUrl === sourceUrl) || null;
}

async function handleSearch(params, signal) {
  const dataDir = getDataDir(params);
  const req = params.request || {};
  const query = String(req.query || '').trim();
  const limit = Number(req.limit) || 200;
  const resultLimit = Number(req.resultLimit) || 200;

  const sources = await getEnabledSources(dataDir);
  if (sources.length === 0) {
    return {
      items: [],
      batch: { completed: 0, total: 0 },
      errors: [{ source: 'legado', code: 'NO_SOURCES', message: '尚未导入任何 Legado 书源，请先在插件管理页导入 JSON 书源。' }],
    };
  }

  // Batch pagination using cursor (offset into sources array)
  const batchSize = 15;
  const offset = req.cursor ? Number.parseInt(String(req.cursor), 10) || 0 : 0;
  const slice = sources.slice(offset, offset + batchSize);
  const completed = Math.min(offset + slice.length, sources.length);

  const items = [];
  const errors = [];

  await Promise.all(
    slice.map(async (src) => {
      if (signal.aborted) return;
      try {
        const found = await searchWithSource(src, query, { page: 1, timeoutMs: 7000, signal });
        for (const { entry, meta } of found) {
          cacheBookMeta(entry.ref, meta);
          items.push(entry);
        }
      } catch (err) {
        if (!signal.aborted) {
          errors.push({
            source: src.bookSourceName || src.bookSourceUrl,
            code: 'SOURCE_SEARCH_FAILED',
            message: String(err?.message || 'search failed').slice(0, 200),
          });
        }
      }
    }),
  );

  const capped = items.slice(0, Math.min(limit, resultLimit));
  const limitReached = items.length >= resultLimit;
  const hasMore = completed < sources.length && !limitReached;

  const page = {
    items: capped,
    batch: { completed, total: sources.length },
  };
  if (hasMore) page.nextCursor = String(completed);
  if (limitReached) page.limitReached = true;
  if (errors.length > 0) page.errors = errors.slice(0, 20);
  return page;
}

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
  if (!decoded || !decoded.s || !decoded.c) {
    throw new Error('Invalid chapter resource ref');
  }
  const source = await findSourceByUrl(dataDir, decoded.s);
  if (!source) {
    throw new Error(`Book source not found: ${decoded.s}`);
  }
  return fetchChapterContent(source, decoded.c, { signal });
}

async function renderManagePage(dataDir, notice = undefined, noticeKind = undefined) {
  const sources = await loadSources(dataDir);
  const enabledCount = sources.filter((s) => s.enabled !== false).length;

  const page = {
    title: 'Legado 书源管理',
    description: `当前已导入 ${sources.length} 条文字书源（启用 ${enabledCount} 条）。支持通过订阅 URL 或直接粘贴 Legado JSON 导入。`,
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
          {
            key: 'skip_paid',
            label: '自动跳过带 💰 标记的付费书源',
            type: 'boolean',
            value: true,
          },
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
          {
            key: 'skip_paid',
            label: '自动跳过带 💰 标记的付费书源',
            type: 'boolean',
            value: true,
          },
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
    sections: [
      {
        title: `已导入书源列表（展示前 ${Math.min(sources.length, 100)} / ${sources.length} 条）`,
        emptyText: '暂无书源，请使用上方表单导入。',
        items: sources.slice(0, 100).map((s) => ({
          title: s.bookSourceName || s.bookSourceUrl,
          description: `${s.bookSourceGroup ? `[${s.bookSourceGroup}] ` : ''}${s.bookSourceUrl}`,
        })),
      },
    ],
  };

  if (notice) {
    page.notice = notice;
    page.noticeKind = noticeKind || 'info';
  }
  return page;
}

async function handleExtensionAction(params, signal) {
  const dataDir = getDataDir(params);
  const action = params.action;
  const values = params.values || {};

  if (action === 'import-url') {
    const url = String(values.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return renderManagePage(dataDir, '请输入有效的 http:// 或 https:// 链接。', 'error');
    }
    try {
      const res = await fetchLegado(url, { timeoutMs: 20_000, signal });
      const parsed = JSON.parse(res.body);
      const stats = await mergeSources(dataDir, parsed, { skipPaid: values.skip_paid !== false });
      return renderManagePage(
        dataDir,
        `导入完成：新增 ${stats.added} 条，更新 ${stats.updated} 条，跳过 ${stats.skipped} 条，当前共 ${stats.total} 条。`,
        'info',
      );
    } catch (err) {
      return renderManagePage(dataDir, `网络导入失败：${err?.message || err}`, 'error');
    }
  }

  if (action === 'import-json') {
    const raw = String(values.json_text || '').trim();
    try {
      const parsed = JSON.parse(raw);
      const stats = await mergeSources(dataDir, parsed, { skipPaid: values.skip_paid !== false });
      return renderManagePage(
        dataDir,
        `导入完成：新增 ${stats.added} 条，更新 ${stats.updated} 条，跳过 ${stats.skipped} 条，当前共 ${stats.total} 条。`,
        'info',
      );
    } catch (err) {
      return renderManagePage(dataDir, `JSON 解析失败：${err?.message || err}`, 'error');
    }
  }

  if (action === 'clear-all') {
    await saveSources(dataDir, []);
    return renderManagePage(dataDir, '已清空全部书源。', 'info');
  }

  return renderManagePage(dataDir, `未知操作：${action}`, 'error');
}

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
    let result;
    switch (method) {
      case 'validateConfig':
        result = { ok: true };
        break;
      case 'search':
        result = await handleSearch(params, ctrl.signal);
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
        result = await renderManagePage(getDataDir(params));
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
