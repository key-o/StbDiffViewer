/**
 * @fileoverview DrawingProjectの永続tag intentを現行DrawingRenderPlan compileへ接続するpure adapter。
 *
 * RenderPlanは派生物のままにし、project側のmodel/paper配置意図をcompile時だけmodel-mmへ解決する。
 */
import { assertMatrix, invertAffine, transformPoint } from './affine2d.js';
import { normalizeDrawingProject } from './drawingProjectSchema.js';
import { pointOnMemberAxis } from './memberAxisAnchor.js';
import { resolveDimensionFamily } from './dimensions/dimensionFamilyRegistry.js';
import { normalizeDimensionIntent } from './dimensions/dimensionIntentDefinition.js';
import { compileDimensionIntent } from './dimensions/dimensionRenderPlanCompiler.js';
import { createDrawingDimensionReferenceResolver } from './drawingRenderPlanDimensions.js';

function requiredString(value, name) {
  if (value == null || !String(value).trim()) throw new TypeError(name + 'が必要です。');
  return String(value).trim();
}

function transformVector(matrix, vector) {
  const [a, b, c, d] = matrix;
  const [x, y] = vector;
  const result = [a * x + c * y, b * x + d * y];
  if (!result.every(Number.isFinite))
    throw new TypeError('DrawingProject tag offset変換が不正です。');
  return result;
}

function sourceRefMatches(left, right) {
  return (
    String(left?.elementType) === String(right?.elementType) &&
    String(left?.elementId) === String(right?.elementId) &&
    (left?.guid == null || String(left.guid) === String(right?.guid))
  );
}

function documentById(project, drawingId) {
  const document = project.drawingDocuments.find((item) => item.id === drawingId);
  if (!document) throw new Error('DrawingDocumentがありません: ' + drawingId);
  return document;
}

function bindingIndex(project, document) {
  const index = new Map();
  for (const binding of project.bindings) {
    if (binding.modelSlotId !== document.modelSlotId) continue;
    const revision = binding.revisions.find(
      (item) => item.sourceRevisionId === document.sourceRevisionId,
    );
    if (!revision?.sourceRef) continue;
    const key = JSON.stringify([revision.sourceRef.elementType, revision.sourceRef.elementId]);
    if (index.has(key)) throw new Error('同一STB sourceRefへ複数entityIdが対応しています: ' + key);
    index.set(key, { binding, sourceRef: revision.sourceRef });
  }
  return index;
}

function bindingByEntityId(project, document) {
  const result = new Map();
  for (const binding of project.bindings) {
    if (binding.modelSlotId !== document.modelSlotId) continue;
    const revision = binding.revisions.find(
      (item) => item.sourceRevisionId === document.sourceRevisionId,
    );
    if (!revision?.sourceRef) continue;
    result.set(binding.entityId, { binding, sourceRef: revision.sourceRef });
  }
  return result;
}

function drawingDimensionReferenceBySourceRef(drawing) {
  const result = new Map();
  for (const [index, reference] of (drawing?.dimensionReferences || []).entries()) {
    if (reference?.sourceRef?.elementId == null)
      throw new TypeError(`DrawingModel.dimensionReferences[${index}].sourceRefが不正です。`);
    const key = JSON.stringify([
      String(reference.sourceRef.elementType),
      String(reference.sourceRef.elementId),
    ]);
    if (result.has(key))
      throw new Error('DrawingModel dimension sourceRefが重複しています: ' + key);
    result.set(key, reference);
  }
  return result;
}

function intentsForContext(document, mapped, context) {
  const templateId = String(context?.template?.id || '');
  const templateVersion = Number(context?.template?.version);
  return document.tagIntents.filter(
    (item) =>
      item.binding.entityId === mapped.binding.entityId &&
      item.template.id === templateId &&
      item.template.version === templateVersion,
  );
}

function memberAnchorModel(intent, context) {
  const anchor = intent.binding.anchor;
  if (!anchor) throw new Error('follow-member tag intentにsemantic anchorがありません。');
  if (anchor.kind === 'member-bounds-center') {
    if (!Array.isArray(context?.memberAnchorModel) || context.memberAnchorModel.length !== 2)
      throw new Error('member-bounds-centerの解決にDrawingRenderPlan element anchorが必要です。');
    return [...context.memberAnchorModel];
  }
  if (anchor.kind === 'member-axis') {
    if (!context?.memberAxisModel) {
      throw new Error(
        'member-axis semantic anchorを解決できるmember axisがありません。未解決経路をbounds centerへ黙って近似しません。',
      );
    }
    return pointOnMemberAxis(context.memberAxisModel, anchor.stationRatio);
  }
  throw new Error('未対応のsemantic anchorです: ' + anchor.kind);
}

