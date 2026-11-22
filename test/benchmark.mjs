import { readFile, writeFile } from 'node:fs/promises';
import { searchWithSource, fetchBookDetail, fetchChapterManifest, fetchChapterContent } from '../src/legado-runner.js';

const SOURCES_FILE = process.argv[2] || '/tmp/verified_sources.json';
const LIMIT = Number(process.argv[3]) || 60;
const CONCURRENCY = Number(process.argv[4]) || 12;

async function runPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

const all = JSON.parse(await readFile(SOURCES_FILE, 'utf8'));
const textSources = all.filter((s) => (s.bookSourceType === undefined || s.bookSourceType === 0) && s.searchUrl);
const sample = textSources.slice(0, LIMIT);

console.log(`Loaded ${all.length} sources (${textSources.length} text). Testing ${sample.length} end-to-end...`);

const stats = {
  searchOk: 0,
  searchEmpty: 0,
  searchErr: 0,
  tocOk: 0,
  contentOk: 0,
  fullPass: [],
  searchFailSamples: [],
  tocFailSamples: [],
  contentFailSamples: [],
};

await runPool(sample, CONCURRENCY, async (src) => {
  const name = src.bookSourceName || src.bookSourceUrl;
  let found;
  try {
    found = await searchWithSource(src, '凡人修仙传', { timeoutMs: 8000 });
  } catch (err) {
    stats.searchErr++;
    if (stats.searchFailSamples.length < 15) {
      stats.searchFailSamples.push({ name, url: src.bookSourceUrl, reason: `ERR: ${err.message}`, searchUrl: src.searchUrl });
    }
    return;
  }

  if (!found || found.length === 0) {
    stats.searchEmpty++;
    if (stats.searchFailSamples.length < 15) {
      stats.searchFailSamples.push({
        name,
        url: src.bookSourceUrl,
        reason: 'EMPTY',
        searchUrl: src.searchUrl,
        bookList: src.ruleSearch?.bookList,
      });
    }
    return;
  }
  stats.searchOk++;

  // Pick first result and test detail + TOC + chapter 1 content
  const first = found[0];
  try {
    const detailed = await fetchBookDetail(src, first.meta, { timeoutMs: 8000 });
    const manifest = await fetchChapterManifest(src, detailed.meta, first.entry.ref, { timeoutMs: 10000 });
    if (!manifest.items || manifest.items.length === 0) {
      if (stats.tocFailSamples.length < 10) {
        stats.tocFailSamples.push({
          name,
          bookUrl: detailed.meta.bookUrl,
          tocUrl: detailed.meta.tocUrl,
          chapterList: src.ruleToc?.chapterList,
        });
      }
      return;
    }
    stats.tocOk++;

    const ch0 = manifest.items[0];
    const chUrl = JSON.parse(Buffer.from(ch0.ref, 'base64url').toString('utf8')).c;
    const content = await fetchChapterContent(src, chUrl, { timeoutMs: 10000 });
    if (content.text && content.text.length > 30 && !content.text.includes('正文为空或解析失败')) {
      stats.contentOk++;
      stats.fullPass.push({ name, results: found.length, chapters: manifest.items.length, ch0Len: content.text.length, src });
    } else if (stats.contentFailSamples.length < 10) {
      stats.contentFailSamples.push({
        name,
        chUrl,
        rule: src.ruleContent?.content,
        preview: (content.text || '').slice(0, 80),
      });
    }
  } catch (err) {
    if (stats.tocFailSamples.length < 10) {
      stats.tocFailSamples.push({ name, reason: err.message });
    }
  }
});

console.log('\n=== BENCHMARK SUMMARY ===');
console.log(`Tested: ${sample.length}`);
console.log(`Search OK: ${stats.searchOk} (${((stats.searchOk * 100) / sample.length).toFixed(1)}%) | Empty: ${stats.searchEmpty} | Error: ${stats.searchErr}`);
console.log(`TOC OK:    ${stats.tocOk} (${((stats.tocOk * 100) / sample.length).toFixed(1)}%)`);
console.log(`Content OK (FULL E2E PASS): ${stats.contentOk} (${((stats.contentOk * 100) / sample.length).toFixed(1)}%)`);

const outPath = process.argv[5];
if (outPath) {
  await writeFile(outPath, JSON.stringify(stats.fullPass.map((p) => p.src), null, 2), 'utf8');
  console.log(`Saved ${stats.fullPass.length} full-E2E-verified sources to ${outPath}`);
}

console.log('\n--- Full Pass Examples (first 15) ---');
for (const p of stats.fullPass.slice(0, 15)) {
  console.log(`  [PASS] ${p.name} | search=${p.results} | chapters=${p.chapters} | ch1=${p.ch0Len} chars`);
}

console.log('\n--- Search Fail Samples ---');
for (const f of stats.searchFailSamples.slice(0, 10)) {
  console.log(`  [SEARCH FAIL] ${f.name}: ${f.reason} | searchUrl=${String(f.searchUrl).slice(0, 90)} | bookList=${String(f.bookList || '').slice(0, 60)}`);
}

console.log('\n--- TOC Fail Samples ---');
for (const f of stats.tocFailSamples.slice(0, 8)) {
  console.log(`  [TOC FAIL] ${f.name}: ${f.reason || `tocUrl=${f.tocUrl} rule=${f.chapterList}`}`);
}

console.log('\n--- Content Fail Samples ---');
for (const f of stats.contentFailSamples.slice(0, 8)) {
  console.log(`  [CONTENT FAIL] ${f.name}: chUrl=${f.chUrl} rule=${f.rule} preview=${f.preview}`);
}
