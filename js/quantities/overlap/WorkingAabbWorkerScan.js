/* global Worker */
/**
 * @fileoverview Fail-closed async candidate scan for a revision-stamped Working snapshot.
 *
 * Only primitive AABBs are sent to the Worker. The browser main thread never
 * performs the pairwise scan, and a superseded Working revision is rejected.
 */

function defaultWorkerFactory() {
  return new Worker(new URL('./AabbOverlapWorker.js', import.meta.url), { type: 'module' });
}

/**
 * @param {{snapshot:object, options?:object, createWorker?:function,
 * isCurrentRevision:function, signal?:AbortSignal}} args
 * @returns {Promise<object>} Candidate-only result, never a quantity adjustment.
 */
export function scanWorkingAabbsInWorker({
  snapshot,
  options = {},
  createWorker = defaultWorkerFactory,
  isCurrentRevision,
  signal,
} = {}) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.members) ||
    !Array.isArray(snapshot.unresolved) ||
    typeof snapshot.sessionId !== 'string' ||
    !snapshot.sessionId ||
    !Number.isSafeInteger(snapshot.workingRevision) ||
    snapshot.workingRevision < 0 ||
    snapshot.verification !== 'not_verified' ||
    snapshot.quantityEffect !== 'none' ||
    snapshot.buildingCoverageVerified !== false ||
    typeof isCurrentRevision !== 'function' ||
    typeof createWorker !== 'function'
  ) {
    return Promise.reject(
      new TypeError('A valid revision-stamped Working AABB snapshot is required'),
    );
  }
  const { sessionId, workingRevision } = snapshot;
  try {
    if (!isCurrentRevision(sessionId, workingRevision)) {
      return Promise.reject(new Error('working-revision-changed'));
    }
  } catch (_error) {
    return Promise.reject(new Error('working-revision-unavailable'));
  }
  if (signal?.aborted) return Promise.reject(new Error('scan-aborted'));

  return new Promise((resolve, reject) => {
    let worker;
    let settled = false;
    const cleanup = () => {
      worker?.removeEventListener('message', onMessage);
      worker?.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      worker?.terminate();
    };
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => settle(new Error('scan-aborted'));
    const onError = () => settle(new Error('worker-failed'));
    const onMessage = (event) => {
      if (event.data?.requestId !== 1) return;
      try {
        if (!isCurrentRevision(sessionId, workingRevision)) {
          settle(new Error('working-revision-changed'));
          return;
        }
      } catch (_error) {
        settle(new Error('working-revision-unavailable'));
        return;
      }
      if (event.data.ok !== true || !event.data.result) {
        settle(new Error(event.data?.error || 'worker-failed'));
        return;
      }
      const result = event.data.result;
      if (
        !Array.isArray(result.candidates) ||
        result.verification !== 'not_verified' ||
        result.quantityEffect !== 'none' ||
        typeof result.coverageComplete !== 'boolean' ||
        typeof result.truncated !== 'boolean'
      ) {
        settle(new Error('invalid-worker-result'));
        return;
      }
      settle(null, {
        ...result,
        sessionId,
        workingRevision,
        unresolved: snapshot.unresolved,
        extractedMembers: snapshot.members.length,
        // Restrict completeness to the explicit types, not the whole building.
        coverageComplete: snapshot.coverageComplete === true && result.coverageComplete,
        truncated: snapshot.truncated === true || result.truncated,
        buildingCoverageVerified: false,
        verification: 'not_verified',
        quantityEffect: 'none',
      });
    };
    try {
      worker = createWorker();
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      worker.postMessage({ requestId: 1, members: snapshot.members, options });
    } catch (_error) {
      settle(new Error('worker-unavailable'));
    }
  });
}