function placementForIntent(intent, context, paperToModel) {
  const rotationDeg = intent.placement.orientation.rotationDeg;
  const leader = intent.placement.leader;
  const instanceId = requiredString(intent.id, 'tag intent id');

  if (intent.placement.mode === 'model-fixed') {
    return {
      instanceId,
      anchorModel: [...intent.placement.origin.xy],
      offsetModel: [0, 0],
      rotationDeg,
      leader,
    };
  }

  if (intent.placement.mode === 'paper-fixed') {
    return {
      instanceId,
      anchorModel: transformPoint(paperToModel, intent.placement.origin.xy),
      offsetModel: [0, 0],
      rotationDeg,
      leader,
    };
  }

  if (intent.placement.mode === 'follow-member') {
    const anchorModel = memberAnchorModel(intent, context);
    const offsetModel = transformVector(paperToModel, intent.placement.offset.xy);
    return { instanceId, anchorModel, offsetModel, rotationDeg, leader };
  }

  throw new Error('未対応のDrawingProject tag placement modeです: ' + intent.placement.mode);
}

/**
 * @returns {(context: Object) => Object|Object[]|null}
 */
export function createDrawingProjectTagPlacementResolver({
  project,
  drawingId,
  modelToPaper,
} = {}) {
  const normalized = normalizeDrawingProject(project);
  const document = documentById(normalized, requiredString(drawingId, 'drawingId'));
  if (!Array.isArray(modelToPaper) || modelToPaper.length !== 6)
    throw new TypeError('DrawingProject tag解決にはmodelToPaper行列が必要です。');
  const paperToModel = invertAffine(modelToPaper);
  const bindings = bindingIndex(normalized, document);
  return (context) => {
    const key = JSON.stringify([
      String(context?.ref?.elementType),
      String(context?.ref?.elementId),
    ]);
    const mapped = bindings.get(key);
    if (!mapped) return null;
    if (!sourceRefMatches(mapped.sourceRef, context.ref))
      throw new Error('DrawingProject bindingのsourceRefがDrawingModelと一致しません: ' + key);
    const intents = intentsForContext(document, mapped, context);
    if (intents.length === 0) return null;
    const placements = intents.map((intent) => placementForIntent(intent, context, paperToModel));
    return placements.length === 1 ? placements[0] : placements;
  };
}

/**
 * DrawingProjectのpersistent dimension bindingを現行DrawingModelのsemantic axisへ再解決し、
 * 同じDimensionIntent compilerへ接続する。BindingRegistryが改訂ごとのsourceRef差を吸収する。
 */
export function compileDrawingProjectDimensions({
  project,
  drawingId,
  drawing,
  modelToPaper: modelToPaperInput,
  displaySettings = {},
} = {}) {
  const normalized = normalizeDrawingProject(project);
  const document = documentById(normalized, requiredString(drawingId, 'drawingId'));
  const modelToPaper = Object.freeze([...assertMatrix(modelToPaperInput)]);
  if (!Array.isArray(document.dimensionIntents) || document.dimensionIntents.length === 0)
    return Object.freeze([]);

  const bindings = bindingByEntityId(normalized, document);
  const currentReferences = drawingDimensionReferenceBySourceRef(drawing);
  const resolveReference = createDrawingDimensionReferenceResolver(drawing);
  const visible = displaySettings?.visibility?.Axis !== false;

  return Object.freeze(
    document.dimensionIntents.map((persistent) => {
      const runtimeReferences = persistent.references.map((reference, index) => {
        const mapped = bindings.get(reference.binding.entityId);
        if (!mapped)
          throw new Error(
            `Dimension bindingを現行revisionへ解決できません: ${reference.binding.entityId}`,
          );
        const sourceKey = JSON.stringify([
          String(mapped.sourceRef.elementType),
          String(mapped.sourceRef.elementId),
        ]);
        const current = currentReferences.get(sourceKey);
        if (!current)
          throw new Error(
            `DrawingModelにDimension binding参照がありません: ${persistent.id}[${index}] ${sourceKey}`,
          );
        if (!sourceRefMatches(mapped.sourceRef, current.sourceRef))
          throw new Error(`Dimension bindingのsourceRefがDrawingModelと一致しません: ${sourceKey}`);
        return { kind: 'axis', axisId: current.id };
      });
      const intent = normalizeDimensionIntent({
        schemaVersion: 1,
        id: persistent.id,
        kind: persistent.kind,
        references: runtimeReferences,
        placement: persistent.placement,
        familyId: persistent.familyId,
      });
      const family = resolveDimensionFamily(intent.familyId);
      const compiled = compileDimensionIntent({
        intent,
        family,
        familyBuiltIn: true,
        modelToPaper,
        resolveReference,
      });
      return Object.freeze({
        id: `dimension:project:${compiled.intent.id}`,
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
