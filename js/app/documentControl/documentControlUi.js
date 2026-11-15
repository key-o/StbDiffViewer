/**
 * Issue #485 — explicitly opt-in, per-window local Document Control permission UI.
 *
 * P0/P1 preparation only. This module does NOT connect to MCP, expose any
 * session token globally, register network handlers, or transmit model data.
 */
import globalState, { getState, addStateListener } from '../../data/state/globalState.js';
import { eventBus } from '../../data/events/eventBus.js';
import { ModelEvents, RenderEvents } from '../../constants/eventTypes.js';
import { createDocumentControlApi } from './documentControlApi.js';
import { mountTauriMcpBridge } from './tauriMcpBridge.js';
import { createTauriMcpReadGate } from './tauriMcpReadGate.js';
import { createWebMcpRelayProtocol } from './webMcpRelayProtocol.js';
import { mountWebMcpRelayPanel } from './webMcpRelayPanel.js';
import { createTauriMcpNativeAdapter, mountTauriMcpPairedPanel } from './tauriMcpPairedPanel.js';

const WATCHED_STATE = Object.freeze([
  'models.documentA',
  'models.documentB',
  // EditingSession writes the entire models.editing object, not its leaf paths.
  'models.editing',
  'models.editing.active',
  'models.editing.sessionId',
  'models.editing.workingRevision',
  'models.editing.workingDocument',
]);

function hasWorkingSource(stateProvider) {
  const editing = stateProvider('models.editing');
  return (
    stateProvider('models.documentA')?.nodeType === 9 &&
    editing?.active === true &&
    typeof editing.sessionId === 'string' &&
    Boolean(editing.sessionId) &&
    Number.isSafeInteger(editing.workingRevision) &&
    editing.workingRevision >= 0 &&
    editing.workingDocument?.nodeType === 9 &&
    editing.workingDocument.documentElement?.nodeType === 1
  );
}

function hasOpenSource(stateProvider) {
  return ['A', 'B'].some((slot) => stateProvider(`models.document${slot}`)?.nodeType === 9);
}

/**
 * UI binding is intentionally separate from Document Control API. A future
 * gateway must not receive the approve/disconnect methods from this binding.
 *
 * @param {Object} options - Dependency injection for browser and unit tests.
 * @returns {{dispose:Function, controlApi:Object}|null}
 */
