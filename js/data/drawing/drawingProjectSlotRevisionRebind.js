/**
 * #650: plan and commit a single STB model-slot replacement across *all* current views.
 * No view or shared BindingRegistry entry is published until every view passes preflight.
 */
import { normalizeDrawingProject } from './drawingProjectSchema.js';
import {
  planDrawingProjectDrawingRevisionRebind,
  commitDrawingProjectDrawingRevisionRebind,
} from './drawingProjectRevisionRebind.js';

export const DRAWING_PROJECT_SLOT_REBIND_PLAN_KIND = 'DrawingProjectSlotRevisionRebindPlan';

function requiredId(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(name + 'が必要です。');
  return value.trim();
}

function requiredEntities(document) {
  const result = new Set();
  if (document.view?.storyBinding?.entityId) result.add(document.view.storyBinding.entityId);
  for (const intent of document.tagIntents || []) result.add(intent.binding.entityId);
  for (const intent of document.dimensionIntents || [])
    for (const reference of intent.references || []) result.add(reference.binding.entityId);
  return result;
}

function targetKey(mapping) {
  if (mapping.method === 'orphaned') return 'orphaned';
  const ref = mapping.toSourceRef;
  return JSON.stringify([ref?.elementType, ref?.elementId, ref?.guid ?? null]);
}

/**
 * Stage every active view against its independently imported DrawingModel (no global A/B read).
 * The caller must construct each DrawingModel from the same new STB revision.
 */
export function planDrawingProjectSlotRevisionRebind({
  project,
  modelSlotId,
  newRevision,
  drawingModelsById,
  approvedMappings = [],
  orphanedEntityIds = [],
} = {}) {
  const normalized = normalizeDrawingProject(project);
  const slotId = requiredId(modelSlotId, 'modelSlotId');
  const slot = normalized.modelSlots.find((item) => item.id === slotId);
  if (!slot) throw new Error('modelSlotがありません: ' + slotId);
  const documents = normalized.drawingDocuments.filter((item) => item.modelSlotId === slotId);
  if (!documents.length) throw new Error('modelSlotのDrawingDocumentがありません: ' + slotId);
  if (documents.some((item) => item.sourceRevisionId !== slot.currentRevisionId))
    throw new Error(
      'modelSlotに旧revisionのDrawingDocumentが残っています。一括rebind前に解決してください。',
    );
  if (!drawingModelsById || typeof drawingModelsById !== 'object')
    throw new TypeError('drawingModelsByIdに各ビューの新DrawingModelが必要です。');
  if (!Array.isArray(approvedMappings) || !Array.isArray(orphanedEntityIds))
    throw new TypeError('approvedMappings / orphanedEntityIdsは配列が必要です。');

  const requiredByView = new Map(documents.map((item) => [item.id, requiredEntities(item)]));
  const allRequired = new Set([...requiredByView.values()].flatMap((ids) => [...ids]));
  const approvedIds = new Set();
  for (const mapping of approvedMappings) {
    const entityId = requiredId(mapping?.entityId, 'approvedMappings.entityId');
    if (!allRequired.has(entityId)) throw new Error('未使用のapproved entityId: ' + entityId);
    if (approvedIds.has(entityId)) throw new Error('重複approved entityId: ' + entityId);
    approvedIds.add(entityId);
  }
  const orphanIds = new Set();
  for (const raw of orphanedEntityIds) {
    const entityId = requiredId(raw, 'orphanedEntityIds');
    if (!allRequired.has(entityId)) throw new Error('未使用のorphaned entityId: ' + entityId);
    if (orphanIds.has(entityId)) throw new Error('重複orphaned entityId: ' + entityId);
    orphanIds.add(entityId);
  }

  const viewPlans = documents.map((document) => {
    if (!Object.hasOwn(drawingModelsById, document.id))
      throw new Error('新DrawingModelのないビュー: ' + document.id);
    // A caller may bypass the UI's STB-A-only importer and invoke this public
    // planner directly. Never combine identical revision hashes from A/B models.
    const drawingModel = drawingModelsById[document.id];
    if (drawingModel?.source?.modelKey !== 'A')
      throw new Error('modelSlotの全DrawingModelはSTB-A由来である必要があります: ' + document.id);
    const ids = requiredByView.get(document.id);
    return planDrawingProjectDrawingRevisionRebind({
      project: normalized,
      drawingId: document.id,
      newRevision,
      drawingModel,
      approvedMappings: approvedMappings.filter((item) => ids.has(item.entityId)),
      orphanedEntityIds: orphanedEntityIds.filter((item) => ids.has(item)),
    });
  });
  const ownersByEntity = new Map();
  const ownersByTarget = new Map();
  const conflicts = [];
  for (const viewPlan of viewPlans) {
    for (const mapping of viewPlan.mappings) {
      if (mapping.status !== 'resolved') continue;
      const key = targetKey(mapping);
      const previous = ownersByEntity.get(mapping.entityId);
      if (previous && key !== previous.target)
        conflicts.push({
          code: 'SHARED_ENTITY_TARGET_CONFLICT',
          entityId: mapping.entityId,
          drawingIds: [previous.drawingId, viewPlan.drawingId],
        });
      else if (!previous)
        ownersByEntity.set(mapping.entityId, { target: key, drawingId: viewPlan.drawingId });
      if (mapping.method === 'orphaned') continue;
      const identity = JSON.stringify([
        mapping.toSourceRef.elementType,
        mapping.toSourceRef.elementId,
      ]);
      const targetOwner = ownersByTarget.get(identity);
      if (targetOwner && targetOwner.entityId !== mapping.entityId)
        conflicts.push({
          code: 'TARGET_MAPPING_CONFLICT',
          entityId: mapping.entityId,
          conflictingEntityId: targetOwner.entityId,
          drawingIds: [targetOwner.drawingId, viewPlan.drawingId],
        });
      else
        ownersByTarget.set(identity, { entityId: mapping.entityId, drawingId: viewPlan.drawingId });
    }
  }
  const unresolved = [
    ...viewPlans.flatMap((item) =>
      item.unresolved.map((entry) => ({ drawingId: item.drawingId, ...entry })),
    ),
    ...conflicts,
    ...viewPlans.flatMap((item) =>
      item.diagnostics.map((entry) => ({ drawingId: item.drawingId, ...entry })),
    ),
  ];
  return Object.freeze({
    kind: DRAWING_PROJECT_SLOT_REBIND_PLAN_KIND,
    schemaVersion: 1,
    projectId: normalized.projectId,
    modelSlotId: slot.id,
    fromRevisionId: slot.currentRevisionId,
    toRevision: viewPlans[0].toRevision,
    projectSnapshot: JSON.stringify(normalized),
    status: unresolved.length ? 'blocked' : 'ready',
    viewPlans: Object.freeze(viewPlans),
    unresolved: Object.freeze(unresolved),
  });
}

