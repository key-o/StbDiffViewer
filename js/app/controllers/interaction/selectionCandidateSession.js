/**
 * Tab キーで巡回する選択候補と、そのプレビューのライフサイクルを管理する。
 * ブラウザ API と描画処理は依存注入し、controller には依存しない。
 */

const SELECTION_CANDIDATE_DEFAULTS = Object.freeze({
  candidateLimit: 3,
  keyDebounceMs: 16,
  frameThrottleMs: 16,
  queueMax: 12,
  messageCooldownMs: 120,
  messageIdleDelayMs: 180,
});

export function getNextSelectionCandidateIndex(currentIndex, candidateCount, options = {}) {
  const { reverse = false } = options;
  if (!Number.isFinite(candidateCount) || candidateCount <= 0) return -1;
  if (candidateCount === 1) return 0;

  const normalizedIndex = Number.isFinite(currentIndex)
    ? ((Math.trunc(currentIndex) % candidateCount) + candidateCount) % candidateCount
    : 0;
  return reverse
    ? (normalizedIndex - 1 + candidateCount) % candidateCount
    : (normalizedIndex + 1) % candidateCount;
}

function isEditableTarget(target) {
  const tagName = String(target?.tagName || '').toUpperCase();
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    target?.isContentEditable === true
  );
}

function defaultMessageKey(candidate, index) {
  const data = candidate?.userData || {};
  return `${index}|${data.elementIdA || data.elementId || data.id || '-'}|${
    data.elementIdB || data.elementId || data.id || '-'
  }|${data.elementType || data.stbNodeType || 'Unknown'}`;
}

/**
 * @param {Object} dependencies
 * @returns {Object} stateful selection candidate session
 */
