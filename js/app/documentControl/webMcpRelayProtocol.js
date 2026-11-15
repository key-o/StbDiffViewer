/**
 * #533 Web MCP relay protocol boundary (not a WebSocket connection manager).
 *
 * The caller MUST authenticate its WSS relay and peer, obtain a separate real
 * user approval, and create/authorize a transport-independent read gate before
 * constructing this object. It MUST pass immutable, trusted connection metadata;
 * no field from a remote JSON-RPC frame may become a client/window/connection ID.
 *
 * The gateway owns MCP initialize, tools/list and HTTP transport. Only a
 * read-only tools/call can cross this boundary. This module opens no socket,
 * installs no global hook, and cannot approve any document or file access.
 */
const MAX_FRAME_BYTES = 16384;
const MAX_RESPONSE_BYTES = 65536;
const MAX_CALLS = 256;
const TERMINAL_ERRORS = new Set([
  'NOT_APPROVED',
  'WRONG_CONNECTION',
  'APPROVAL_EXPIRED',
  'GATE_DISPOSED',
  'STALE_SESSION',
  'STALE_DOCUMENTS',
]);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128;
const encodedLength = (value) => new TextEncoder().encode(value).length;
const hasOnly = (object, keys) => Object.keys(object).every((key) => keys.includes(key));

export class WebMcpRelayProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WebMcpRelayProtocolError';
    this.code = code;
  }
}

/**
 * @param {object} options
 * @param {object} options.readGate - Already authorized by a trusted UI interaction.
 * @param {object} options.context - Connection identity from an authenticated relay,
 *   NEVER parsed from JSON-RPC input.
 * @param {Function} [options.onClose] - Transport owner should tear down the socket.
 */
export function createWebMcpRelayProtocol({ readGate, context, onClose = () => {} } = {}) {
  if (
    typeof readGate?.handleRequestFromAuthenticatedIpc !== 'function' ||
    typeof readGate?.revokeFromTrustedUi !== 'function' ||
    !isRecord(context) ||
    ![context.windowId, context.clientId, context.connectionId].every(validId) ||
    typeof onClose !== 'function'
  ) {
    throw new WebMcpRelayProtocolError('INVALID_SETUP');
  }

  const verifiedContext = Object.freeze({
    windowId: context.windowId,
    clientId: context.clientId,
    connectionId: context.connectionId,
  });
  const seenIds = new Set();
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    readGate.revokeFromTrustedUi();
    onClose();
  }

  function fatal(code) {
    close();
    throw new WebMcpRelayProtocolError(code);
  }

  function reply(id, payload) {
    const serialized = JSON.stringify({ jsonrpc: '2.0', id, ...payload });
    if (encodedLength(serialized) > MAX_RESPONSE_BYTES) fatal('RESPONSE_TOO_LARGE');
    return serialized;
  }

  function acceptFrame(frame) {
    if (closed) throw new WebMcpRelayProtocolError('CONNECTION_CLOSED');
    if (typeof frame !== 'string' || encodedLength(frame) > MAX_FRAME_BYTES) fatal('INVALID_FRAME');

    let incoming;
    try {
      incoming = JSON.parse(frame);
    } catch {
      fatal('INVALID_FRAME');
    }
    if (
      !isRecord(incoming) ||
      !hasOnly(incoming, ['jsonrpc', 'id', 'method', 'params']) ||
      incoming.jsonrpc !== '2.0' ||
      (typeof incoming.id !== 'string' && !Number.isSafeInteger(incoming.id)) ||
      (typeof incoming.id === 'string' && (!incoming.id || incoming.id.length > 128)) ||
      incoming.method !== 'tools/call' ||
      !isRecord(incoming.params) ||
      !hasOnly(incoming.params, ['name', 'arguments']) ||
      typeof incoming.params.name !== 'string' ||
      !isRecord(incoming.params.arguments ?? {})
    ) {
      fatal('INVALID_FRAME');
    }

    const idKey = typeof incoming.id + ':' + incoming.id;
    if (seenIds.has(idKey) || seenIds.size >= MAX_CALLS) fatal('REPLAY_OR_REQUEST_LIMIT');
    seenIds.add(idKey);

    try {
      // The gate supplies its own private session ID and validates documents,
      // revisions, the original approval and lease at the disclosure boundary.
      const result = readGate.handleRequestFromAuthenticatedIpc(verifiedContext, {
        tool: incoming.params.name,
        arguments: incoming.params.arguments ?? {},
      });
      return reply(incoming.id, {
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      });
    } catch (error) {
      if (error instanceof WebMcpRelayProtocolError) throw error;
      const code = typeof error?.code === 'string' ? error.code : 'READ_DENIED';
      if (TERMINAL_ERRORS.has(code)) fatal('ACCESS_REVOKED');
      // Fixed error codes only; never relay arbitrary exception or file details.
      return reply(incoming.id, {
        result: { isError: true, content: [{ type: 'text', text: 'READ_DENIED' }] },
      });
    }
  }

  return Object.freeze({ acceptFrame, close });
}
