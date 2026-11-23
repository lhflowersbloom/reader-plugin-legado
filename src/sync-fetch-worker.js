import { parentPort } from 'node:worker_threads';
import { fetchLegado } from './http.js';

parentPort.on('message', async (msg) => {
  const { signalBuf, dataBuf, rawUrl, baseUrl, sourceHeader, timeoutMs, cookieHeader } = msg;
  const ctrl = new Int32Array(signalBuf);
  const view = new Uint8Array(dataBuf);

  try {
    const res = await fetchLegado(rawUrl, {
      baseUrl,
      sourceHeader,
      timeoutMs,
      // The main thread owns the real cookie jar; use the header it computed.
      cookieHeader: typeof cookieHeader === 'string' ? cookieHeader : undefined,
    });
    const encoded = Buffer.from(JSON.stringify(res), 'utf8');
    const len = Math.min(encoded.length, view.length);
    view.set(encoded.subarray(0, len), 0);
    ctrl[1] = len;
    ctrl[2] = 0;
  } catch (err) {
    const encoded = Buffer.from(String(err?.message || err), 'utf8');
    const len = Math.min(encoded.length, view.length);
    view.set(encoded.subarray(0, len), 0);
    ctrl[1] = len;
    ctrl[2] = 1;
  } finally {
    Atomics.store(ctrl, 0, 1);
    Atomics.notify(ctrl, 0, 1);
  }
});
