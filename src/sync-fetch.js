import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseLegadoUrl, getCookieForUrl, setCookieForUrl } from './http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let worker = null;

function getWorker() {
  if (!worker) {
    worker = new Worker(join(__dirname, 'sync-fetch-worker.js'), { execArgv: [] });
    worker.unref();
    worker.on('exit', () => {
      worker = null;
    });
  }
  return worker;
}

const MAX_BUF = 4 * 1024 * 1024; // 4 MiB max sync response

/**
 * Blocking HTTP for Legado scripts (java.ajax / java.get / java.post ...).
 * The worker thread has its own copy of http.js, so the real (persistent)
 * cookie jar of this thread is used here: the Cookie header is computed
 * before the request and Set-Cookie headers are merged back afterwards.
 */
export function syncFetchLegado(rawUrl, options = {}) {
  const signalBuf = new SharedArrayBuffer(12);
  const ctrl = new Int32Array(signalBuf);
  const dataBuf = new SharedArrayBuffer(MAX_BUF);

  let cookieHeader = '';
  try {
    const parsed = parseLegadoUrl(rawUrl, options.baseUrl || '', options.sourceHeader || '');
    cookieHeader = getCookieForUrl(parsed.url);
  } catch {
    cookieHeader = '';
  }

  const w = getWorker();
  w.postMessage({
    signalBuf,
    dataBuf,
    rawUrl,
    baseUrl: options.baseUrl || '',
    sourceHeader: options.sourceHeader || '',
    timeoutMs: options.timeoutMs || 10_000,
    cookieHeader,
  });

  // Wait up to timeoutMs + 2000ms
  const waitRes = Atomics.wait(ctrl, 0, 0, (options.timeoutMs || 10_000) + 2000);
  if (waitRes === 'timed-out' || ctrl[0] !== 1) {
    return { url: rawUrl, status: 0, headers: {}, body: '', error: 'SYNC_FETCH_TIMEOUT' };
  }

  const len = ctrl[1];
  const isError = ctrl[2] === 1;
  const text = Buffer.from(new Uint8Array(dataBuf, 0, len)).toString('utf8');
  if (isError) {
    return { url: rawUrl, status: 0, headers: {}, body: '', error: text };
  }
  let res;
  try {
    res = JSON.parse(text);
  } catch {
    return { url: rawUrl, status: 0, headers: {}, body: '', error: 'SYNC_FETCH_BAD_RESPONSE' };
  }
  // Merge cookies of every hop (redirects may set cookies on other hosts) into the real jar.
  if (Array.isArray(res?.cookieHops) && res.cookieHops.length > 0) {
    for (const hop of res.cookieHops) {
      if (hop && Array.isArray(hop.setCookies)) setCookieForUrl(hop.url || res.url || rawUrl, hop.setCookies);
    }
  } else if (Array.isArray(res?.setCookies) && res.setCookies.length > 0) {
    setCookieForUrl(res.url || rawUrl, res.setCookies);
  }
  return res;
}
