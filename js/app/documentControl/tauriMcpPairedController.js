/**
 * #500 Stage B1: policy-to-Document-Control adapter for a FUTURE authenticated
 * Native IPC transport. No socket, Tauri command, or GUI is started here.
 *
 * NativeAdapter MUST be a Rust-owned, OS-authenticated pipe implementation.
 * Its methods must resolve IDs against handles held in Rust state, not merely
 * echo untrusted JSON or Tauri event data. Linux tests inject a stand-in.
 */
import { createTauriMcpConnectionPairing } from './tauriMcpConnectionPairing.js';

const APPROVED_TRANSPORTS = new Set(['windows-named-pipe', 'linux-unix-peercred']);
const MAX_PENDING_REQUEST_ID = Number.MAX_SAFE_INTEGER;

const clean = () => 'READ_DENIED';
const currentSignature = (controlApi, sessionId) => {
  const snapshot = controlApi.handleReadRequest('get_session_info', { sessionId });
  if (!snapshot || !Array.isArray(snapshot.documents) || snapshot.documents.length === 0)
    throw Error('STALE_SESSION');
  // Include the private session ID ONLY in the local signature; never return it.
  return JSON.stringify([sessionId, snapshot.documents]);
};

export function createTauriMcpPairedController({
  controlApi,
  getLocalGrant,
  nativeAdapter,
  windowId = 'main',
  clock,
  readGateFactory,
} = {}) {
  if (
    typeof controlApi?.handleReadRequest !== 'function' ||
    typeof controlApi?.subscribeLocalEvents !== 'function' ||
    typeof getLocalGrant !== 'function' ||
    typeof readGateFactory !== 'function' ||
    !nativeAdapter ||
    !['capabilities', 'getPending', 'approve', 'reject', 'getRead', 'reply', 'stop'].every(
      (name) => typeof nativeAdapter[name] === 'function',
    )
  )
    throw Error('INVALID_SETUP');

  const pairing = createTauriMcpConnectionPairing({ windowId, clock });
  const gates = new Map();
  let stopped = false;
  let failedShutdown = false;
  let stopPromise = null;
  let epoch = 0;
  let disposed = false;
  let initialized = false;
  const notRunning = () => disposed || stopped || failedShutdown;
  const revokeLocal = (id) => {
    const gate = gates.get(id);
    gates.delete(id);
    gate?.dispose();
    if (!disposed) pairing.revokeConnectionFromNative(id);
  };
  const revokeAllLocal = () => {
    epoch += 1;
    for (const gate of gates.values()) gate.dispose();
    gates.clear();
    if (!disposed) pairing.revokeAllFromTrustedUi();
  };
  const stop = async () => {
    stopped = true;
    revokeAllLocal();
    if (stopPromise) return stopPromise;
    stopPromise = Promise.resolve()
      .then(() => nativeAdapter.stop())
      .catch(() => {
        failedShutdown = true;
        throw Error('NATIVE_SHUTDOWN_FAILED');
      });
    return stopPromise;
  };
  const unsubscribe = controlApi.subscribeLocalEvents(({ event }) => {
    if (event === 'access_revoked' && initialized && !notRunning()) void stop().catch(() => {});
  });

  return Object.freeze({
    async initialize() {
      if (disposed || stopped || initialized) throw Error('NOT_AVAILABLE');
      const capabilities = await nativeAdapter.capabilities();
      // The actual Native command must enforce this identity; untrusted JS
      // cannot establish OS credentials by simply returning this label.
      if (
        !capabilities ||
        capabilities.nativeIdentityVerified !== true ||
        !APPROVED_TRANSPORTS.has(capabilities.transport) ||
        capabilities.windowId !== windowId
      ) {
        await stop();
        throw Error('NATIVE_IDENTITY_UNAVAILABLE');
      }
      initialized = true;
      return Object.freeze({ transport: capabilities.transport, windowId });
    },
    async onNativePending(id) {
      if (!initialized || notRunning()) throw Error('NOT_AVAILABLE');
      const generation = epoch;
      // `id` is only a notification cursor. Rust resolves the actual pipe handle.
      const native = await nativeAdapter.getPending(id);
      if (generation !== epoch || notRunning()) throw Error('CONNECTION_REVOKED');
      return pairing.registerFromNative(native);
    },
    listPendingForUi() {
      return notRunning() ? [] : pairing.listPendingForUi();
    },
    async approveFromTrustedUi({ nativeConnectionId, event }) {
      if (event?.isTrusted !== true || !initialized || notRunning())
        throw Error('TRUSTED_CLICK_REQUIRED');
      const grant = getLocalGrant();
      if (!grant?.sessionId) throw Error('LOCAL_CONSENT_REQUIRED');
      const generation = epoch;
      const signature = currentSignature(controlApi, grant.sessionId);
      const pending = pairing
        .listPendingForUi()
        .some((p) => p.nativeConnectionId === nativeConnectionId);
      if (!pending) throw Error('CONNECTION_REVOKED');
      const gate = readGateFactory({ controlApi, windowId, clock });
      try {
        // A per-pipe read gate is necessary: the older Stage-A gate allows
        // one connection per instance. Never reuse it between clients.
        const native = await nativeAdapter.getPending(nativeConnectionId);
        if (native.nativeConnectionId !== nativeConnectionId || native.windowId !== windowId)
          throw Error('WRONG_CONNECTION');
        if (
          generation !== epoch ||
          notRunning() ||
          getLocalGrant()?.sessionId !== grant.sessionId ||
          currentSignature(controlApi, grant.sessionId) !== signature
        )
          throw Error('CONNECTION_REVOKED');
        gate.authorizeFromTrustedUi({
          approvedWindowId: windowId,
          clientId: native.peerIdentity,
          connectionId: nativeConnectionId,
          sessionId: grant.sessionId,
        });
        pairing.approveFromTrustedUi({
          nativeConnectionId,
          sessionId: grant.sessionId,
          documentSignature: signature,
        });
        gates.set(nativeConnectionId, gate);
        // Native MUST make the exact handle eligible, not every socket for the SID.
        await nativeAdapter.approve(nativeConnectionId);
        if (
          generation !== epoch ||
          notRunning() ||
          getLocalGrant()?.sessionId !== grant.sessionId ||
          currentSignature(controlApi, grant.sessionId) !== signature
        )
          throw Error('CONNECTION_REVOKED');
        return { approved: true };
      } catch {
        revokeLocal(nativeConnectionId);
        await nativeAdapter.reject(nativeConnectionId).catch(() => stop().catch(() => {}));
        throw Error('APPROVAL_DENIED');
      } finally {
        // Avoid leaking an orphan gate after Native pending lookup fails.
        if (gates.get(nativeConnectionId) !== gate) gate.dispose();
      }
    },
    async rejectFromTrustedUi({ nativeConnectionId, event }) {
      if (event?.isTrusted !== true || !initialized || notRunning())
        throw Error('TRUSTED_CLICK_REQUIRED');
      revokeLocal(nativeConnectionId);
      try {
        await nativeAdapter.reject(nativeConnectionId);
      } catch {
        await stop();
      }
    },
    async onNativeRead(requestId) {
      if (!Number.isSafeInteger(requestId) || requestId < 1 || requestId > MAX_PENDING_REQUEST_ID)
        throw Error('INVALID_REQUEST_ID');
      if (!initialized || notRunning()) return false;
      const generation = epoch;
      let native;
      let shouldRevoke = false;
      let result = null;
      let error = null;
      try {
        // No trust in event-supplied client/window/tool/session metadata.
        const claimed = await nativeAdapter.getRead(requestId);
        native = claimed.context;
        if (notRunning() || generation !== epoch) throw Error('CONNECTION_REVOKED');
        const gate = gates.get(native?.nativeConnectionId);
        if (!gate) throw Error('NOT_APPROVED');
        const grant = getLocalGrant();
        if (!grant?.sessionId) throw Error('STALE_SESSION');
        result = await pairing.authorizeReadFromNative(native, {
          getDocumentSignature: () => currentSignature(controlApi, grant.sessionId),
          read: (sessionId) => {
            if (getLocalGrant()?.sessionId !== sessionId) throw Error('STALE_SESSION');
            return gate.handleRequestFromAuthenticatedIpc(
              {
                windowId: native.windowId,
                clientId: native.peerIdentity,
                connectionId: native.nativeConnectionId,
              },
              { tool: claimed.tool, arguments: claimed.arguments },
            );
          },
        });
        if (generation !== epoch || notRunning()) throw Error('CONNECTION_REVOKED');
      } catch {
        error = clean();
        shouldRevoke = true;
      }
      try {
        await nativeAdapter.reply(requestId, { result, error });
      } catch {
        // Native reply was not delivered: abort all IPC access.
        await stop().catch(() => {});
        return false;
      }
      if (shouldRevoke && native?.nativeConnectionId) {
        revokeLocal(native.nativeConnectionId);
        try {
          await nativeAdapter.reject(native.nativeConnectionId);
        } catch {
          await stop().catch(() => {});
        }
      }
      return error === null;
    },
    onNativeDisconnected(nativeConnectionId) {
      if (!disposed) revokeLocal(nativeConnectionId);
    },
    async onLocalDocumentsChanged() {
      if (notRunning()) return;
      // Called on state/model/Working/DrawingProject changes by the GUI owner.
      // It intentionally revokes ALL connections; no implicit reapproval.
      await stop();
    },
    async stop() {
      await stop();
    },
    getState() {
      return Object.freeze({ initialized, stopped, failedShutdown, approved: gates.size });
    },
    async dispose() {
      if (disposed) return;
      try {
        await stop();
      } finally {
        unsubscribe();
        pairing.dispose();
        disposed = true;
      }
    },
  });
}
