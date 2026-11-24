import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Small persistence helpers
// ---------------------------------------------------------------------------
async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data, pretty = false) {
  await mkdir(dirname(file), { recursive: true });
  // Unique temp name: two writers of the same file must never share a temp file.
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
  await writeFile(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data), 'utf8');
  await rename(tmp, file);
}

/** Debounced background writer; `flush()` writes immediately. */
function createDebouncedWriter(getFile, getData, delayMs) {
  let timer = null;
  let running = false;
  let again = false;
  const run = async () => {
    const file = getFile();
    if (!file) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await writeJsonAtomic(file, getData());
    } catch {
      // best effort
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    if (!getFile() || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delayMs);
    timer.unref?.();
  };
  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await run();
  };
  return { schedule, flush };
}

// ---------------------------------------------------------------------------
// Book sources
// ---------------------------------------------------------------------------
function storageFile(dataDir) {
  return join(dataDir, 'legado-sources.json');
}

let sourcesCache = { dataDir: '', list: null };
let sourcesLock = Promise.resolve();

/** Serialize read-modify-write operations on the source list. */
function withSourcesLock(fn) {
  const next = sourcesLock.then(fn, fn);
  sourcesLock = next.catch(() => {});
  return next;
}

export async function loadSources(dataDir) {
  if (!dataDir) return [];
  if (sourcesCache.dataDir === dataDir && sourcesCache.list) return sourcesCache.list;
  const parsed = await readJson(storageFile(dataDir), []);
  const list = Array.isArray(parsed) ? parsed.filter((s) => s && typeof s === 'object' && s.bookSourceUrl) : [];
  sourcesCache = { dataDir, list };
  return list;
}

export async function saveSources(dataDir, sources) {
  if (!dataDir) throw new Error('Plugin storage directory is not configured');
  await writeJsonAtomic(storageFile(dataDir), sources, true);
  sourcesCache = { dataDir, list: sources };
}

export function isSupportedSourceType(item, { allowComic = false } = {}) {
  const t = item?.bookSourceType;
  if (t === undefined || t === null || t === 0 || t === '0') return true;
  if (allowComic && (t === 2 || t === '2')) return true;
  return false;
}

export function mergeSources(dataDir, incoming, { skipPaid = true, allowComic = false } = {}) {
  return withSourcesLock(async () => {
    const existing = await loadSources(dataDir);
    const byUrl = new Map();
    for (const s of existing) {
      if (s && s.bookSourceUrl) byUrl.set(s.bookSourceUrl, s);
    }

    let added = 0;
    let updated = 0;
    let skipped = 0;

    const list = Array.isArray(incoming) ? incoming : [incoming];
    for (const item of list) {
      if (!item || typeof item !== 'object' || !item.bookSourceUrl) {
        skipped++;
        continue;
      }
      const name = String(item.bookSourceName || '');
      const group = String(item.bookSourceGroup || '');
      if (skipPaid && (name.includes('💰') || group.includes('💰'))) {
        skipped++;
        continue;
      }
      // Text sources (0); comic sources (2) only when explicitly allowed. Audio (1) is unsupported.
      if (!isSupportedSourceType(item, { allowComic })) {
        skipped++;
        continue;
      }
      const prev = byUrl.get(item.bookSourceUrl);
      if (prev) {
        // Keep the user's enable/disable and rich-HTML mode choices when a source is re-imported.
        const next = { ...item };
        if (prev.enabled === false) next.enabled = false;
        if (typeof prev.readerHtml === 'boolean') next.readerHtml = prev.readerHtml;
        byUrl.set(item.bookSourceUrl, next);
        updated++;
      } else {
        byUrl.set(item.bookSourceUrl, item);
        added++;
      }
    }

    const merged = [...byUrl.values()];
    await saveSources(dataDir, merged);
    return { total: merged.length, added, updated, skipped };
  });
}

/** Enable/disable the given source URLs. Returns how many changed. */
export function setSourcesEnabled(dataDir, urls, enabled) {
  const wanted = new Set(urls);
  return withSourcesLock(async () => {
    const list = await loadSources(dataDir);
    let changed = 0;
    const next = list.map((s) => {
      if (!wanted.has(s.bookSourceUrl)) return s;
      const isEnabled = s.enabled !== false;
      if (isEnabled === enabled) return s;
      changed++;
      return { ...s, enabled };
    });
    if (changed > 0) await saveSources(dataDir, next);
    return changed;
  });
}

/** Shallow-merge `patch` into one source. Returns true when it existed. */
export function updateSource(dataDir, url, patch) {
  return withSourcesLock(async () => {
    const list = await loadSources(dataDir);
    let found = false;
    const next = list.map((s) => {
      if (s.bookSourceUrl !== url) return s;
      found = true;
      return { ...s, ...patch };
    });
    if (found) await saveSources(dataDir, next);
    return found;
  });
}

