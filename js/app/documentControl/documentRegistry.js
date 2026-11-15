/**
 * #485/#488 P0: document-scoped, fail-closed registry. No files or model
 * contents are stored here. Approval is available to the owning UI only.
 */
export class DocumentControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DocumentControlError';
    this.code = code;
  }
}

const reject = (code, message) => {
  throw new DocumentControlError(code, message);
};

function secureId() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    reject('SECURE_RANDOM_UNAVAILABLE', 'Secure session identifiers are unavailable.');
  }
  return globalThis.crypto.randomUUID();
}

const documentKey = ({ slot, kind }) => `${slot}:${kind}`;
const validRevision = (value) => Number.isSafeInteger(value) && value >= 0;

function validateDocument(entry) {
  if (!entry || !['A', 'B'].includes(entry.slot) || entry.source?.nodeType !== 9) {
    reject('INVALID_DOCUMENT', 'Only UI-opened STB documents may be registered.');
  }
  if (entry.kind === 'stb-source') return;
  if (
    entry.kind !== 'stb-working' ||
    entry.slot !== 'A' ||
    !entry.source.documentElement ||
    entry.source.documentElement.nodeType !== 1 ||
    typeof entry.editSessionId !== 'string' ||
    !entry.editSessionId ||
    !validRevision(entry.workingRevision)
  ) {
    reject('INVALID_DOCUMENT', 'Only active, valid Model A Working XML may be registered.');
  }
}

/** A registry instance is private to one browser tab / Tauri window. */
export function createDocumentRegistry({ randomId = secureId } = {}) {
  let sessionId = null;
  let documents = new Map();
  let observed = new Map();
  const listeners = new Set();

  function emit(event, data = {}) {
    const safeEvent = Object.freeze({ event, ...data });
    // A failing observer must not prevent revocation notices to other subscribers.
    for (const listener of [...listeners]) {
      try {
        listener(safeEvent);
      } catch {
        // Authorization state is already updated; keep notifying other observers.
      }
    }
  }

  function disable(reason = 'user_disconnect') {
    if (!sessionId) return;
    sessionId = null;
    documents = new Map();
    observed = new Map();
    emit('access_revoked', { reason });
  }

  function normalize(openDocuments) {
    if (!Array.isArray(openDocuments)) reject('INVALID_ARGUMENT', 'Invalid document list.');
    const next = new Map();
    for (const entry of openDocuments) {
      validateDocument(entry);
      const key = documentKey(entry);
      if (next.has(key)) reject('INVALID_DOCUMENT', 'Duplicate document scope.');
      next.set(key, {
        slot: entry.slot,
        kind: entry.kind,
        source: entry.source, // private identity guard; never serialized
        editSessionId: entry.editSessionId ?? null,
        workingRevision: entry.workingRevision ?? null,
        workingSource: entry.kind === 'stb-source' ? (entry.workingSource ?? null) : null,
        name: typeof entry.name === 'string' ? entry.name.slice(0, 200) : null,
      });
    }
    if (!Array.from(next.values()).some((entry) => entry.kind === 'stb-source')) {
      reject('NO_OPEN_DOCUMENTS', 'No open source document can be authorized.');
    }
    if (next.has('A:stb-working') && !next.has('A:stb-source')) {
      reject('INVALID_DOCUMENT', 'Working Document requires an open Model A source.');
    }
    return next;
  }

  function approve(openDocuments, { includeWorking = false } = {}) {
    if (typeof includeWorking !== 'boolean') {
      reject('INVALID_ARGUMENT', 'Working consent must be explicitly selected.');
    }
    // New approval always invalidates prior session, IDs and capabilities.
    disable('session_replaced');
    const nextObserved = normalize(openDocuments);
    if (includeWorking && !nextObserved.has('A:stb-working')) {
      reject('WORKING_NOT_AVAILABLE', 'No active Working Document is available.');
    }
    const nextDocuments = new Map();
    for (const [key, entry] of nextObserved) {
      if (entry.kind === 'stb-working' && !includeWorking) continue;
      nextDocuments.set(key, {
        ...entry,
        documentId: randomId(),
        revisionId: randomId(),
      });
    }
    sessionId = randomId();
    observed = nextObserved;
    documents = nextDocuments;
    emit('access_granted', { sessionId });
    return snapshot();
  }

  function snapshot() {
    if (!sessionId) reject('NOT_CONNECTED', 'AI integration is disabled.');
    return {
      sessionId,
      capabilities: ['read'],
      documents: Array.from(documents.values(), ({ slot, kind, documentId, revisionId, name }) => ({
        slot,
        kind,
        documentId,
        revisionId,
        name,
      })),
    };
  }

  function assertSession(expectedId) {
    if (!sessionId || expectedId !== sessionId) {
      reject('UNAUTHORIZED_SESSION', 'Session is not authorized.');
    }
  }

  function verifyOpen(currentDocuments) {
    if (!sessionId) reject('NOT_CONNECTED', 'AI integration is disabled.');
    let current;
    try {
      current = normalize(currentDocuments);
    } catch {
      disable('open_document_unavailable');
      reject('DOCUMENT_CHANGED', 'Open-document state is unavailable.');
    }
    // Unapproved Working changes also invalidate Source grants. This avoids
    // silently inheriting a prior session when the editing state changes.
    if (
      current.size !== observed.size ||
      Array.from(observed).some(([key, previous]) => {
        const next = current.get(key);
        return (
          !next ||
          next.source !== previous.source ||
          next.editSessionId !== previous.editSessionId ||
          next.workingRevision !== previous.workingRevision ||
          next.workingSource !== previous.workingSource
        );
      })
    ) {
      disable('document_or_revision_changed');
      reject('DOCUMENT_CHANGED', 'Open documents changed. A new approval is required.');
    }
  }

  function authorize({ sessionId: requestedSession, documentId, revisionId }) {
    assertSession(requestedSession);
    const entry = Array.from(documents.values()).find((d) => d.documentId === documentId);
    if (!entry) reject('DOCUMENT_NOT_AUTHORIZED', 'Document is not authorized.');
    if (entry.revisionId !== revisionId) {
      reject('REVISION_MISMATCH', 'The document revision is no longer authorized.');
    }
    return entry;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') reject('INVALID_ARGUMENT', 'Listener must be a function.');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { approve, disable, snapshot, verifyOpen, assertSession, authorize, subscribe };
}