export function initializeDocumentControlUi({
  documentLike = globalThis.document,
  windowLike = globalThis.window,
  stateProvider = getState,
  onStateChange = addStateListener,
  offStateChange = (path, callback) => globalState.removeListener(path, callback),
  bus = eventBus,
  controlApi,
} = {}) {
  // Keep the entry hidden in Web builds, including before initialization.
  const nativePairing = createTauriMcpNativeAdapter(windowLike);
  documentLike
    ?.getElementById('toggle-document-control-btn')
    ?.classList.toggle('hidden', !nativePairing);
  const grant = documentLike?.getElementById('document-control-grant');
  const revoke = documentLike?.getElementById('document-control-revoke');
  const status = documentLike?.getElementById('document-control-status');
  const allowed = documentLike?.getElementById('document-control-documents');
  const includeWorking = documentLike?.getElementById('document-control-include-working');
  if (!grant || !revoke || !status || !allowed || !includeWorking) return null;

  const api = controlApi ?? createDocumentControlApi({ getState: stateProvider, eventBus: bus });
  const teardown = [];
  let granted = null;
  let disposed = false;
  let pageHidden = false;
  let modelReady = false;
  let mcpBridge = null;
  let webPanel = null;
  let pairedPanel = null;
  let remountNativePairing = () => {};
  let nativeChain = Promise.resolve();

  const render = () => {
    if (disposed) return;
    const hasSource = modelReady && hasOpenSource(stateProvider);
    grant.disabled = !hasSource || Boolean(granted);
    includeWorking.disabled = !hasSource || !hasWorkingSource(stateProvider) || Boolean(granted);
    revoke.disabled = !granted;
    status.textContent = granted
      ? mcpBridge
        ? 'タブ内読取許可中（Tauri外部共有は下欄の別許可が必要）'
        : '読取許可中（このタブ内のみ・外部接続なし）'
      : hasSource
        ? '未許可（外部AIとは未接続）'
        : '未許可（STBの読込・描画完了を待ってください）';
    mcpBridge?.refresh();
    webPanel?.refresh();
    pairedPanel?.refresh();
    allowed.textContent = granted
      ? granted.documents
          .map((entry) =>
            entry.kind === 'drawing-project'
              ? `図面プロジェクト: ${entry.projectId || '名称未設定'}`
              : `モデル${entry.slot} ${entry.kind === 'stb-working' ? 'Working' : 'Source'}: ${entry.name || '名称未設定'}`,
          )
          .join(' / ')
      : '対象ファイル：なし';
  };

  const invalidateIfChanged = () => {
    if (!granted || disposed) {
      render();
      return;
    }
    granted = api.syncWithOpenDocuments();
    if (!granted) includeWorking.checked = false;
    render();
  };

  if (typeof api.subscribeLocalEvents === 'function') {
    // Registry invalidation may originate from the DrawingProject provider rather
    // than a globalState/ModelEvents change; UI must immediately reflect revocation.
    teardown.push(
      api.subscribeLocalEvents(({ event }) => {
        if (event !== 'access_revoked') return;
        granted = null;
        includeWorking.checked = false;
        render();
      }),
    );
  }

  const onGrant = (event) => {
    // Refuse synthetic .click() and dispatched events: consent requires real UI activation.
    if (!event?.isTrusted) return;
    if (disposed || granted || !modelReady || !hasOpenSource(stateProvider)) return;
    // Automatic registry invalidation can leave a stopped controller after local
    // consent was cleared. A new trusted grant needs a fresh unapproved listener.
    if (pairedPanel?.controller.getState().stopped) {
      const stale = pairedPanel;
      pairedPanel = null;
      remountNativePairing(stale);
    }
    try {
      // Only a physical UI click initiates local consent.
      granted = api.approveFromUser({ includeWorking: includeWorking.checked === true });
      render();
    } catch {
      // Do not include raw filename, internal state, or token in error UI.
      granted = null;
      status.textContent = '読取許可に失敗しました。再度操作してください。';
      grant.disabled = !(modelReady && hasOpenSource(stateProvider));
      revoke.disabled = true;
    }
  };
  const onRevoke = () => {
    webPanel?.revoke();
    mcpBridge?.revoke();
    // Native connections must not outlive local read consent.
    if (pairedPanel) {
      const stale = pairedPanel;
      pairedPanel = null;
      remountNativePairing(stale);
    }
    api.disconnect();
    granted = null;
    includeWorking.checked = false;
    render();
  };
  const onModelReset = () => {
    modelReady = false;
    // The normal loader resets globalState without notifying state listeners.
    // ModelEvents.CLEARED fires after that reset; revoke synchronously here.
    onRevoke();
  };
  const onModelLoaded = () => invalidateIfChanged();
  const onRenderComplete = () => {
    modelReady = true;
    invalidateIfChanged();
  };
  const onPageHide = () => {
    // A page leaving the WebView must never re-open Native IPC while teardown runs.
    pageHidden = true;
    if (pairedPanel) {
      const stale = pairedPanel;
      pairedPanel = null;
      nativeChain = nativeChain.then(() => stale.dispose()).catch(() => {});
    }
    onRevoke();
  };

  grant.addEventListener('click', onGrant);
  revoke.addEventListener('click', onRevoke);
  teardown.push(() => grant.removeEventListener('click', onGrant));
  teardown.push(() => revoke.removeEventListener('click', onRevoke));

  // Replacing either source requires a NEW render completion before reapproval.
  // The previous model's MODEL_LOADED event must not authorize a new DOM document.
  const onSourceChanged = () => {
    modelReady = false;
    invalidateIfChanged();
  };
  for (const path of WATCHED_STATE) {
    const listener = ['models.documentA', 'models.documentB'].includes(path)
      ? onSourceChanged
      : () => {
          if (!granted) includeWorking.checked = false;
          invalidateIfChanged();
        };
    onStateChange(path, listener);
    teardown.push(() => offStateChange(path, listener));
  }
  if (bus?.on) {
    teardown.push(bus.on(ModelEvents.CLEARED, onModelReset));
    teardown.push(bus.on(ModelEvents.PARSE_STARTED, onModelReset));
    teardown.push(bus.on(ModelEvents.LOAD_ERROR, onModelReset));
    teardown.push(bus.on(ModelEvents.LOADED, onModelLoaded));
    teardown.push(bus.on(RenderEvents.MODEL_LOADED, onRenderComplete));
  }
  if (windowLike?.addEventListener) {
    windowLike.addEventListener('pagehide', onPageHide);
    teardown.push(() => windowLike.removeEventListener('pagehide', onPageHide));
  }
  mcpBridge = mountTauriMcpBridge({
    panel: documentLike.getElementById('document-control-panel'),
    controlApi: api,
    getLocalGrant: () => granted,
    windowLike,
  });
  // Prefer verified Native IPC when available. Existing loopback is a separate
  // experimental transport; never fall back to it after Native advertises a
  // pairing transport, even if that backend subsequently fails its identity gate.
  const mountNativePairing = async () => {
    if (disposed || pageHidden) return;
    const capabilities = await nativePairing.capabilities();
    if (disposed || pageHidden) {
      // capabilities() can itself start the Rust listener after pagehide; close it.
      await nativePairing.stop().catch(() => {});
      return;
    }
    if (!['windows-named-pipe', 'linux-unix-peercred'].includes(capabilities?.transport)) return;
    mcpBridge?.dispose();
    mcpBridge = null;
    if (capabilities.nativeIdentityVerified !== true || capabilities.windowId !== 'main') return;
    const mounted = await mountTauriMcpPairedPanel({
      panel: documentLike.getElementById('document-control-panel'),
      controlApi: api,
      getLocalGrant: () => granted,
      nativeAdapter: nativePairing,
      readGateFactory: createTauriMcpReadGate,
      documentLike,
      windowLike,
    });
    if (disposed || pageHidden) {
      await mounted?.dispose();
      return;
    }
    pairedPanel = mounted;
    render();
  };
  // Stop is terminal for a paired panel (no implicit re-approval). After consent is revoked,
  // replace it with a fresh, unapproved one so new connections can be paired again.
  remountNativePairing = (stale = null) => {
    // Remove the retired panel synchronously so its old "ready" controls cannot
    // be mistaken for the replacement while Native shutdown is still pending.
    const retirement = stale?.dispose();
    nativeChain = nativeChain
      .then(async () => {
        if (stale) {
          // Panel disposal intentionally absorbs errors. Verify Native shutdown
          // separately: failed stop must never be followed by a new listener.
          await stale.controller.stop();
          await retirement;
        }
        return disposed || pageHidden ? null : mountNativePairing();
      })
      .catch(() => {
        // No auto-approval or silent reversion to copied-bearer transport.
      });
  };
  if (nativePairing) remountNativePairing();
  // Web and Tauri are separate transports. Public Web has no configured endpoint.
  webPanel = mountWebMcpRelayPanel({
    panel: documentLike.getElementById('document-control-panel'),
    controlApi: api,
    getLocalGrant: () => granted,
    readGateFactory: createTauriMcpReadGate,
    protocolFactory: createWebMcpRelayProtocol,
    documentLike,
    windowLike,
  });
  render();

  return {
    // Local testing / lifetime owner only. Not on window or globalState.
    controlApi: api,
    dispose() {
      if (disposed) return;
      onRevoke();
      for (const unsubscribe of teardown) unsubscribe();
      mcpBridge?.dispose();
      webPanel?.dispose();
      if (pairedPanel) void pairedPanel.dispose();
      api.dispose();
      disposed = true;
    },
  };
}