export function createSelectionCandidateSession(dependencies = {}) {
  const config = { ...SELECTION_CANDIDATE_DEFAULTS, ...(dependencies.config || {}) };
  const now = dependencies.now || (() => globalThis.performance.now());
  const setTimer =
    dependencies.setTimer || ((callback, delay) => globalThis.setTimeout(callback, delay));
  const clearTimer = dependencies.clearTimer || ((id) => globalThis.clearTimeout(id));
  const requestFrame =
    dependencies.requestFrame || globalThis.requestAnimationFrame?.bind(globalThis) || null;
  const cancelFrame =
    dependencies.cancelFrame || globalThis.cancelAnimationFrame?.bind(globalThis) || null;
  const collectCandidates = dependencies.collectCandidates || ((intersects) => intersects || []);
  const raycast = dependencies.raycast || (() => []);
  const applyPreview = dependencies.applyPreview || (() => false);
  const restorePreview =
    dependencies.restorePreview ||
    ((object, material) => {
      object.material = material;
    });
  const render = dependencies.render || (() => {});
  const showCandidate = dependencies.showCandidate || (() => {});
  const formatCandidateMessage = dependencies.formatCandidateMessage || (() => '');
  const getMessageKey = dependencies.getMessageKey || defaultMessageKey;
  const onPreviewRestoreError = dependencies.onPreviewRestoreError || (() => {});
  const editableTarget = dependencies.isEditableTarget || isEditableTarget;

  let candidates = [];
  let candidateIndex = 0;
  const pointer = { clientX: 0, clientY: 0, hasValue: false, isInsideCanvas: false };
  let previewObject = null;
  let previewMaterial = null;
  let lastTabCycleAt = 0;
  let lastMessageKey = '';
  let lastMessageAt = 0;
  let announcementTimerId = null;
  let pendingDirectionDelta = 0;
  let cycleFrameId = null;
  let cycleScheduled = false;
  let cycleUsesRaf = false;
  let cycleRunning = false;

  function clearAnnouncement() {
    if (announcementTimerId === null) return;
    clearTimer(announcementTimerId);
    announcementTimerId = null;
  }

  function clearCandidates() {
    clearAnnouncement();
    candidates = [];
    candidateIndex = 0;
    lastMessageKey = '';
    lastMessageAt = 0;
  }

  function clearPreview() {
    if (!previewObject) return false;
    if (previewMaterial) {
      try {
        restorePreview(previewObject, previewMaterial);
      } catch (error) {
        onPreviewRestoreError(error);
      }
    }
    previewObject = null;
    previewMaterial = null;
    return true;
  }

  function cancelQueuedCycle() {
    clearAnnouncement();
    if (cycleFrameId !== null) {
      if (cycleUsesRaf && cancelFrame) cancelFrame(cycleFrameId);
      else clearTimer(cycleFrameId);
      cycleFrameId = null;
    }
    pendingDirectionDelta = 0;
    cycleScheduled = false;
    cycleUsesRaf = false;
    cycleRunning = false;
  }

  function clear() {
    clearCandidates();
    cancelQueuedCycle();
    if (clearPreview()) render();
  }

  function updatePointer(event, isInsideCanvas = true) {
    if (!event || typeof event.clientX !== 'number' || typeof event.clientY !== 'number') {
      return false;
    }
    const didMove =
      !pointer.hasValue ||
      pointer.clientX !== event.clientX ||
      pointer.clientY !== event.clientY ||
      pointer.isInsideCanvas !== isInsideCanvas;
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    pointer.hasValue = true;
    pointer.isInsideCanvas = isInsideCanvas;
    return didMove;
  }

  function setPointerInsideCanvas(isInsideCanvas) {
    pointer.isInsideCanvas = Boolean(isInsideCanvas);
  }

  function refresh(intersects = null, event = null) {
    const didPointerMove = event ? updatePointer(event) : false;
    if (!pointer.isInsideCanvas || !pointer.hasValue) {
      clearCandidates();
      return [];
    }

    const currentCandidate = candidates[candidateIndex] || null;
    const currentIntersects = intersects || raycast({ ...pointer }) || [];
    const nextCandidates = collectCandidates(currentIntersects, { includeAxisStory: true }).slice(
      0,
      config.candidateLimit,
    );
    candidates = nextCandidates;
    if (candidates.length === 0) {
      candidateIndex = 0;
    } else if (didPointerMove) {
      candidateIndex = 0;
      lastMessageKey = '';
    } else {
      const preservedIndex = currentCandidate ? candidates.indexOf(currentCandidate) : -1;
      candidateIndex = preservedIndex >= 0 ? preservedIndex : 0;
    }
    return [...candidates];
  }

  function syncPreview() {
    const candidate = candidates[candidateIndex] || null;
    if (previewObject === candidate) return false;

    const didClear = clearPreview();
    let didApply = false;
    const candidateType = candidate?.userData?.elementType;
    if (candidate && candidateType !== 'Axis' && candidateType !== 'Story') {
      previewObject = candidate;
      previewMaterial = candidate.material;
      didApply = Boolean(applyPreview(candidate));
      if (!didApply) {
        previewObject = null;
        previewMaterial = null;
      }
    }
    if (didClear || didApply) render();
    return didClear || didApply;
  }

  function announce() {
    const candidate = candidates[candidateIndex];
    if (!candidate) return false;
    const currentTime = now();
    if (currentTime - lastMessageAt < config.messageCooldownMs) return false;
    const messageKey = getMessageKey(candidate, candidateIndex);
    if (messageKey === lastMessageKey) return false;
    lastMessageKey = messageKey;
    lastMessageAt = currentTime;
    showCandidate({
      candidate,
      index: candidateIndex,
      count: candidates.length,
      message: formatCandidateMessage(candidate, candidateIndex, candidates.length),
    });
    return true;
  }

  function scheduleAnnouncement() {
    clearAnnouncement();
    announcementTimerId = setTimer(() => {
      announcementTimerId = null;
      announce();
    }, config.messageIdleDelayMs);
  }

  function cycle(options = {}) {
    if (candidates.length <= 1) return false;
    const nextIndex = getNextSelectionCandidateIndex(candidateIndex, candidates.length, options);
    candidateIndex = nextIndex < 0 || nextIndex >= candidates.length ? 0 : nextIndex;
    syncPreview();
    announce();
    return true;
  }

  function executeQueuedCycle() {
    cycleFrameId = null;
    cycleScheduled = false;
    cycleUsesRaf = false;
    if (cycleRunning) return;

    cycleRunning = true;
    try {
      if (pendingDirectionDelta === 0) return;
      if (pointer.isInsideCanvas && candidates.length > 1) {
        const queuedDelta = pendingDirectionDelta;
        pendingDirectionDelta = 0;
        const normalizedDelta = queuedDelta % candidates.length;
        if (normalizedDelta === 0) return;
        const nextIndex =
          (((candidateIndex + normalizedDelta) % candidates.length) + candidates.length) %
          candidates.length;
        if (nextIndex !== candidateIndex) {
          candidateIndex = nextIndex;
          syncPreview();
          scheduleAnnouncement();
        }
        if (pendingDirectionDelta !== 0) scheduleCycleFrame();
      } else {
        pendingDirectionDelta = 0;
        lastMessageKey = '';
      }
    } finally {
      cycleRunning = false;
    }
  }

  function scheduleCycleFrame() {
    if (cycleScheduled) return;
    cycleScheduled = true;
    if (requestFrame) {
      cycleUsesRaf = true;
      cycleFrameId = requestFrame(executeQueuedCycle);
    } else {
      cycleUsesRaf = false;
      cycleFrameId = setTimer(executeQueuedCycle, config.frameThrottleMs);
    }
  }

  function requestCycle(reverse = false) {
    const step = reverse === true ? -1 : 1;
    pendingDirectionDelta = Math.max(
      -config.queueMax,
      Math.min(config.queueMax, pendingDirectionDelta + step),
    );
    scheduleCycleFrame();
  }

  function handleKeyDown(event) {
    if (editableTarget(event?.target)) return false;
    if (event?.key === 'Tab') {
      const currentTime = now();
      event.preventDefault?.();
      event.stopPropagation?.();
      if (currentTime - lastTabCycleAt < config.keyDebounceMs) return true;
      if (candidates.length === 0) lastMessageKey = '';
      lastTabCycleAt = currentTime;
      requestCycle(event.shiftKey);
      return true;
    }
    if (event?.key === 'Escape' && candidates.length > 0) {
      clear();
      return true;
    }
    return false;
  }

  function getState() {
    return {
      candidates: [...candidates],
      candidateIndex,
      currentCandidate: candidates[candidateIndex] || null,
      pointer: { ...pointer },
      previewObject,
      pendingDirectionDelta,
      cycleScheduled,
    };
  }

  return {
    announce,
    cancelQueuedCycle,
    clear,
    clearCandidates,
    clearPreview,
    cycle,
    getState,
    handleKeyDown,
    refresh,
    requestCycle,
    scheduleAnnouncement,
    setPointerInsideCanvas,
    syncPreview,
    updatePointer,
  };
}
