/**
 * Human-readable, local-only description of the exact Document Control scope
 * shown before a separate Web MCP sharing click. Never serialize a sessionId,
 * raw STB/XML or a filesystem path into the relay transport.
 */
const MAX_ITEMS = 5;
const MAX_NAME = 100;

export function hasWebMcpShareScope(grant) {
  return (
    typeof grant?.sessionId === 'string' &&
    grant.sessionId.length > 0 &&
    Array.isArray(grant.documents) &&
    grant.documents.length > 0
  );
}

export function formatWebMcpShareScope(documents) {
  if (!Array.isArray(documents) || documents.length === 0) return '共有対象: なし';
  const labels = documents.slice(0, MAX_ITEMS).map((entry) => {
    if (!entry || typeof entry !== 'object') return '不明な対象';
    const type =
      entry.kind === 'drawing-project'
        ? '図面プロジェクト'
        : entry.kind === 'stb-working'
          ? `モデル${['A', 'B'].includes(entry.slot) ? entry.slot : '?'} Working`
          : `モデル${['A', 'B'].includes(entry.slot) ? entry.slot : '?'} Source`;
    const name = entry.kind === 'drawing-project' ? entry.projectId : entry.name;
    const label = typeof name === 'string' && name ? name.slice(0, MAX_NAME) : '名称未設定';
    return `${type}: ${label}`;
  });
  const remaining = documents.length - labels.length;
  return `共有対象（${documents.length}件）: ${labels.join(' / ')}${remaining ? ` / ほか${remaining}件` : ''}`;
}
