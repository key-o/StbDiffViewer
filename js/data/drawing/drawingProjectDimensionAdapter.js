/**
 * #423 Convert persisted axis bindings into native DrawingRenderPlan dimensions.
 * Each binding is resolved for the exact DrawingDocument source revision against
 * actual DrawingModel axis references. Never infer coordinates from a saved ID.
 */
import { compileDimensionIntent } from './dimensions/dimensionRenderPlanCompiler.js';
import { resolveDimensionFamily } from './dimensions/dimensionFamilyRegistry.js';
import { createDrawingDimensionReferenceResolver } from './drawingRenderPlanDimensions.js';

const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 1, 0, 0]);

function revisionBinding(project, document, entityId) {
  const binding = project.bindings?.find((item) => item.entityId === entityId);
  if (!binding || binding.modelSlotId !== document.modelSlotId)
    throw new Error('保存寸法のバインディングがSTBモデルにありません: ' + entityId);
  const revision = binding.revisions?.find(
    (item) => item.sourceRevisionId === document.sourceRevisionId,
  );
  if (revision?.orphaned || revision?.sourceRef?.elementType !== 'ParallelAxis')
    throw new Error('保存寸法の現行通り芯を解決できません: ' + entityId);
  return revision.sourceRef;
}

function axisKey(ref) {
  return JSON.stringify([ref?.elementType, String(ref?.elementId)]);
}

/**
 * Compute native dimension groups for a persisted DrawingDocument.
 * Works in model-mm / paper-mm only. In particular, an elevation without
 * the corresponding DrawingModel axis references is rejected (never guessed).
 * Pass [1,0,0,1,0,0] to run a no-UI preflight during ZIP cold-start.
 */
export function compilePersistedDrawingDimensions({
  project,
  document,
  drawing,
  modelToPaper = IDENTITY_MATRIX,
} = {}) {
  const intents = document?.dimensionIntents ?? [];
  if (!Array.isArray(intents)) throw new TypeError('保存寸法の形式が不正です。');
  if (intents.length === 0) return Object.freeze([]);
  const slot = project?.modelSlots?.find((item) => item.id === document.modelSlotId);
  const revision = slot?.revisions?.find((item) => item.id === document.sourceRevisionId);
  if (
    !revision ||
    slot.currentRevisionId !== revision.id ||
    drawing?.source?.modelKey !== 'A' ||
    ![revision.id.toLowerCase(), revision.sha256.toLowerCase()].includes(
      String(drawing.source?.modelRevision ?? '').toLowerCase(),
    )
  )
    throw new Error('保存寸法とDrawingModelのSTB改訂が一致しません。');

  const axes = drawing.dimensionReferences;
  if (!Array.isArray(axes)) throw new Error('DrawingModelに寸法用通り芯参照がありません。');
  const axesBySourceRef = new Map();
  for (const axis of axes) {
    if (
      axis?.kind !== 'axis' ||
      axis.axisKind !== 'parallel' ||
      axis.sourceRef?.elementType !== 'ParallelAxis'
    )
      continue;
    const key = axisKey(axis.sourceRef);
    if (axesBySourceRef.has(key))
      throw new Error('DrawingModelの通り芯参照が重複しています: ' + key);
    axesBySourceRef.set(key, axis);
  }
  const resolveAxis = createDrawingDimensionReferenceResolver(drawing);
  const compiled = intents.map((storedIntent, index) => {
    const axisReferences = storedIntent.references.map((reference) => {
      if (reference?.kind !== 'axis-binding')
        throw new Error('保存寸法に未対応の参照形式があります: ' + storedIntent.id);
      const sourceRef = revisionBinding(project, document, reference.binding?.entityId);
      const axis = axesBySourceRef.get(axisKey(sourceRef));
      if (
        !axis ||
        (sourceRef.guid != null && String(sourceRef.guid) !== String(axis.sourceRef.guid))
      )
        throw new Error(
          '保存寸法の通り芯と現在の描画参照が一致しません: ' + reference.binding.entityId,
        );
      return { kind: 'axis', axisId: axis.id };
    });
    // Namespace the compiler ID per sheet view, without copying untrusted IDs
    // into the native DimensionIntent safe-identifier field.
    const nativeIntent = {
      schemaVersion: 1,
      id: 'persisted:' + index,
      kind: storedIntent.kind,
      references: axisReferences,
      placement: storedIntent.placement,
      familyId: storedIntent.familyId,
    };
    const family = resolveDimensionFamily(storedIntent.familyId);
    const result = compileDimensionIntent({
      intent: nativeIntent,
      family,
      familyBuiltIn: true,
      modelToPaper,
      resolveReference: resolveAxis,
    });
    return Object.freeze({
      id: 'project-dimension:' + document.id + ':' + storedIntent.id,
      intentId: storedIntent.id,
      familyId: result.familyId,
      layerId: 'Annotation',
      visibilitySource: 'Axis',
      visible: document.display?.visibility?.Axis !== false,
      primitives: result.primitives,
    });
  });
  return Object.freeze(compiled);
}
