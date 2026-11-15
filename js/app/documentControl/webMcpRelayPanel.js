/**
 * #533 Web-only, localhost development relay. Production/GitHub Pages has no
 * configured endpoint: an arbitrary URL, query parameter or JSON frame cannot
 * select a recipient. A hosted WSS gateway requires a separately reviewed trust
 * configuration before this transport can be enabled outside loopback.
 */
import { formatWebMcpShareScope, hasWebMcpShareScope } from './webMcpShareSummary.js';

const DEV_RELAY = 'ws://127.0.0.1:8765/sdv-mcp';
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128;
const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
const safeFrame = (value) =>
  typeof value === 'string' && new TextEncoder().encode(value).length <= 16384;

export function mountWebMcpRelayPanel({
  panel,
  controlApi,
  getLocalGrant,
  readGateFactory,
  protocolFactory,
  documentLike = globalThis.document,
  windowLike = globalThis.window,
  createSocket = (url) => new windowLike.WebSocket(url),
  randomId = () => windowLike.crypto.randomUUID(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id),
} = {}) {
  if (
    !panel ||
    !documentLike?.createElement ||
    !controlApi ||
    typeof getLocalGrant !== 'function' ||
    typeof readGateFactory !== 'function' ||
    typeof protocolFactory !== 'function' ||
    windowLike?.__TAURI__
  )
    return null;

  const dev = ['localhost', '127.0.0.1'].includes(windowLike.location?.hostname);
  const section = documentLike.createElement('section');
  section.className = 'document-control-web-mcp';
  const heading = documentLike.createElement('p');
  heading.textContent = 'Web MCP中継（Linuxローカル検証）';
  const description = documentLike.createElement('p');
  description.textContent = dev
    ? '開発専用: ' +
      DEV_RELAY +
      '。Gatewayコンソールのペアリングキーで接続後、外部共有を別途許可します。'
    : '公開Web版の外部接続は無効です。認証済み公開Gatewayが用意されるまで送信しません。';
  const keyInput = documentLike.createElement('input');
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.placeholder = 'Gatewayのペアリングキー（16文字以上）';
  const connect = documentLike.createElement('button');
  connect.type = 'button';
  connect.textContent = 'ローカルGatewayへ接続（共有は未許可）';
  const approve = documentLike.createElement('button');
  approve.type = 'button';
  approve.textContent = 'この接続への読取を60秒許可';
  const stop = documentLike.createElement('button');
  stop.type = 'button';
  stop.textContent = 'Web外部接続を停止';
  const status = documentLike.createElement('p');
  status.setAttribute('role', 'status');
  const sharedScope = documentLike.createElement('p');
  sharedScope.setAttribute('aria-live', 'polite');
  section.append(heading, description, keyInput, connect, approve, stop, status, sharedScope);
  panel.append(section);

  let disposed = false;
  let phase = 'idle';
  let generation = 0;
  let socket = null;
  let gate = null;
  let protocol = null;
  let timer = null;
  let identity = null;
  let consentSession = null;
  let nonce = null;
  let clientLabel = '';
  // Disabled public pages must remain usable even in insecure HTTP contexts.
  let tabId = null;
  if (dev) {
    try {
      tabId = randomId();
    } catch {
      // Secure random is unavailable: keep the transport disabled.
    }
  }

  function refresh() {
    if (disposed) return;
    if (phase !== 'idle' && getLocalGrant()?.sessionId !== consentSession) {
      shutdown('文書の変更・読取許可の解除により外部接続を停止しました');
      return;
    }
    const local = getLocalGrant();
    const available =
      dev && isId(tabId) && Boolean(windowLike.WebSocket) && hasWebMcpShareScope(local);
    // Show exactly which approved documents would be disclosed BEFORE the
    // independent external-sharing click; do not transmit this preview.
    sharedScope.textContent =
      phase === 'paired' || phase === 'sharing'
        ? formatWebMcpShareScope(local?.documents)
        : '外部共有対象は接続・ペアリング後に確認できます';
    connect.disabled = !available || phase !== 'idle';
    approve.disabled =
      phase !== 'paired' || !hasWebMcpShareScope(local) || local.sessionId !== consentSession;
    stop.disabled = phase === 'idle';
    keyInput.disabled = !available || phase !== 'idle';
    if (phase === 'idle' && !status.textContent) {
      status.textContent = dev ? '外部接続なし（既定OFF）' : '公開Gateway未対応（外部送信なし）';
    }
  }

  function shutdown(message = 'Web外部接続を停止しました') {
    generation++;
    phase = 'idle';
    if (timer !== null) cancel(timer);
    timer = null;
    const oldProtocol = protocol;
    protocol = null;
    const oldGate = gate;
    gate = null;
    const oldSocket = socket;
    socket = null;
    identity = null;
    consentSession = null;
    nonce = null;
    clientLabel = '';
    keyInput.value = '';
    oldProtocol?.close();
    oldGate?.revokeFromTrustedUi();
    oldGate?.dispose();
    try {
      oldSocket?.close();
    } catch {
      /* already closed */
    }
    if (!disposed) status.textContent = message;
    refresh();
  }

  connect.addEventListener('click', (event) => {
    if (
      !event?.isTrusted ||
      disposed ||
      phase !== 'idle' ||
      !dev ||
      !isId(tabId) ||
      !windowLike.WebSocket
    )
      return;
    const local = getLocalGrant();
    const session = local?.sessionId;
    const code = keyInput.value;
    if (!hasWebMcpShareScope(local) || !isId(session) || !/^[a-zA-Z0-9_-]{16,128}$/.test(code)) {
      status.textContent = '読取許可と16文字以上のペアリングキーが必要です';
      return;
    }
    const epoch = ++generation;
    try {
      nonce = randomId();
      if (!isId(nonce)) throw Error('INVALID_NONCE');
      consentSession = session;
      socket = createSocket(DEV_RELAY);
      phase = 'connecting';
      const ws = socket;
      status.textContent = 'Gatewayペアリング待ち（共有は未許可）';
      timer = schedule(() => {
        if (epoch === generation) shutdown('ペアリング期限切れ');
      }, 10000);
      ws.addEventListener('open', () => {
        if (epoch !== generation || ws.readyState !== 1) return;
        // No document identifier, session token or XML is sent during pairing.
        ws.send(JSON.stringify({ type: 'pair', nonce, code }));
        keyInput.value = '';
      });
      ws.addEventListener('message', ({ data }) => {
        if (epoch !== generation || typeof data !== 'string' || !safeFrame(data)) {
          if (epoch === generation) shutdown('不正なGateway応答');
          return;
        }
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          shutdown('不正なGateway応答');
          return;
        }
        if (!isRecord(msg)) {
          shutdown('不正なGateway応答');
          return;
        }
        if (
          phase === 'connecting' &&
          msg.type === 'paired' &&
          msg.nonce === nonce &&
          isId(msg.clientId) &&
          isId(msg.connectionId) &&
          isId(msg.clientLabel) &&
          Object.keys(msg).every((key) =>
            ['type', 'nonce', 'clientId', 'connectionId', 'clientLabel'].includes(key),
          )
        ) {
          if (timer !== null) cancel(timer);
          timer = null;
          phase = 'paired';
          // IDs come from the fixed local gateway after pairing, never RPC payload.
          identity = Object.freeze({
            windowId: tabId,
            clientId: msg.clientId,
            connectionId: msg.connectionId,
          });
          clientLabel = msg.clientLabel;
          status.textContent = clientLabel + '（Gateway申告）に接続。文書共有は未許可';
          refresh();
        } else if (
          phase === 'sharing' &&
          msg.type === 'request' &&
          Object.keys(msg).length === 2 &&
          typeof msg.payload === 'string'
        ) {
          try {
            if (getLocalGrant()?.sessionId !== consentSession) {
              shutdown('文書が変更されました');
              return;
            }
            const payload = protocol.acceptFrame(msg.payload);
            if (epoch === generation && ws.readyState === 1)
              ws.send(JSON.stringify({ type: 'response', payload }));
          } catch {
            shutdown('要求を拒否して接続を停止しました');
          }
        } else {
          shutdown('無承認または不正な要求を拒否しました');
        }
      });
      ws.addEventListener('close', () => {
        if (epoch === generation) shutdown('Gatewayが切断されました');
      });
      ws.addEventListener('error', () => {
        if (epoch === generation) shutdown('Gateway接続エラー');
      });
      refresh();
    } catch {
      shutdown('安全なGateway接続を開始できませんでした');
    }
  });

  approve.addEventListener('click', (event) => {
    if (!event?.isTrusted || disposed || phase !== 'paired' || !identity) return;
    const local = getLocalGrant();
    const sessionId = local?.sessionId;
    if (!hasWebMcpShareScope(local) || sessionId !== consentSession) {
      shutdown('文書が変更されました');
      return;
    }
    try {
      gate = readGateFactory({ controlApi, windowId: tabId });
      gate.authorizeFromTrustedUi({ ...identity, approvedWindowId: tabId, sessionId });
      protocol = protocolFactory({
        readGate: gate,
        context: identity,
        onClose: () => {
          if (phase === 'sharing') shutdown('接続権限が失効しました');
        },
      });
      phase = 'sharing';
      // No auto renewal: every expiry requires a new pairing and physical click.
      timer = schedule(() => shutdown('60秒の外部読取許可が終了しました'), 60000);
      status.textContent = clientLabel + ' への読取共有中（最大60秒）';
      refresh();
    } catch {
      shutdown('外部共有を許可できませんでした');
    }
  });
  stop.addEventListener('click', (event) => {
    if (event?.isTrusted && !disposed) shutdown();
  });
  const pageHide = () => shutdown('タブ終了により停止');
  windowLike.addEventListener?.('pagehide', pageHide);
  refresh();
  return Object.freeze({
    refresh,
    revoke: () => shutdown('タブ内の読取許可が解除されました'),
    dispose() {
      if (disposed) return;
      shutdown();
      disposed = true;
      windowLike.removeEventListener?.('pagehide', pageHide);
      section.remove();
    },
  });
}
