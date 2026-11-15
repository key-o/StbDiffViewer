/**
 * #500 / Stage B: transport-independent connection-specific external-sharing policy.
 *
 * This policy is owned by the Tauri GUI, NOT exposed to MCP tools or window globals.
 * Only a Native-authenticated transport may create a connection or supply its
 * `nativeConnectionId` to authorizeRead. Never trust a client-supplied JSON ID.
 * It intentionally opens no socket and grants no OS identity by itself.
 */
const DEFAULTS = Object.freeze({ pendingMs: 15000, leaseMs: 60000, maxPending: 8 });
const VALID_ID = /^[\w:-]{1,128}$/;
const validSignature = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 16384;

export class TauriMcpPairingError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TauriMcpPairingError';
    this.code = code;
  }
}
const deny = (code) => {
  throw new TauriMcpPairingError(code);
};
const validId = (value) => typeof value === 'string' && VALID_ID.test(value);
const safeClientLabel = (name) =>
  typeof name === 'string'
    ? name
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .trim()
        .slice(0, 80) || '名称未確認'
    : '名称未確認';

/** Native-origin connection context is an unforgeable handle identity, not an MCP argument. */
export function createTauriMcpConnectionPairing({
  windowId,
  clock = () => globalThis.performance.now(),
  pendingMs = DEFAULTS.pendingMs,
  leaseMs = DEFAULTS.leaseMs,
  maxPending = DEFAULTS.maxPending,
} = {}) {
  if (
    !validId(windowId) ||
    typeof clock !== 'function' ||
    !Number.isSafeInteger(pendingMs) ||
    pendingMs < 1 ||
    pendingMs > 60000 ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 1 ||
    leaseMs > 60000 ||
    !Number.isSafeInteger(maxPending) ||
    maxPending < 1 ||
    maxPending > 16
  )
    deny('INVALID_SETUP');

  const connections = new Map();
  // Native IDs are required to be unique for the entire lifetime of the registry.
  const seenIds = new Set();
  let disposed = false;
  const mustLive = () => {
    if (disposed) deny('PAIRING_DISPOSED');
  };
  const reap = () => {
    const now = clock();
    for (const [id, record] of connections) {
      if (!(now < record.expiresAt)) connections.delete(id);
    }
  };
  const lookup = (nativeConnectionId) => {
    mustLive();
    reap();
    if (!validId(nativeConnectionId)) deny('INVALID_CONNECTION');
    const record = connections.get(nativeConnectionId);
    if (!record) deny('CONNECTION_REVOKED');
    return record;
  };
  const checkRead = (native, documentSignature) => {
    if (!native || typeof native !== 'object' || Array.isArray(native)) deny('INVALID_CONNECTION');
    const record = lookup(native.nativeConnectionId);
    if (record.windowId !== native.windowId || native.windowId !== windowId) deny('WRONG_WINDOW');
    if (record.peerIdentity !== native.peerIdentity) deny('WRONG_PEER');
    if (record.state !== 'approved') deny('NOT_APPROVED');
    if (documentSignature !== record.documentSignature) {
      connections.delete(native.nativeConnectionId);
      deny('STALE_DOCUMENTS');
    }
    return record;
  };
  return Object.freeze({
    /** Called from the trusted Native accept event; never from MCP request JSON. */
    registerFromNative({
      nativeConnectionId,
      peerIdentity,
      reportedClientName,
      windowId: peerWindow,
    }) {
      mustLive();
      reap();
      if (!validId(nativeConnectionId) || !validId(peerIdentity) || peerWindow !== windowId)
        deny('INVALID_CONNECTION');
      if (seenIds.has(nativeConnectionId)) deny('DUPLICATE_CONNECTION');
      if (seenIds.size >= 4096) deny('PAIRING_RESTART_REQUIRED');
      if (connections.size >= maxPending) deny('TOO_MANY_CONNECTIONS');
      const record = {
        windowId,
        nativeConnectionId,
        peerIdentity,
        reportedClientName: safeClientLabel(reportedClientName),
        state: 'pending',
        expiresAt: clock() + pendingMs,
        documentSignature: null,
        sessionId: null,
      };
      connections.set(nativeConnectionId, record);
      seenIds.add(nativeConnectionId);
      return Object.freeze({
        nativeConnectionId,
        windowId,
        clientLabel: record.reportedClientName,
        clientIdentityVerified: false,
        expiresAt: record.expiresAt,
      });
    },
    /** Must be invoked exclusively by a trusted GUI click, never by MCP/IPC payload. */
    approveFromTrustedUi({ nativeConnectionId, sessionId, documentSignature }) {
      const record = lookup(nativeConnectionId);
      if (record.state !== 'pending') deny('APPROVAL_NOT_PENDING');
      if (!validId(sessionId) || !validSignature(documentSignature)) deny('INVALID_APPROVAL');
      record.state = 'approved';
      record.expiresAt = clock() + leaseMs;
      record.documentSignature = documentSignature;
      record.sessionId = sessionId;
      return Object.freeze({ approved: true, expiresAt: record.expiresAt });
    },
    /** The caller must supply a fresh Document Control signature at both boundaries. */
    async authorizeReadFromNative(native, { getDocumentSignature, read }) {
      mustLive();
      if (typeof getDocumentSignature !== 'function' || typeof read !== 'function')
        deny('INVALID_READ_HANDLER');
      let signature;
      try {
        signature = getDocumentSignature();
      } catch (error) {
        if (validId(native?.nativeConnectionId)) connections.delete(native.nativeConnectionId);
        throw error;
      }
      const record = checkRead(native, signature);
      const expectedSession = record.sessionId;
      try {
        const result = await read(expectedSession);
        // The Native connection or revision may be revoked during an async read.
        const after = checkRead(native, getDocumentSignature());
        if (after !== record || after.sessionId !== expectedSession) deny('CONNECTION_REVOKED');
        return result;
      } catch (error) {
        // A failed private lookup must not leave the connection reusable.
        connections.delete(native.nativeConnectionId);
        throw error;
      }
    },
    /** Native disconnect, GUI stop, editing/reload, exit or failed reply. */
    revokeConnectionFromNative(nativeConnectionId) {
      mustLive();
      connections.delete(nativeConnectionId);
    },
    revokeAllFromTrustedUi() {
      mustLive();
      connections.clear();
    },
    /** GUI presentation has no access to private session IDs or peer tokens. */
    listPendingForUi() {
      mustLive();
      reap();
      return [...connections.values()]
        .filter((record) => record.state === 'pending')
        .map(({ nativeConnectionId, reportedClientName, expiresAt }) =>
          Object.freeze({
            nativeConnectionId,
            clientLabel: reportedClientName,
            clientIdentityVerified: false,
            expiresAt,
          }),
        );
    },
    dispose() {
      connections.clear();
      seenIds.clear();
      disposed = true;
    },
  });
}
