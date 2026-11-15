/* global WorkerGlobalScope, self */
/** @fileoverview Browser Worker entry for candidate-only AABB broad phase. */

import { findAabbOverlapCandidates } from './AabbOverlapCandidates.js';

export function evaluateAabbWorkerRequest(request) {
  const requestId = request?.requestId;
  if (requestId !== 1) {
    return { requestId, ok: false, error: 'invalid-request' };
  }
  try {
    return {
      requestId,
      ok: true,
      result: findAabbOverlapCandidates(request.members, request.options),
    };
  } catch (_error) {
    return { requestId, ok: false, error: 'invalid-broad-phase-input' };
  }
}

// This module can be imported by Node tests without creating a worker listener.
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.addEventListener('message', (event) => {
    self.postMessage(evaluateAabbWorkerRequest(event.data));
  });
}
