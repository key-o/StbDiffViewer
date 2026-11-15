/** #489 Metadata-only explicit DrawingProject lifetime; snapshots never call open(). */
function secureRevision() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Secure drawing revision identifiers are unavailable.');
  }
  return globalThis.crypto.randomUUID();
}

function boundedCount(value) {
  return Array.isArray(value) ? Math.min(value.length, 1_000_000) : 0;
}

/** Only these fields may cross the drawing / Document Control boundary. */
export function drawingProjectSafeDescriptor({ project, document, runtime, revisionId }) {
  if (
    typeof project?.projectId !== 'string' ||
    !project.projectId ||
    typeof document?.id !== 'string' ||
    !document.id ||
    typeof document.modelSlotId !== 'string' ||
    !document.modelSlotId ||
    typeof document.sourceRevisionId !== 'string' ||
    !document.sourceRevisionId ||
    typeof revisionId !== 'string' ||
    !revisionId
  ) {
    return null;
  }
  const scaleDenominator = Number(runtime?.scaleDenominator);
  const rotationDeg = Number(runtime?.rotationDeg);
  const orientation = runtime?.tagOrientationMode;
  return Object.freeze({
    kind: 'drawing-project',
    projectId: String(project.projectId),
    drawingDocumentId: String(document.id),
    modelSlotId: String(document.modelSlotId),
    sourceRevisionId: String(document.sourceRevisionId),
    drawingRevisionId: revisionId,
    state: Object.freeze({
      memberReviewCount: boundedCount(runtime?.memberReviews),
      drawingMemoCount: boundedCount(runtime?.drawingMemos),
      tagPlacementCount: boundedCount(runtime?.tagPlacements),
      scaleDenominator:
        Number.isFinite(scaleDenominator) && scaleDenominator > 0 ? scaleDenominator : null,
      drawingRotationDeg: Number.isFinite(rotationDeg) ? rotationDeg : null,
      tagOrientationMode:
        typeof orientation === 'string' &&
        ['follow-drawing', 'follow-member', 'keep-screen-down'].includes(orientation)
          ? orientation
          : null,
    }),
  });
}

export function createDrawingProjectLifecycle({ randomRevision = secureRevision } = {}) {
  let open = null;
  const listeners = new Set();
  const emit = (event) => {
    const notification = Object.freeze({ event });
    // A faulty optional observer cannot block remaining security revocation
    // observers. Never let UI listener errors roll back lifecycle transitions.
    for (const listener of [...listeners]) {
      try {
        listener(notification);
      } catch {
        // Keep notifying the remaining observers.
      }
    }
  };
  return Object.freeze({
    open({ project, document, runtime }) {
      const revisionId = randomRevision();
      const descriptor = drawingProjectSafeDescriptor({ project, document, runtime, revisionId });
      if (!descriptor) throw new Error('DrawingProject is not ready to open.');
      open = descriptor;
      emit('drawing_opened');
      return descriptor;
    },
    revise({ project, document, runtime }) {
      if (!open) return null;
      const descriptor = drawingProjectSafeDescriptor({
        project,
        document,
        runtime,
        revisionId: randomRevision(),
      });
      if (
        !descriptor ||
        descriptor.projectId !== open.projectId ||
        descriptor.drawingDocumentId !== open.drawingDocumentId ||
        descriptor.modelSlotId !== open.modelSlotId ||
        descriptor.sourceRevisionId !== open.sourceRevisionId
      ) {
        open = null;
        emit('drawing_closed');
        return null;
      }
      open = descriptor;
      emit('drawing_revision_changed');
      return descriptor;
    },
    /**
     * Publish a different STB source revision after the combined model/drawing
     * transaction has committed. Unlike revise(), a source-revision change is
     * intentional here. Preserve the registered drawing identity, but issue a
     * new Document Control revision so every existing grant is revoked.
     *
     * Invalid or cross-document requests leave the previous descriptor intact.
     * This is NOT a pre-commit operation or a substitute for model/source checks.
     */
    rebindSourceRevision({ project, document, runtime }) {
      if (!open) throw new Error('No open DrawingProject can be rebound.');
      const descriptor = drawingProjectSafeDescriptor({
        project,
        document,
        runtime,
        revisionId: randomRevision(),
      });
      if (
        !descriptor ||
        descriptor.projectId !== open.projectId ||
        descriptor.drawingDocumentId !== open.drawingDocumentId ||
        descriptor.modelSlotId !== open.modelSlotId ||
        descriptor.sourceRevisionId === open.sourceRevisionId ||
        descriptor.drawingRevisionId === open.drawingRevisionId
      ) {
        throw new Error('The DrawingProject source rebind identity is inconsistent.');
      }
      open = descriptor;
      emit('drawing_revision_rebound');
      return descriptor;
    },
    close() {
      if (!open) return;
      open = null;
      emit('drawing_closed');
    },
    getOpenDrawingProjectDescriptor() {
      return open;
    },
    subscribeDrawingProjectLifecycle(listener) {
      if (typeof listener !== 'function') throw new TypeError('Listener must be a function.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
