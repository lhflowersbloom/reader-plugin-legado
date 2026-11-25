import { parentPort } from 'node:worker_threads';
import { fetchLegado } from './http.js';

parentPort.on('message', async (msg) => {
  const { signalBuf, dataBuf, rawUrl, baseUrl, sourceHeader, timeoutMs, cookieHeader } = msg;
  const ctrl = new Int32Array(signalBuf);
  const view = new Uint8Array(dataBuf);

  const writeOut = (text, isError) => {
    let encoded = Buffer.from(text, 'utf8');
    let error = isError;
    if (encoded.length > view.length) {
      // Never hand back a truncated JSON document: the caller would treat it as page text.
      encoded = Buffer.from(`SYNC_RESPONSE_TOO_LARGE (${encoded.length} bytes)`, 'utf8');
      error = true;
    }
    view.set(encoded, 0);
    ctrl[1] = encoded.length;
    ctrl[2] = error ? 1 : 0;
  };

  try {
    const res = await fetchLegado(rawUrl, {
      baseUrl,
      sourceHeader,
      timeoutMs,
      // Leave room for the JSON envelope (headers, escaping) in the shared buffer.
      maxBytes: Math.max(64 * 1024, view.length - 256 * 1024),
      // The main thread owns the real cookie jar; use the header it computed.
      cookieHeader: typeof cookieHeader === 'string' ? cookieHeader : undefined,
    });
    writeOut(JSON.stringify(res), false);
  } catch (err) {
    const msg = String(err?.message || err);
    // A body over the shared-buffer budget is reported under the sync-specific
    // code, so scripts can tell it apart from an ordinary oversized async page.
    writeOut(msg.replace(/^RESPONSE_TOO_LARGE/, 'SYNC_RESPONSE_TOO_LARGE'), true);
  } finally {
    Atomics.store(ctrl, 0, 1);
    Atomics.notify(ctrl, 0, 1);
  }
});
