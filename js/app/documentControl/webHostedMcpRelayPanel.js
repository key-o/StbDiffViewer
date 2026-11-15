/**
 * #539 optional, NOT MOUNTED by default: hosted Web MCP session opt-in.
 * Deployment MUST provide immutable audited configuration and backend-controlled
 * consent/CSRF callbacks. The public Web page config remains absent and OFF.
 */
const FRAME_LIMIT = 69632;
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;
const safeCsrf = (v) => typeof v === 'string' && /^[a-zA-Z0-9_-]{16,256}$/.test(v);
const encodeBytes = (v) => new TextEncoder().encode(v).length;
const hasScope = (grant) =>
  validId(grant?.sessionId) && Array.isArray(grant?.documents) && grant.documents.length > 0;

function safeEndpoint(settings) {
  if (
    !isRecord(settings) ||
    settings.enabledByOperator !== true ||
    typeof settings.wssUrl !== 'string'
  )
    return null;
  try {
    const url = new URL(settings.wssUrl);
    if (
      url.protocol !== 'wss:' ||
      !url.hostname ||
      url.pathname !== '/sdv-gateway-tab' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      settings.wssUrl !== url.href ||
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1'
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Must be separately mounted after explicit deployment review; never via URL/query. */
export function mountHostedMcpRelayPanel({
  panel,
  config = null,
  controlApi,
  getLocalGrant,
  getVerifiedRecipient,
  approveExternalShareFromUi,
  readGateFactory,
  protocolFactory,
  documentLike = globalThis.document,
  windowLike = globalThis.window,
  createSocket = (url) => new windowLike.WebSocket(url),
  randomId = () => windowLike.crypto.randomUUID(),
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  const endpoint = safeEndpoint(config);
  if (
    !panel ||
    !endpoint ||
    windowLike?.__TAURI__ ||
    !documentLike?.createElement ||
    typeof controlApi?.handleReadRequest !== 'function' ||
    typeof getLocalGrant !== 'function' ||
    typeof getVerifiedRecipient !== 'function' ||
    typeof approveExternalShareFromUi !== 'function' ||
    typeof readGateFactory !== 'function' ||
    typeof protocolFactory !== 'function' ||
    typeof createSocket !== 'function' ||
    typeof randomId !== 'function'
  )
    return null;

  const wrapper = documentLike.createElement('section');
  const heading = documentLike.createElement('p');
  heading.textContent = '認証付きWeb MCP共有（公開接続は既定OFF）';
  const summary = documentLike.createElement('p');
  const start = documentLike.createElement('button');
  start.type = 'button';
  start.textContent = '表示した対象への外部読取共有を許可して接続';
  const stop = documentLike.createElement('button');
  stop.type = 'button';
  stop.textContent = '外部読取を停止';
  const status = documentLike.createElement('p');
  status.setAttribute('role', 'status');
  wrapper.append(heading, summary, start, stop, status);
  panel.append(wrapper);
  let socket = null;
  let gate = null;
  let protocol = null;
  let timer = null;
  let connectedSessionId = null;
  let connectedSignature = '';
  let tabId = null;
  let disposed = false;
  let phase = 'idle';
  let epoch = 0;
  let nonce = null;
  let recipient = null;
  try {
    tabId = randomId();
  } catch {
    /* fail closed */
  }

  const signature = (grant) =>
    JSON.stringify(
      grant?.documents?.map(({ documentId, revisionId, kind, slot }) => [
        documentId,
        revisionId,
        kind,
        slot,
      ]) ?? [],
    );

  function verifiedRecipient() {
    let info;
    try {
      info = getVerifiedRecipient();
    } catch {
      return null;
    }
    if (
      !isRecord(info) ||
      !validId(info.clientId) ||
      typeof info.clientLabel !== 'string' ||
      !info.clientLabel ||
      info.clientLabel.length > 128 ||
      !Number.isFinite(info.expiresAtMs) ||
      info.expiresAtMs <= Date.now()
    )
      return null;
    return info;
  }

  // Stop data disclosure if the server-verified recipient is revoked or changed.
  function recipientStillAuthorized() {
    const current = verifiedRecipient();
    return Boolean(
      current &&
      recipient &&
      recipient.expiresAtMs > Date.now() &&
      current.clientId === recipient.clientId &&
      current.clientLabel === recipient.clientLabel,
    );
  }

  function scopeText(grant) {
    if (!hasScope(grant)) return '許可対象の文書はありません';
    return (
      grant.documents
        .map((d) => {
          const parts = [d.kind, d.slot, d.name].filter((v) => typeof v === 'string');
          return parts.join(' / ').slice(0, 96);
        })
        .slice(0, 8)
        .join('、') || `${grant.documents.length}件の文書`
    );
  }

  function refresh() {
    if (disposed) return;
    const grant = getLocalGrant();
    if (
      phase !== 'idle' &&
      (!recipientStillAuthorized() ||
        grant?.sessionId !== connectedSessionId ||
        signature(grant) !== connectedSignature)
    ) {
      shutdown('Document Controlの権限・revision変更により停止');
      return;
    }
    const info = verifiedRecipient();
    summary.textContent =
      info && hasScope(grant)
        ? `接続先: ${endpoint}。認証済み受信者: ${info.clientLabel}。共有範囲: ${scopeText(grant)}。操作は読取のみ・最大60秒。`
        : '認証済み受信者と読取許可文書が揃うまで外部通信しません';
    start.disabled = phase !== 'idle' || !validId(tabId) || !info || !hasScope(grant);
    stop.disabled = phase === 'idle';
    if (phase === 'idle' && !status.textContent) status.textContent = '外部共有なし（既定OFF）';
  }

  function shutdown(reason = '外部共有を停止しました') {
    epoch++;
    phase = 'idle';
    if (timer !== null) cancel(timer);
    timer = null;
    const oldSocket = socket;
    socket = null;
    protocol?.close();
    protocol = null;
    gate?.revokeFromTrustedUi();
    gate?.dispose();
    gate = null;
    connectedSessionId = null;
    connectedSignature = '';
    recipient = null;
    nonce = null;
    try {
      oldSocket?.close();
    } catch {
      /* closed */
    }
    if (!disposed) {
      status.textContent = reason;
      refresh();
    }
  }

  start.addEventListener('click', async (event) => {
    if (!event?.isTrusted || disposed || phase !== 'idle' || !validId(tabId)) return;
    const grant = getLocalGrant();
    const info = verifiedRecipient();
    if (!hasScope(grant) || !info) return;
    const currentEpoch = ++epoch;
    phase = 'authorizing';
    connectedSessionId = grant.sessionId;
    connectedSignature = signature(grant);
    recipient = info;
    status.textContent = '外部共有のユーザー承認を確認中';
    refresh();
    try {
      // Backend MUST persist independently verified user consent and return a
      // one-time CSRF token bound to same user/tab/client/document scope.
      const proof = await approveExternalShareFromUi({
        sessionId: grant.sessionId,
        clientId: info.clientId,
        documentSignature: connectedSignature,
      });
      if (
        currentEpoch !== epoch ||
        disposed ||
        getLocalGrant()?.sessionId !== connectedSessionId ||
        signature(getLocalGrant()) !== connectedSignature ||
        !recipientStillAuthorized() ||
        !safeCsrf(proof?.csrfToken) ||
        !Number.isFinite(proof?.expiresAtMs) ||
        proof.expiresAtMs <= Date.now() ||
        proof.expiresAtMs - Date.now() > 60000
      ) {
        shutdown('外部共有承認が成立しませんでした');
        return;
      }
      const ws = createSocket(endpoint);
      socket = ws;
      phase = 'connecting';
      timer = schedule(() => shutdown('Gateway接続タイムアウト'), 10000);
      ws.addEventListener('message', ({ data }) => {
        if (currentEpoch !== epoch) return;
        if (typeof data !== 'string' || encodeBytes(data) > FRAME_LIMIT) {
          shutdown('Gatewayから不正なデータを受信');
          return;
        }
        let message;
        try {
          message = JSON.parse(data);
        } catch {
          shutdown('不正なGateway応答');
          return;
        }
        if (!isRecord(message)) {
          shutdown('不正なGateway応答');
          return;
        }
        if (
          phase === 'connecting' &&
          message.type === 'challenge' &&
          Object.keys(message).length === 2 &&
          validId(message.nonce) &&
          !nonce
        ) {
          nonce = message.nonce;
          try {
            ws.send(JSON.stringify({ type: 'pair', nonce, csrfToken: proof.csrfToken }));
          } catch {
            shutdown('Gateway認証に失敗');
          }
          return;
        }
        if (
          phase === 'connecting' &&
          message.type === 'paired' &&
          Object.keys(message).length === 3 &&
          message.nonce === nonce &&
          message.clientLabel === recipient?.clientLabel &&
          getLocalGrant()?.sessionId === connectedSessionId &&
          signature(getLocalGrant()) === connectedSignature &&
          proof.expiresAtMs > Date.now() &&
          recipientStillAuthorized()
        ) {
          try {
            const identity = Object.freeze({
              windowId: tabId,
              clientId: recipient.clientId,
              connectionId: randomId(),
            });
            if (!validId(identity.connectionId)) throw Error('BAD_ID');
            gate = readGateFactory({ controlApi, windowId: tabId });
            gate.authorizeFromTrustedUi({
              ...identity,
              approvedWindowId: tabId,
              sessionId: connectedSessionId,
            });
            protocol = protocolFactory({
              readGate: gate,
              context: identity,
              onClose: () => {
                if (phase === 'sharing') shutdown('読取権限が失効しました');
              },
            });
            phase = 'sharing';
            if (timer !== null) cancel(timer);
            timer = schedule(
              () => shutdown('外部読取許可が終了しました'),
              Math.min(60000, proof.expiresAtMs - Date.now(), recipient.expiresAtMs - Date.now()),
            );
            status.textContent = `${recipient.clientLabel}と読取共有中（最大60秒）`;
            refresh();
          } catch {
            shutdown('Document Controlの外部読取承認に失敗');
          }
          return;
        }
        if (
          phase === 'sharing' &&
          message.type === 'request' &&
          Object.keys(message).length === 2 &&
          typeof message.payload === 'string'
        ) {
          try {
            if (
              !recipientStillAuthorized() ||
              getLocalGrant()?.sessionId !== connectedSessionId ||
              signature(getLocalGrant()) !== connectedSignature
            )
              throw Error('STALE_DOCUMENT');
            const reply = protocol.acceptFrame(message.payload);
            if (currentEpoch === epoch && ws.readyState === 1)
              ws.send(JSON.stringify({ type: 'response', payload: reply }));
          } catch {
            shutdown('無承認または失効した要求を拒否');
          }
          return;
        }
        shutdown('無承認または不正なGateway要求を拒否');
      });
      ws.addEventListener('close', () => {
        if (currentEpoch === epoch) shutdown('Gatewayが切断されました');
      });
      ws.addEventListener('error', () => {
        if (currentEpoch === epoch) shutdown('Gateway接続エラー');
      });
    } catch {
      if (currentEpoch === epoch) shutdown('安全なGateway接続を開始できませんでした');
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
    revoke: () => shutdown('Web側の読取許可が解除されました'),
    dispose() {
      if (disposed) return;
      shutdown();
      disposed = true;
      windowLike.removeEventListener?.('pagehide', pageHide);
      wrapper.remove();
    },
  });
}