/** Delete the given source URLs. Returns how many were removed. */
export function deleteSources(dataDir, urls) {
  const wanted = new Set(urls);

  return withSourcesLock(async () => {
    const list = await loadSources(dataDir);
    const next = list.filter((s) => !wanted.has(s.bookSourceUrl));
    const removed = list.length - next.length;
    if (removed > 0) await saveSources(dataDir, next);
    for (const url of urls) health.delete(url);
    if (removed > 0) healthWriter.schedule();
    return removed;
  });
}

export function clearAllSources(dataDir) {
  return withSourcesLock(async () => {
    await saveSources(dataDir, []);
    health.clear();
    healthWriter.schedule();
  });
}

// ---------------------------------------------------------------------------
// Persistent LRU cache of search/detail metadata (ref -> meta)
// ---------------------------------------------------------------------------
const bookMetaCache = new Map();
const MAX_CACHE = 5000;
let metaFile = '';

function compactMeta(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = { ...meta };
  if (typeof out.intro === 'string' && out.intro.length > 1000) out.intro = out.intro.slice(0, 1000);
  return out;
}

const metaWriter = createDebouncedWriter(
  () => metaFile,
  () => [...bookMetaCache.entries()],
  10_000, // ~1.3 MB file: write it at most every 10 s during a search burst
);

export function cacheBookMeta(ref, meta) {
  if (!ref) return;
  bookMetaCache.delete(ref);
  bookMetaCache.set(ref, compactMeta(meta));
  while (bookMetaCache.size > MAX_CACHE) {
    const firstKey = bookMetaCache.keys().next().value;
    if (firstKey === undefined) break;
    bookMetaCache.delete(firstKey);
  }
  metaWriter.schedule();
}

export function getCachedBookMeta(ref) {
  const meta = bookMetaCache.get(ref);
  if (!meta) return null;
  // Refresh recency (LRU); persisted on the next scheduled write.
  bookMetaCache.delete(ref);
  bookMetaCache.set(ref, meta);
  return meta;
}

// ---------------------------------------------------------------------------
// Plugin runtime settings (persisted in settings.json)
// ---------------------------------------------------------------------------
export const DEFAULT_SETTINGS = {
  searchBatchSize: 15,
  searchTimeoutMs: 15000,
  breakerThreshold: 3,
  breakerBaseMinutes: 10,
  breakerMaxHours: 6,
  checkConcurrency: 4,
  autoCheckEnabled: false,
  autoCheckHours: 24,
  autoCheckKeyword: '凡人修仙传',
  autoCheckDisableFailed: false,
  lastAutoCheckAt: 0,
};

let settings = { ...DEFAULT_SETTINGS };
let settingsFile = '';

