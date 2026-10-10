/** @fileoverview DrawingModel.dimensionIntents -> shared DrawingRenderPlan dimension groups. */
import { assertMatrix } from './affine2d.js';
import { resolveDimensionFamily } from './dimensions/dimensionFamilyRegistry.js';
import { compileDimensionIntent } from './dimensions/dimensionRenderPlanCompiler.js';

function sourceRefKey(sourceRef) {
  return JSON.stringify([String(sourceRef?.elementType), String(sourceRef?.elementId)]);
}

function normalizeDrawingDimensionReferences(drawing) {
  const input = drawing?.dimensionReferences ?? [];
  if (!Array.isArray(input))
    throw new TypeError('DrawingModel.dimensionReferencesは配列が必要です。');
  const byId = new Map();
  const sourceKeys = new Set();
  for (const [index, reference] of input.entries()) {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference))
      throw new TypeError(`DrawingModel.dimensionReferences[${index}]が不正です。`);
    if (reference.kind !== 'axis' || reference.axisKind !== 'parallel')
      throw new TypeError(
        `未対応のDrawingModel dimension referenceです: ${String(reference.kind)}`,
      );
    if (typeof reference.id !== 'string' || !reference.id)
      throw new TypeError(`DrawingModel.dimensionReferences[${index}].idが必要です。`);
    if (
      !['x', 'y'].includes(reference.coordinateKey) ||
      !Number.isFinite(reference.coordinateValue)
    )
      throw new TypeError(`DrawingModel.dimensionReferences[${index}]の座標が不正です。`);
    if (
      String(reference.sourceRef?.elementType) !== 'ParallelAxis' ||
      reference.sourceRef?.elementId == null ||
      !String(reference.sourceRef.elementId).trim()
    )
      throw new TypeError(`DrawingModel.dimensionReferences[${index}].sourceRefが不正です。`);
    if (byId.has(reference.id))
      throw new TypeError(`DrawingModel dimension reference idが重複しています: ${reference.id}`);
    const key = sourceRefKey(reference.sourceRef);
    if (sourceKeys.has(key))
      throw new TypeError(`DrawingModel dimension sourceRefが重複しています: ${key}`);
    byId.set(reference.id, reference);
    sourceKeys.add(key);
  }
  return byId;
}

export function createDrawingDimensionReferenceResolver(drawing) {
  const references = normalizeDrawingDimensionReferences(drawing);
  const bounds = drawing?.bounds;
  if (
    bounds != null &&
    ![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)
  )
    throw new TypeError('DrawingModel.boundsが不正です。');
  return (reference) => {
    if (reference?.kind !== 'axis') return null;
    const resolved = references.get(reference.axisId);
    if (!resolved)
      throw new Error(`DrawingModel dimension referenceがありません: ${reference.axisId}`);
    if (!bounds) throw new Error('通り芯寸法の解決にDrawingModel.boundsが必要です。');
    return {
      point:
        resolved.coordinateKey === 'x'
          ? [resolved.coordinateValue, bounds.minY]
          : [bounds.minX, resolved.coordinateValue],
      sourceRef: resolved.sourceRef,
    };
  };
}

/**
 * STB由来のDimensionIntentを共通RenderPlanへcompileする。
 *
 * 現段階ではbuilt-in DimensionFamilyのみを解決する。
 * user family persistence/store接続はDrawingProject側の後続境界で扱う。
 */
export function compileDrawingRenderDimensions({
  drawing,
  modelToPaper: modelToPaperInput,
  displaySettings = {},
} = {}) {
  const intents = drawing?.dimensionIntents ?? [];
  if (!Array.isArray(intents))
    throw new TypeError('DrawingModel.dimensionIntentsは配列が必要です。');
  const modelToPaper = Object.freeze([...assertMatrix(modelToPaperInput)]);
  const visible = displaySettings?.visibility?.Axis !== false;
  const intentIds = new Set();
  const resolveReference = createDrawingDimensionReferenceResolver(drawing);

  return Object.freeze(
    intents.map((intent) => {
      if (intentIds.has(intent?.id))
        throw new TypeError(`DimensionIntent idが重複しています: ${String(intent?.id)}`);
      intentIds.add(intent?.id);
      const family = resolveDimensionFamily(intent?.familyId);
      const compiled = compileDimensionIntent({
        intent,
        family,
        familyBuiltIn: true,
        modelToPaper,
        resolveReference,
      });
      return Object.freeze({
        id: `dimension:${compiled.intent.id}`,
        intentId: compiled.intent.id,
        familyId: compiled.familyId,
        layerId: 'Annotation',
        visibilitySource: 'Axis',
        visible,
        primitives: compiled.primitives,
      });
    }),
  );
}
