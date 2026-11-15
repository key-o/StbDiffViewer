/**
 * #500: transport-independent, fail-closed read boundary for a future Tauri IPC adapter.
 *
 * This module opens NO communication channel. `authorizeFromTrustedUi` must be called
 * only by the GUI after a separate, trusted, client-specific external-sharing click.
 * Never expose this object to an MCP tool, web page global, or generic Tauri invoke.
 * Native code must authenticate the IPC peer and supply the context independently
 * of client-controlled MCP parameters.
 */
const READ_TOOLS = new Set([
  'get_session_info',
  'list_open_documents',
  'get_selection',
  'get_drawing_state',
  'find_elements',
  'get_element_details',
  'compare_open_models',
]);
const REVOKE_ON = new Set([
  'NOT_CONNECTED',
  'UNAUTHORIZED_SESSION',
  'DOCUMENT_CHANGED',
  'DOCUMENT_NOT_AUTHORIZED',
  'REVISION_MISMATCH',
]);
const READ_FIELDS = Object.freeze({
  get_session_info: [],
  list_open_documents: [],
  get_selection: ['documentId', 'revisionId'],
  get_drawing_state: ['documentId', 'revisionId'],
  find_elements: ['documentId', 'revisionId', 'elementType', 'name', 'limit'],
  get_element_details: ['documentId', 'revisionId', 'elementType', 'elementId'],
  compare_open_models: ['documentA', 'revisionA', 'documentB', 'revisionB'],
});
const MAX_REPLY_BYTES = 32768;
const MAX_LEASE_MS = 60000;

export class TauriMcpReadGateError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TauriMcpReadGateError';
    this.code = code;
  }
}

const deny = (code) => {
  throw new TauriMcpReadGateError(code);
};
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const documentSignature = (documents) =>
  JSON.stringify(
    documents.map(({ documentId, revisionId, kind, slot }) => [documentId, revisionId, kind, slot]),
  );

/**
 * @param {Object} options
 * @param {Object} options.controlApi - Existing UI-owned Document Control API.
 * @param {string} options.windowId - Native-assigned GUI window identity.
 * @param {Function} [options.clock] - Monotonic clock, for deterministic tests.
 */
export function createTauriMcpReadGate({
  controlApi,
  windowId,
  clock = () => globalThis.performance.now(),
} = {}) {
  if (
    !validId(windowId) ||
    typeof controlApi?.handleReadRequest !== 'function' ||
    typeof controlApi?.subscribeLocalEvents !== 'function' ||
    typeof clock !== 'function'
  ) {
    deny('INVALID_SETUP');
  }
  let lease = null;
  let disposed = false;
  const unsubscribe = controlApi.subscribeLocalEvents(({ event }) => {
    if (event === 'access_revoked') lease = null;
  });

  function currentSnapshot() {
    const snapshot = controlApi.handleReadRequest('get_session_info', {
      sessionId: lease.sessionId,
    });
    if (!isRecord(snapshot) || !Array.isArray(snapshot.documents)) deny('STALE_SESSION');
    if (documentSignature(snapshot.documents) !== lease.documentSignature) {
      lease = null;
      deny('STALE_DOCUMENTS');
    }
    return snapshot;
  }

  return Object.freeze({
    /** GUI-only: never callable from MCP / IPC request input. */
    authorizeFromTrustedUi({ clientId, connectionId, sessionId, approvedWindowId }) {
      lease = null;
      if (disposed) deny('GATE_DISPOSED');
      if (
        ![clientId, connectionId, sessionId, approvedWindowId].every(validId) ||
        approvedWindowId !== windowId
      ) {
        deny('INVALID_APPROVAL');
      }
      // The UI must have separately consented to disclosure to THIS client.
      const snapshot = controlApi.handleReadRequest('get_session_info', { sessionId });
      if (!isRecord(snapshot) || !Array.isArray(snapshot.documents) || !snapshot.documents.length) {
        deny('NO_AUTHORIZED_DOCUMENTS');
      }
      lease = {
        clientId,
        connectionId,
        sessionId,
        expiresAt: clock() + MAX_LEASE_MS,
        documentSignature: documentSignature(snapshot.documents),
      };
      return Object.freeze({ connected: true, documentCount: snapshot.documents.length });
    },
    /** Trusted Rust IPC adapter only. Context is authenticated native metadata, NOT MCP arguments. */
    handleRequestFromAuthenticatedIpc(context, request) {
      if (disposed || !lease) deny('NOT_APPROVED');
      if (
        !isRecord(context) ||
        context.windowId !== windowId ||
        context.clientId !== lease.clientId ||
        context.connectionId !== lease.connectionId
      ) {
        deny('WRONG_CONNECTION');
      }
      if (!(clock() < lease.expiresAt)) {
        lease = null;
        deny('APPROVAL_EXPIRED');
      }
      if (
        !isRecord(request) ||
        Object.keys(request).some((key) => key !== 'tool' && key !== 'arguments') ||
        !READ_TOOLS.has(request.tool)
      ) {
        deny('FORBIDDEN_TOOL');
      }
      const args = request.arguments ?? {};
      if (
        !isRecord(args) ||
        Object.keys(args).some((key) => !READ_FIELDS[request.tool].includes(key))
      ) {
        deny('INVALID_ARGUMENTS');
      }
      try {
        currentSnapshot();
        const result = controlApi.handleReadRequest(request.tool, {
          ...args,
          sessionId: lease.sessionId,
        });
        // The internal token must never be returned to an external client.
        const safe =
          request.tool === 'get_session_info'
            ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'sessionId'))
            : result;
        const serialized = JSON.stringify(safe);
        if (!serialized || new TextEncoder().encode(serialized).length > MAX_REPLY_BYTES)
          deny('RESPONSE_TOO_LARGE');
        // Check again at the disclosure boundary even if future handlers become async.
        currentSnapshot();
        if (!(clock() < lease.expiresAt)) {
          lease = null;
          deny('APPROVAL_EXPIRED');
        }
        return JSON.parse(serialized);
      } catch (error) {
        if (REVOKE_ON.has(error?.code)) lease = null;
        // Suppress internal error messages, which may contain private document details.
        if (error instanceof TauriMcpReadGateError) throw error;
        deny(REVOKE_ON.has(error?.code) ? 'STALE_SESSION' : 'READ_DENIED');
      }
    },
    /** UI/native lifetime owner only; not part of the read-tool allowlist. */
    revokeFromTrustedUi() {
      lease = null;
    },
    dispose() {
      if (disposed) return;
      lease = null;
      disposed = true;
      unsubscribe();
    },
  });
}
