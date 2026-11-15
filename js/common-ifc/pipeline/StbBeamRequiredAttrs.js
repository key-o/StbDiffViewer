/**
 * ST-Bridge 2.1 Girder attribute group is shared by StbGirder and StbBeam.
 * The original IFC must establish the actual foundation flag; an omitted
 * value cannot be converted to a guessed false just to satisfy the schema.
 */
const STRUCTURE_KINDS = new Set(['RC', 'S', 'SRC', 'UNDEFINED']);

function isPositiveId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return false;
  const lexical = String(value).trim();
  return /^[+]?[0-9]+$/.test(lexical) && BigInt(lexical) > 0n;
}

export function validateBeamRequiredAttrs(element) {
  const tag = element?.stbType;
  if (tag !== 'StbBeam' && tag !== 'StbGirder') {
    throw new TypeError('Expected an ST-Bridge StbBeam or StbGirder element');
  }
  const label = `${tag} ${element.id ?? '(unknown)'}`;
  for (const [field, attr] of [
    ['id', 'id'],
    ['nodeStart', 'id_node_start'],
    ['nodeEnd', 'id_node_end'],
    ['sectionId', 'id_section'],
  ]) {
    if (!isPositiveId(element[field])) {
      throw new Error(`${label}: missing or invalid required ${attr}`);
    }
  }
  if (!STRUCTURE_KINDS.has(element.kindStructure)) {
    throw new Error(`${label}: missing or unsupported kind_structure`);
  }
  if (typeof element.isFoundation !== 'boolean') {
    throw new Error(`${label}: missing isFoundation; IFC source evidence required`);
  }
}