function clampInt(val, min, max, fallback) {
  const n = Number.parseInt(String(val ?? ''), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeSettings(raw = {}) {
  return {
    searchBatchSize: clampInt(raw.searchBatchSize, 5, 40, DEFAULT_SETTINGS.searchBatchSize),
    searchTimeoutMs: clampInt(raw.searchTimeoutMs, 2000, 20000, DEFAULT_SETTINGS.searchTimeoutMs),
    breakerThreshold: clampInt(raw.breakerThreshold, 1, 20, DEFAULT_SETTINGS.breakerThreshold),
    breakerBaseMinutes: clampInt(raw.breakerBaseMinutes, 1, 1440, DEFAULT_SETTINGS.breakerBaseMinutes),
    breakerMaxHours: clampInt(raw.breakerMaxHours, 1, 72, DEFAULT_SETTINGS.breakerMaxHours),
    checkConcurrency: clampInt(raw.checkConcurrency, 1, 16, DEFAULT_SETTINGS.checkConcurrency),
    autoCheckEnabled: raw.autoCheckEnabled === true,
    autoCheckHours: clampInt(raw.autoCheckHours, 1, 168, DEFAULT_SETTINGS.autoCheckHours),
    autoCheckKeyword: String(raw.autoCheckKeyword || DEFAULT_SETTINGS.autoCheckKeyword).trim().slice(0, 50) || DEFAULT_SETTINGS.autoCheckKeyword,
    autoCheckDisableFailed: raw.autoCheckDisableFailed === true,
    lastAutoCheckAt: Number(raw.lastAutoCheckAt) || 0,
  };
}

export function getSettings() {
  return { ...settings };
}

export async function updateSettings(patch) {
  settings = sanitizeSettings({ ...settings, ...(patch || {}) });
  if (settingsFile) {
    await writeJsonAtomic(settingsFile, settings, true);
  }
  return getSettings();
}

// ---------------------------------------------------------------------------
// Source health / circuit breaker
// ---------------------------------------------------------------------------
export const BREAKER_THRESHOLD = DEFAULT_SETTINGS.breakerThreshold;

const health = new Map(); // bookSourceUrl -> record
let healthFile = '';

const healthWriter = createDebouncedWriter(
  () => healthFile,
  () => Object.fromEntries(health.entries()),
  3000,
);

function healthRecord(url) {
  let rec = health.get(url);
  if (!rec) {
    rec = {
      okCount: 0,
      failCount: 0,
      consecutiveFails: 0,
      avgMs: 0,
      lastOkAt: 0,
      lastFailAt: 0,
      lastError: '',
      cooldownUntil: 0,
    };
    health.set(url, rec);
  }
  return rec;
}

/**
 * Record the outcome of a live request against a source.
 * ok=false with an error counts towards the breaker; "no results" is a success.
 */
export function recordSourceResult(url, { ok, ms = 0, error = '' }) {
  if (!url) return;
  const rec = healthRecord(url);
  const now = Date.now();
  const threshold = settings.breakerThreshold || DEFAULT_SETTINGS.breakerThreshold;
  const baseMs = (settings.breakerBaseMinutes || DEFAULT_SETTINGS.breakerBaseMinutes) * 60_000;
  const maxMs = (settings.breakerMaxHours || DEFAULT_SETTINGS.breakerMaxHours) * 3600_000;
  if (ms > 0) rec.avgMs = rec.avgMs ? Math.round(rec.avgMs * 0.7 + ms * 0.3) : Math.round(ms);
  if (ok) {
    rec.okCount++;
    rec.consecutiveFails = 0;
    rec.cooldownUntil = 0;
    rec.lastOkAt = now;
  } else {
    rec.failCount++;
    rec.consecutiveFails++;
    rec.lastFailAt = now;
    rec.lastError = String(error || 'failed').slice(0, 200);
    if (rec.consecutiveFails >= threshold) {
      const factor = 2 ** Math.min(rec.consecutiveFails - threshold, 10);
      rec.cooldownUntil = now + Math.min(baseMs * factor, maxMs);
    }
  }
  healthWriter.schedule();
}

/** Store the latest full-chain health check result for a source. */
export function setCheckResult(url, check) {
  if (!url) return;
  healthRecord(url).check = { ...check, at: Date.now() };
  healthWriter.schedule();
}

export function getHealth(url) {
  return health.get(url) || null;
}

export function isCoolingDown(url, now = Date.now()) {
  const rec = health.get(url);
  return !!rec && rec.cooldownUntil > now;
}

/** Clear breaker state (all sources when urls is omitted). */
export function resetBreakers(urls) {
  const list = urls ? urls : [...health.keys()];
  for (const url of list) {
    const rec = health.get(url);
    if (rec) {
      rec.consecutiveFails = 0;
      rec.cooldownUntil = 0;
    }
  }
  healthWriter.schedule();
}

/**
 * Order for searching: healthy sources first, then unknown ones, then sources
 * with recent failures; within each group faster sources go first.
 */
export function rankSources(sources) {
  const scored = sources.map((s, i) => {
    const rec = health.get(s.bookSourceUrl);
    let tier = 1; // unknown
    if (rec) {
      if (rec.consecutiveFails > 0) tier = 2;
      else if (rec.okCount > 0) tier = 0;
    }
    const ms = rec?.avgMs || 4000;
    return { s, i, tier, ms };
  });
  scored.sort((a, b) => a.tier - b.tier || a.ms - b.ms || a.i - b.i);
  return scored.map((x) => x.s);
}

// ---------------------------------------------------------------------------
// Initialisation / shutdown
// ---------------------------------------------------------------------------
let initPromise = null;
let initDir = '';

/** Load persisted caches for this plugin data directory (idempotent). */
export function initStorage(dataDir) {
  if (!dataDir) return Promise.resolve();
  if (initPromise && initDir === dataDir) return initPromise;
  initDir = dataDir;
  metaFile = join(dataDir, 'book-meta-cache.json');
  healthFile = join(dataDir, 'source-health.json');
  settingsFile = join(dataDir, 'settings.json');
  initPromise = (async () => {
    const savedSettings = await readJson(settingsFile, null);
    if (savedSettings && typeof savedSettings === 'object') {
      settings = sanitizeSettings(savedSettings);
    }
    const metaEntries = await readJson(metaFile, []);
    if (Array.isArray(metaEntries)) {
      for (const pair of metaEntries.slice(-MAX_CACHE)) {
        if (Array.isArray(pair) && typeof pair[0] === 'string' && !bookMetaCache.has(pair[0])) {
          bookMetaCache.set(pair[0], pair[1]);
        }
      }
    }
    const healthObj = await readJson(healthFile, {});
    if (healthObj && typeof healthObj === 'object') {
      for (const [url, rec] of Object.entries(healthObj)) {
        if (rec && typeof rec === 'object' && !health.has(url)) health.set(url, rec);
      }
    }
  })();
  return initPromise;
}

export async function flushStorage() {
  await Promise.allSettled([metaWriter.flush(), healthWriter.flush()]);
}