/** Atomically publish every view, shared entity revision and sheet list reference. */
export function commitDrawingProjectSlotRevisionRebind({ project, plan } = {}) {
  if (
    plan?.kind !== DRAWING_PROJECT_SLOT_REBIND_PLAN_KIND ||
    plan.schemaVersion !== 1 ||
    !Array.isArray(plan.viewPlans)
  )
    throw new TypeError('DrawingProjectSlotRevisionRebindPlan v1が必要です。');
  if (plan.status !== 'ready') throw new Error('blocked slot rebind planはcommitできません。');
  const normalized = normalizeDrawingProject(project);
  if (
    JSON.stringify(normalized) !== plan.projectSnapshot ||
    normalized.projectId !== plan.projectId
  )
    throw new Error('slot rebind plan作成後にprojectが変更されています。');
  const slot = normalized.modelSlots.find((item) => item.id === plan.modelSlotId);
  if (slot?.currentRevisionId !== plan.fromRevisionId)
    throw new Error('slot rebind plan作成後にmodelSlotが変更されています。');
  const currentDocuments = normalized.drawingDocuments.filter(
    (item) => item.modelSlotId === plan.modelSlotId,
  );
  if (
    plan.viewPlans.length !== currentDocuments.length ||
    !currentDocuments.every((item) => plan.viewPlans.some((entry) => entry.drawingId === item.id))
  )
    throw new Error('slot rebind planのDrawingDocument集合が一致しません。');

  // The existing single-view commit is used only on isolated clones to retain its
  // checks for stale source refs, duplicate targets and historical review invariants.
  // Its outputs are not published: consolidate them before one final normalization.
  const previews = plan.viewPlans.map((viewPlan) => ({
    drawingId: viewPlan.drawingId,
    project: commitDrawingProjectDrawingRevisionRebind({ project: normalized, plan: viewPlan }),
    mappingIds: viewPlan.mappings.map((entry) => entry.entityId),
  }));
  const next = JSON.parse(JSON.stringify(normalized));
  const firstSlot = previews[0].project.modelSlots.find((item) => item.id === plan.modelSlotId);
  const nextSlot = next.modelSlots.find((item) => item.id === plan.modelSlotId);
  nextSlot.currentRevisionId = firstSlot.currentRevisionId;
  nextSlot.revisions = firstSlot.revisions;
  const updatedBindings = new Map();
  for (const preview of previews) {
    const updatedDocument = preview.project.drawingDocuments.find(
      (item) => item.id === preview.drawingId,
    );
    const index = next.drawingDocuments.findIndex((item) => item.id === preview.drawingId);
    next.drawingDocuments[index] = updatedDocument;
    for (const entityId of preview.mappingIds) {
      const source = preview.project.bindings.find((item) => item.entityId === entityId);
      const previous = updatedBindings.get(entityId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(source))
        throw new Error('共有BindingRegistryのrevisionが競合しています: ' + entityId);
      updatedBindings.set(entityId, source);
    }
  }
  next.bindings = next.bindings.map((item) => updatedBindings.get(item.entityId) || item);
  next.drawingSheets = previews[0].project.drawingSheets;
  return normalizeDrawingProject(next);
}
