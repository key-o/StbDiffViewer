/** #500: Tauri-only local MCP external sharing. GitHub Pages is unaffected. */
import { createTauriMcpReadGate } from './tauriMcpReadGate.js';
const makeToken = () => {
  if (typeof globalThis.crypto?.randomUUID !== 'function') throw Error('SECURE_RANDOM_UNAVAILABLE');
  return Array.from({ length: 3 }, () => globalThis.crypto.randomUUID().replaceAll('-', '')).join(
    '',
  );
};
export function mountTauriMcpBridge({
  panel,
  controlApi,
  getLocalGrant,
  windowLike = globalThis.window,
}) {
  const native = windowLike?.__TAURI__;
  if (!native?.core?.invoke || !native?.event?.listen || !panel) return null;
  const { invoke } = native.core;
  const gate = createTauriMcpReadGate({ controlApi, windowId: 'main' });
  const doc = windowLike.document;
  const section = doc.createElement('section');
  section.className = 'document-control-local-mcp';
  const title = doc.createElement('p');
  title.textContent = 'Tauri ローカルMCP（Windows実機検証）';
  const note = doc.createElement('p');
  note.textContent =
    '承認済み文書のみ外部AIへ読取共有します。送信情報はAIサービスへ渡る場合があります。';
  const start = doc.createElement('button');
  start.type = 'button';
  start.textContent = '接続情報を生成';
  const approve = doc.createElement('button');
  approve.type = 'button';
  approve.textContent = '外部AIへの読取を60秒間許可';
  const stop = doc.createElement('button');
  stop.type = 'button';
  stop.textContent = '外部接続を停止';
  const status = doc.createElement('p');
  status.setAttribute('role', 'status');
  const info = doc.createElement('pre');
  info.style.whiteSpace = 'pre-wrap';
  info.style.overflowWrap = 'anywhere';
  section.append(title, note, start, approve, stop, status, info);
  panel.append(section);
  let disposed = false;
  let active = false;
  let starting = false;
  let stopping = 0;
  let shutdownFailed = false;
  let lifecycle = 0;
  let consentSession = null;
  let unlisten = null;
  const connection = {
    windowId: 'main',
    clientId: 'local-stdio',
    connectionId: 'local-test-bridge',
  };
  const refresh = () => {
    if (disposed) return;
    const local = getLocalGrant();
    start.disabled = !local || active || starting || stopping > 0 || shutdownFailed;
    approve.disabled =
      !active ||
      starting ||
      stopping > 0 ||
      shutdownFailed ||
      !local ||
      local.sessionId !== consentSession;
    stop.disabled = (!active && !starting) || stopping > 0 || shutdownFailed;
    if (active && (!local || local.sessionId !== consentSession)) turnOff();
  };
  const turnOff = () => {
    // Invalidate any in-flight start before requesting native shutdown.
    lifecycle += 1;
    gate.revokeFromTrustedUi();
    active = false;
    consentSession = null;
    info.textContent = '';
    status.textContent = '外部MCP接続停止中';
    stopping += 1;
    void invoke('mcp_local_stop')
      .catch(() => {
        shutdownFailed = true;
        if (!disposed) status.textContent = '停止失敗：アプリを終了して遮断してください';
      })
      .finally(() => {
        stopping -= 1;
        refresh();
      });
    refresh();
  };
  start.addEventListener('click', async (event) => {
    if (!event.isTrusted || disposed || active || starting || stopping > 0 || shutdownFailed)
      return;
    const initialSession = getLocalGrant()?.sessionId;
    if (!initialSession) return;
    const startLifecycle = lifecycle;
    starting = true;
    refresh();
    try {
      const token = makeToken();
      const port = await invoke('mcp_local_start', { token });
      // A revoke/stop, document replacement, or dispose while native start was
      // pending must close the newly opened listener, not resurrect the bridge.
      if (
        disposed ||
        lifecycle !== startLifecycle ||
        getLocalGrant()?.sessionId !== initialSession
      ) {
        turnOff();
        return;
      }
      active = true;
      consentSession = initialSession;
      info.textContent = [
        'Claude/CodexのローカルMCP登録に使用する環境変数:',
        'SDV_MCP_PORT=' + port,
        'SDV_MCP_TOKEN=' + token,
        '起動コマンド: <STB Diff Viewer.exe> --mcp-live',
        '※秘密情報を公開ログやスクリーンショットに貼り付けないこと',
      ].join('\n');
      status.textContent = '通信待受中／外部への文書共有は未許可';
    } catch {
      if (!disposed && lifecycle === startLifecycle)
        status.textContent = 'MCP接続情報を生成できませんでした';
    } finally {
      starting = false;
      refresh();
    }
  });
  approve.addEventListener('click', (event) => {
    if (!event.isTrusted || disposed || !active) return;
    const grant = getLocalGrant();
    if (!grant || grant.sessionId !== consentSession) return;
    try {
      const result = gate.authorizeFromTrustedUi({
        ...connection,
        approvedWindowId: 'main',
        sessionId: grant.sessionId,
      });
      status.textContent = '外部読取許可中（60秒・文書' + result.documentCount + '件）';
    } catch {
      status.textContent = '外部読取の許可に失敗しました';
    }
  });
  stop.addEventListener('click', (event) => {
    if (event.isTrusted && !disposed && (active || starting) && stopping === 0) turnOff();
  });
  const subscribe = native.event.listen('sdv-mcp-read-request', async ({ payload }) => {
    if (disposed || !payload || !Number.isSafeInteger(payload.id)) return;
    let result = null;
    let error = null;
    let revokeAfterReply = false;
    try {
      if (!active || !getLocalGrant() || getLocalGrant().sessionId !== consentSession) {
        throw Error('NOT_APPROVED');
      }
      // Only native-authenticated connection context; never copy it from MCP arguments.
      result = gate.handleRequestFromAuthenticatedIpc(payload.context, {
        tool: payload.tool,
        arguments: payload.arguments,
      });
    } catch (cause) {
      error = 'READ_DENIED';
      // A stale document or expired lease must also invalidate the native
      // bearer/listener, not leave a readable local endpoint behind.
      revokeAfterReply = [
        'APPROVAL_EXPIRED',
        'STALE_DOCUMENTS',
        'STALE_SESSION',
        'GATE_DISPOSED',
      ].includes(cause?.code);
    }
    try {
      await invoke('mcp_local_reply', { id: payload.id, result, error });
    } catch {
      // Continuing after a native reply failure can leave a broken bridge
      // listening with live credentials. Fail closed even if the read succeeded.
      revokeAfterReply = true;
    } finally {
      if (revokeAfterReply && !disposed && (active || starting)) turnOff();
    }
  });
  Promise.resolve(subscribe)
    .then((off) => {
      if (disposed) off?.();
      else unlisten = off;
    })
    .catch(() => {
      status.textContent = 'Tauriイベント購読に失敗しました';
      turnOff();
    });
  status.textContent = '外部MCP接続停止中';
  refresh();
  return {
    refresh,
    revoke: turnOff,
    dispose() {
      if (disposed) return;
      turnOff();
      disposed = true;
      gate.dispose();
      unlisten?.();
      section.remove();
    },
  };
}
