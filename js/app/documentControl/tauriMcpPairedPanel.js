/**
 * #500: GUI-facing pairing presentation for a future verified Native IPC adapter.
 * All Native events are untrusted cursors; the Rust side MUST resolve the actual
 * OS-authenticated pipe handle for every pending/read request ID.
 *
 * This module does not mount itself. Until the Native API implements
 * peer verification, initialize() denies access and no panel appears.
 */
import { createTauriMcpPairedController } from './tauriMcpPairedController.js';

export function createTauriMcpNativeAdapter(windowLike = globalThis.window) {
  const tauri = windowLike?.__TAURI__;
  if (!tauri?.core?.invoke || !tauri?.event?.listen) return null;
  const invoke = tauri.core.invoke;
  return Object.freeze({
    capabilities: () => invoke('mcp_pairing_capabilities'),
    getPending: (id) => invoke('mcp_pairing_get_pending', { id }),
    approve: (id) => invoke('mcp_pairing_approve', { id }),
    reject: (id) => invoke('mcp_pairing_reject', { id }),
    getRead: (id) => invoke('mcp_pairing_get_read', { id }),
    reply: (id, { result, error }) => invoke('mcp_pairing_reply', { id, result, error }),
    stop: () => invoke('mcp_pairing_stop'),
    listen: async (kind, callback) =>
      tauri.event.listen('sdv-mcp-pairing-' + kind, ({ payload }) => callback(payload)),
  });
}

/** Call only after the Native backend reports verified OS identity (never token-only). */
export async function mountTauriMcpPairedPanel({
  panel,
  controlApi,
  getLocalGrant,
  nativeAdapter,
  readGateFactory,
  documentLike = globalThis.document,
  windowLike = globalThis.window,
  windowId = 'main',
} = {}) {
  if (
    !panel ||
    typeof documentLike?.createElement !== 'function' ||
    typeof nativeAdapter?.listen !== 'function'
  )
    return null;
  const controller = createTauriMcpPairedController({
    controlApi,
    getLocalGrant,
    nativeAdapter,
    readGateFactory,
    windowId,
  });
  try {
    await controller.initialize();
  } catch {
    await controller.dispose().catch(() => {});
    return null;
  }

  let disposed = false;
  let priorLocalSession = getLocalGrant()?.sessionId ?? null;
  const section = documentLike.createElement('section');
  section.className = 'document-control-native-pairing';
  const heading = documentLike.createElement('p');
  heading.textContent = 'ローカルMCP 接続ごとの承認';
  const warning = documentLike.createElement('p');
  warning.textContent =
    'クライアント名は自己申告です。承認した文書の情報が外部AIに送られる場合があります。';
  const status = documentLike.createElement('p');
  status.setAttribute('role', 'status');
  const pendingList = documentLike.createElement('div');
  const stopButton = documentLike.createElement('button');
  stopButton.type = 'button';
  stopButton.textContent = '接続をすべて停止';
  section.append(heading, warning, status, pendingList, stopButton);
  panel.append(section);

  const unlisteners = [];
  const shutdown = async () => {
    try {
      await controller.stop();
      if (!disposed) status.textContent = 'Native接続は停止しました';
    } catch {
      if (!disposed) status.textContent = 'Native停止失敗：アプリを終了してください';
    }
    render();
  };
  const render = () => {
    if (disposed) return;
    const state = controller.getState();
    stopButton.disabled = state.stopped || state.failedShutdown;
    pendingList.replaceChildren();
    if (state.stopped) return;
    const pending = controller.listPendingForUi();
    status.textContent = pending.length
      ? `${pending.length}件の新しい接続が承認待ちです。接続ごとに確認してください。`
      : '接続待ち（未承認のクライアントは文書を読めません）';
    const local = getLocalGrant();
    for (const item of pending) {
      const row = documentLike.createElement('div');
      const description = documentLike.createElement('span');
      const scope = Array.isArray(local?.documents)
        ? local.documents.map((entry) => `${entry.kind}:${entry.slot || '-'}`).join(' / ')
        : '対象文書なし';
      description.textContent = `${item.clientLabel}（未検証） / 接続 ${item.nativeConnectionId.slice(0, 12)} / ${scope}`;
      const approveButton = documentLike.createElement('button');
      approveButton.type = 'button';
      approveButton.textContent = 'この接続の読取を60秒許可';
      approveButton.disabled = !local?.sessionId;
      const rejectButton = documentLike.createElement('button');
      rejectButton.type = 'button';
      rejectButton.textContent = '拒否';
      approveButton.addEventListener('click', async (event) => {
        if (event.isTrusted !== true || disposed) return;
        approveButton.disabled = true;
        rejectButton.disabled = true;
        try {
          await controller.approveFromTrustedUi({
            nativeConnectionId: item.nativeConnectionId,
            event,
          });
        } catch {
          if (!disposed) status.textContent = '承認できませんでした。接続を確認してください。';
        }
        render();
      });
      rejectButton.addEventListener('click', async (event) => {
        if (event.isTrusted !== true || disposed) return;
        approveButton.disabled = true;
        rejectButton.disabled = true;
        try {
          await controller.rejectFromTrustedUi({
            nativeConnectionId: item.nativeConnectionId,
            event,
          });
        } catch {
          await shutdown();
        }
        render();
      });
      row.append(description, approveButton, rejectButton);
      pendingList.append(row);
    }
  };
  stopButton.addEventListener('click', (event) => {
    if (event.isTrusted === true && !disposed) void shutdown();
  });
  const pageHide = () => void shutdown();
  windowLike?.addEventListener?.('pagehide', pageHide);

  try {
    // Event payloads contain notification cursors only, never credentials.
    const pending = await nativeAdapter.listen('pending', async (payload) => {
      if (disposed) return;
      try {
        await controller.onNativePending(payload?.id);
      } catch {
        // Failed Native identity lookup must never auto-approve a connection.
      }
      render();
    });
    unlisteners.push(pending);
    const read = await nativeAdapter.listen('read', async (payload) => {
      if (disposed) return;
      try {
        await controller.onNativeRead(payload?.id);
      } catch {
        await shutdown();
      }
      render();
    });
    unlisteners.push(read);
    const disconnected = await nativeAdapter.listen('disconnected', (payload) => {
      if (disposed) return;
      controller.onNativeDisconnected(payload?.id);
      render();
    });
    unlisteners.push(disconnected);
  } catch {
    await shutdown();
    for (const unsubscribe of unlisteners) unsubscribe?.();
    section.remove();
    await controller.dispose().catch(() => {});
    windowLike?.removeEventListener?.('pagehide', pageHide);
    return null;
  }
  render();
  return Object.freeze({
    controller,
    refresh() {
      if (disposed) return;
      const currentSession = getLocalGrant()?.sessionId ?? null;
      const previous = priorLocalSession;
      priorLocalSession = currentSession;
      if (previous && currentSession !== previous) void shutdown();
      else render();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unlisteners) unsubscribe?.();
      windowLike?.removeEventListener?.('pagehide', pageHide);
      section.remove();
      await controller.dispose().catch(() => {});
    },
  });
}
