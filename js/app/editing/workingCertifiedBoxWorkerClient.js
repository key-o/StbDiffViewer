/* global Worker */
/**
 * @fileoverview One-job module Worker client for #746 certified box diagnostics.
 * Cancellation terminates the heavy computation, never falls back to main.
 */
let nextRequestId = 0;

function createDiagnosticWorker() {
  if (typeof Worker !== 'function') throw new Error('diagnostic-worker-unavailable');
  return new Worker(new URL('../../workers/workingCertifiedBoxWorker.js', import.meta.url), {
    type: 'module',
  });
}

/**
 * Run the expensive mesh generation, certification and union off the main thread.
 * The caller MUST validate the Working revision again after this Promise resolves.
 */
export function runWorkingCertifiedBoxWorkerJob(
  payload,
  { signal, onProgress = () => {}, createWorker = createDiagnosticWorker } = {},
) {
  if (signal?.aborted) return Promise.reject(new Error('diagnostic-aborted'));
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = createWorker();
      if (!worker || typeof worker.postMessage !== 'function') {
        throw new Error('diagnostic-worker-unavailable');
      }
    } catch (error) {
      reject(error);
      return;
    }
    const requestId = ++nextRequestId;
    let settled = false;
    const complete = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.removeEventListener?.('message', onMessage);
      worker.removeEventListener?.('error', onError);
      worker.removeEventListener?.('messageerror', onError);
      worker.terminate();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => complete(new Error('diagnostic-aborted'));
    const onError = () => complete(new Error('diagnostic-worker-failed'));
    const onMessage = (event) => {
      const message = event?.data;
      if (!message || message.requestId !== requestId) return;
      if (message.type === 'progress') {
        try {
          onProgress(message.progress);
        } catch (_error) {
          // A UI callback must not compromise the quantity audit.
        }
      } else if (message.type === 'result') {
        complete(null, message.result);
      } else if (message.type === 'error') {
        complete(new Error(message.reason || 'diagnostic-worker-failed'));
      }
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      worker.postMessage({ type: 'start', requestId, payload });
    } catch (_error) {
      complete(new Error('diagnostic-worker-input-unavailable'));
    }
  });
}
