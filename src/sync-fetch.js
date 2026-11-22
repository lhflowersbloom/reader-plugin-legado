import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
let worker = null;

function getWorker() {
  if (!worker) {
    worker = new Worker(join(__dirname, 'sync-fetch-worker.js'));
    worker.unref();
    worker.on('exit', () => {
      worker = null;
    });
  }
  return worker;
}

const MAX_BUF = 4 * 1024 * 1024; // 4 MiB max sync response

export function syncFetchLegado(rawUrl, options = {}) {
  const signalBuf = new SharedArrayBuffer(12);
  const ctrl = new Int32Array(signalBuf);
  const dataBuf = new SharedArrayBuffer(MAX_BUF);

  const w = getWorker();
  w.postMessage({
    signalBuf,
    dataBuf,
    rawUrl,
    baseUrl: options.baseUrl || '',
    sourceHeader: options.sourceHeader || '',
    timeoutMs: options.timeoutMs || 10_000,
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
  try {
    return JSON.parse(text);
  } catch {
    return { url: rawUrl, status: 200, headers: {}, body: text };
  }
}
