/** @fileoverview 図面データの参照・ビュー契約。DOM/sceneを持たない。 */
export function createElementRef(source, elementType, elementId, guid = null) {
  const modelKey = source?.modelKey;
  if (
    typeof modelKey !== 'string' ||
    !modelKey.trim() ||
    typeof elementType !== 'string' ||
    !elementType.trim() ||
    elementId == null ||
    !String(elementId).trim()
  ) {
    throw new TypeError('モデル・要素種別・部材IDが必要です。');
  }
  return Object.freeze({
    modelKey,
    elementType,
    elementId: String(elementId),
    guid: guid == null ? null : String(guid),
  });
}

export function elementRefKey(ref) {
  const valid = createElementRef(ref, ref?.elementType, ref?.elementId, ref?.guid);
  // 区切り文字を含むIDでも衝突しない。符号やGUIDだけをキーにしない。
  return JSON.stringify([valid.modelKey, valid.elementType, valid.elementId]);
}

export function normalizePlanView(view) {
  if (!view || view.type !== 'plan' || typeof view.storyId !== 'string' || !view.storyId.trim())
    throw new TypeError('平面図と対象階を明示してください。');
  const { baseZ, lowerZ, upperZ, verticalCutOffset } = view;
  if (
    ![baseZ, lowerZ, upperZ, verticalCutOffset].every(Number.isFinite) ||
    lowerZ >= upperZ ||
    baseZ < lowerZ ||
    baseZ > upperZ ||
    verticalCutOffset < 0
  )
    throw new RangeError('階レベル・階範囲・鉛直部材切断高さが不正です。');
  return Object.freeze({
    type: 'plan',
    storyId: view.storyId,
    baseZ,
    lowerZ,
    upperZ,
    verticalCutOffset,
    cutPolicyKey: 'sdv-story-plan-v1',
    units: 'mm',
  });
}

export function normalizeDrawingSource(source) {
  if (
    typeof source?.modelKey !== 'string' ||
    !source.modelKey.trim() ||
    typeof source.modelRevision !== 'string' ||
    !source.modelRevision.trim()
  )
    throw new TypeError('モデル識別子と改訂を明示してください。');
  return Object.freeze({ modelKey: source.modelKey, modelRevision: source.modelRevision });
}

export function createEmptyDrawing(source, view) {
  return {
    schemaVersion: 1,
    units: 'mm',
    source: normalizeDrawingSource(source),
    view: normalizePlanView(view),
    primitives: [],
    annotations: [],
    elements: [],
    diagnostics: [],
    bounds: null,
  };
}
