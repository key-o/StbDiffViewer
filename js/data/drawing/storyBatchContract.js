/** @fileoverview #424 全階DXFのDrawingRenderPlan移行範囲を表すpure契約。 */

export const STORY_BATCH_RENDER_ELEMENT_TYPES = Object.freeze([
  'Column',
  'Post',
  'Girder',
  'Beam',
  'Brace',
  'Slab',
  'Wall',
  'Footing',
  'StripFooting',
  'Pile',
  'Parapet',
  'Open',
]);

export function getUnsupportedStoryBatchElementTypes(selectedElementTypes) {
  if (!Array.isArray(selectedElementTypes)) return [];
  const supported = new Set(STORY_BATCH_RENDER_ELEMENT_TYPES);
  return selectedElementTypes.map(String).filter((type) => !supported.has(type));
}

export function canCompileStoryBatchSelection(selectedElementTypes) {
  if (!Array.isArray(selectedElementTypes) || selectedElementTypes.length === 0) {
    return { canCompile: false, reason: 'エクスポートする部材種別を1つ以上指定してください。' };
  }
  const selected = selectedElementTypes.map(String);
  const unsupported = getUnsupportedStoryBatchElementTypes(selected);
  if (unsupported.length > 0) {
    return {
      canCompile: false,
      reason: `DrawingRenderPlan未移行の部材種別が含まれます: ${unsupported.join(', ')}`,
    };
  }
  return { canCompile: true, reason: '' };
}

/** Openのみ選択された場合、親Wallは外形を描かず開口の抽出元としてのみ使う。 */
export function isOpenOnlyStoryBatchSelection(selectedElementTypes) {
  if (!Array.isArray(selectedElementTypes)) return false;
  const selected = selectedElementTypes.map(String);
  return selected.includes('Open') && !selected.includes('Wall');
}

export function createStoryBatchDisplaySettings(selectedElementTypes, { includeAxes = true } = {}) {
  if (!Array.isArray(selectedElementTypes)) {
    throw new TypeError('selectedElementTypesは配列で指定してください。');
  }
  const selected = new Set(selectedElementTypes.map(String));
  const visibility = Object.fromEntries(
    STORY_BATCH_RENDER_ELEMENT_TYPES.map((type) => [type, selected.has(type)]),
  );
  visibility.Axis = includeAxes !== false;
  return Object.freeze({
    visibility: Object.freeze(visibility),
  });
}
