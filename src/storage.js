import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const bookMetaCache = new Map();
const MAX_CACHE = 5000;

export function cacheBookMeta(ref, meta) {
  if (bookMetaCache.size >= MAX_CACHE) {
    const firstKey = bookMetaCache.keys().next().value;
    if (firstKey) bookMetaCache.delete(firstKey);
  }
  bookMetaCache.set(ref, meta);
}

export function getCachedBookMeta(ref) {
  return bookMetaCache.get(ref) || null;
}

function storageFile(dataDir) {
  return join(dataDir, 'legado-sources.json');
}

export async function loadSources(dataDir) {
  if (!dataDir) return [];
  try {
    const raw = await readFile(storageFile(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveSources(dataDir, sources) {
  if (!dataDir) throw new Error('Plugin storage directory is not configured');
  await mkdir(dataDir, { recursive: true });
  await writeFile(storageFile(dataDir), JSON.stringify(sources, null, 2), 'utf8');
}

export async function mergeSources(dataDir, incoming, { skipPaid = true } = {}) {
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
    // Only keep text novel sources (bookSourceType === 0 or undefined)
    if (item.bookSourceType !== undefined && item.bookSourceType !== 0) {
      skipped++;
      continue;
    }
    if (byUrl.has(item.bookSourceUrl)) {
      byUrl.set(item.bookSourceUrl, item);
      updated++;
    } else {
      byUrl.set(item.bookSourceUrl, item);
      added++;
    }
  }

  const merged = [...byUrl.values()];
  await saveSources(dataDir, merged);
  return { total: merged.length, added, updated, skipped };
}
