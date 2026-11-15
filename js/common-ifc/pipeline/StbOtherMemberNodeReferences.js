/**
 * Validate references to emitted StbNodes for non-beam, non-surface members.
 * ST-Bridge 2.1 XSD checks positive-integer syntax but does not enforce these
 * structural cross-references. Do not invent a node to satisfy a reference.
 *
 * Call after validateStbNodeRecords. The lexical ID in the output is unchanged:
 * 1, 001 and +001 refer to the same positive-integer node.
 */
const REFERENCE_FIELDS = {
  StbColumn: [
    ['nodeStart', 'id_node_bottom'],
    ['nodeEnd', 'id_node_top'],
  ],
  StbPost: [
    ['nodeStart', 'id_node_bottom'],
    ['nodeEnd', 'id_node_top'],
  ],
  StbBrace: [
    ['nodeStart', 'id_node_start'],
    ['nodeEnd', 'id_node_end'],
  ],
  StbFooting: [['nodeStart', 'id_node']],
  StbPile: [['nodeSingle', 'id_node']],
  StbFoundationColumn: [['nodeStart', 'id_node']],
};

function positiveNodeId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const token = String(value).trim();
  if (!/^\+?\d+$/.test(token)) return null;
  const id = BigInt(token);
  return id > 0n ? id.toString() : null;
}

export function validateOtherMemberNodeReferences(nodes, elements) {
  const known = new Set(nodes.map((node) => positiveNodeId(node.id)));
  for (const element of elements) {
    const fields = REFERENCE_FIELDS[element?.stbType];
    if (!fields) continue;
    // The serializer independently rejects STB 2.0 two-node pile topology.
    // Never let this reference check mask that informative conversion error.
    if (element.stbType === 'StbPile' && element.pileFormat !== '1node') continue;
    for (const [field, attribute] of fields) {
      const canonical = positiveNodeId(element[field]);
      if (!canonical) {
        throw new Error(`${element.stbType} ${element.id}: invalid ${attribute} node reference`);
      }
      if (!known.has(canonical)) {
        throw new Error(
          `${element.stbType} ${element.id}: ${attribute} references missing node ${String(element[field]).trim()}`,
        );
      }
    }
  }
}
