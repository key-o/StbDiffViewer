/**
 * @fileoverview STB-A is the only editable drawing source. STB-B is a read-only reference.
 *
 * A/B identities are UI roles and must not be interpreted as interchangeable DXF origins.
 * Keep the Working Document gate until a consistent editing snapshot can be compiled.
 */
function isStbDocument(document) {
  return document?.nodeType === 9 && document.documentElement?.localName === 'ST_BRIDGE';
}

/** Resolve the primary source for story-plan SVG/DXF export without inspecting scene state. */
export function resolvePrimaryDrawingSource({ documentA, documentB, editingActive = false } = {}) {
  if (editingActive) {
    return {
      reason: '編集中の全階DXF出力は未対応です。Working Documentを確定してから出力してください。',
      allowLegacyFallback: false,
    };
  }
  if (!isStbDocument(documentA)) {
    return {
      reason: '編集元STB-Aがありません。参照用STB-Bだけからは図面を出力できません。',
      allowLegacyFallback: false,
    };
  }
  return {
    modelKey: 'A',
    document: documentA,
    // Legacy exporters consume the current scene and can accidentally include B geometry.
    referenceModelBPresent: documentB?.nodeType === 9,
  };
}
