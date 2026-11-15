import { validateBeamRequiredAttrs } from './StbBeamRequiredAttrs.js';

/**
 * XML Schema checks positive integer syntax, but does not enforce that girder
 * and beam endpoint IDs actually refer to an emitted StbNode.  Reject dangling
 * references before publishing apparently XSD-valid structural geometry.
 * Distinct lexical forms of the same positive integer remain unchanged in XML.
 */
export function validateBeamNodeReferences(nodes, elements) {
  const known = new Set(nodes.map((node) => BigInt(String(node.id).trim()).toString()));
  for (const element of elements) {
    if (element.stbType !== 'StbGirder' && element.stbType !== 'StbBeam') continue;
    validateBeamRequiredAttrs(element);
    for (const [field, attribute] of [
      ['nodeStart', 'id_node_start'],
      ['nodeEnd', 'id_node_end'],
    ]) {
      const token = String(element[field]).trim();
      if (!known.has(BigInt(token).toString())) {
        throw new Error(
          `${element.stbType} ${element.id}: ${attribute} references missing node ${token}`,
        );
      }
    }
  }
}
