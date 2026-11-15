/**
 * ST-Bridge 2.1 required attributes for columns, posts and braces.
 * A missing IFC-origin section or structural classification is not replaced by
 * a guessed S member merely to produce syntactically valid XML.
 */
const COLUMN_KINDS = new Set(['RC', 'S', 'SRC', 'CFT', 'UNDEFINED']);
const BRACE_KINDS = new Set(['RC', 'S', 'SRC']);

function isPositiveId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return false;
  const token = String(value).trim();
  return /^\+?\d+$/.test(token) && BigInt(token) > 0n;
}

export function validateLineMemberRequiredAttrs(element) {
  const tag = element?.stbType;
  const column = tag === 'StbColumn' || tag === 'StbPost';
  if (!column && tag !== 'StbBrace') {
    throw new TypeError('Expected ST-Bridge StbColumn, StbPost or StbBrace');
  }
  const label = `${tag} ${element.id ?? '(unknown)'}`;
  for (const [field, attr] of [
    ['id', 'id'],
    ['nodeStart', column ? 'id_node_bottom' : 'id_node_start'],
    ['nodeEnd', column ? 'id_node_top' : 'id_node_end'],
    ['sectionId', 'id_section'],
  ]) {
    if (!isPositiveId(element[field])) {
      throw new Error(`${label}: missing or invalid required ${attr}`);
    }
  }
  if (!(column ? COLUMN_KINDS : BRACE_KINDS).has(element.kindStructure)) {
    throw new Error(`${label}: missing or unsupported kind_structure`);
  }
}
