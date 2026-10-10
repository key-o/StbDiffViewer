/**
 * @fileoverview DrawingProjectの1 DrawingDocumentを新STB revisionへ移すpure rebind transaction。
 *
 * 自動対応は同一elementType + 一意GUIDだけに限定する。GUIDなし・GUID再採番・曖昧GUIDは
 * 明示approved mappingがない限りfail-closedとし、座標・符号・近傍だけで確定しない。
 */
import { normalizeDrawingProject } from './drawingProjectSchema.js';

export const DRAWING_PROJECT_REBIND_PLAN_KIND = 'DrawingProjectRevisionRebindPlan';
export const DRAWING_PROJECT_REBIND_PLAN_SCHEMA_VERSION = 1;

function requiredString(value, name) {
  if (value == null || !String(value).trim()) throw new TypeError(name + 'が必要です。');
  return String(value).trim();
}

function sha256(value, name) {
  const normalized = requiredString(value, name).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new TypeError(name + 'はSHA-256が必要です。');
  return normalized;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function freezeSourceRef(ref) {
  return Object.freeze({
    elementType: requiredString(ref?.elementType, 'sourceRef.elementType'),
    elementId: requiredString(ref?.elementId, 'sourceRef.elementId'),
    guid: ref?.guid == null ? null : requiredString(ref.guid, 'sourceRef.guid'),
  });
}

function sourceRefKey(ref) {
  return JSON.stringify([String(ref?.elementType), String(ref?.elementId)]);
}

function sameSourceRef(left, right) {
  const a = freezeSourceRef(left);
  const b = freezeSourceRef(right);
  return a.elementType === b.elementType && a.elementId === b.elementId && a.guid === b.guid;
}

function guidKey(ref) {
  return ref?.guid == null ? null : JSON.stringify([String(ref.elementType), String(ref.guid)]);
}

function samePlanView(left, right) {
  return (
    left?.type === 'plan' &&
    right?.type === 'plan' &&
    (Boolean(left?.storyBinding) || String(left.storyId) === String(right.storyId))
  );
}

function documentById(project, drawingId) {
  const id = requiredString(drawingId, 'drawingId');
  const document = project.drawingDocuments.find((item) => item.id === id);
  if (!document) throw new Error('DrawingDocumentがありません: ' + id);
  return document;
}

function slotForDocument(project, document) {
  const slot = project.modelSlots.find((item) => item.id === document.modelSlotId);
  if (!slot) throw new Error('DrawingDocumentのmodelSlotがありません: ' + document.modelSlotId);
  return slot;
}

function requiredEntityIds(document) {
  const ids = new Set();
  if (document.view?.storyBinding?.entityId) ids.add(document.view.storyBinding.entityId);
  for (const tag of document.tagIntents || []) ids.add(tag.binding.entityId);
  for (const dimension of document.dimensionIntents || [])
    for (const reference of dimension.references || []) ids.add(reference.binding.entityId);
  return ids;
}

function bindingByEntityId(project, document) {
  const result = new Map();
  for (const binding of project.bindings) {
    if (binding.modelSlotId !== document.modelSlotId) continue;
    result.set(binding.entityId, binding);
  }
  return result;
}

function candidateSourceRefs(drawingModel) {
  const byKey = new Map();
  const byGuid = new Map();
  const add = (ref, origin, state = null) => {
    const normalized = freezeSourceRef(ref);
    const key = sourceRefKey(normalized);
    if (byKey.has(key)) throw new Error('新DrawingModelのsourceRefが重複しています: ' + key);
    const candidate = Object.freeze({ sourceRef: normalized, origin, state });
    byKey.set(key, candidate);
    const gKey = guidKey(normalized);
    if (gKey) {
      const list = byGuid.get(gKey) || [];
      list.push(candidate);
      byGuid.set(gKey, list);
    }
  };

  if (drawingModel?.view?.storySourceRef) add(drawingModel.view.storySourceRef, 'story', null);
  for (const record of drawingModel?.elements || [])
    add(record.ref, 'element', record.state || null);
  for (const reference of drawingModel?.dimensionReferences || [])
    add(reference.sourceRef, 'dimension-reference', null);
  return { byKey, byGuid };
}

function approvedMappingIndex(approvedMappings, requiredIds) {
  if (!Array.isArray(approvedMappings)) throw new TypeError('approvedMappingsは配列が必要です。');
  const index = new Map();
  for (const [i, mapping] of approvedMappings.entries()) {
    const entityId = requiredString(mapping?.entityId, `approvedMappings[${i}].entityId`);
    if (!requiredIds.has(entityId))
      throw new Error(
        'approved mappingのentityIdは対象DrawingDocumentで使用されていません: ' + entityId,
      );
    if (index.has(entityId))
      throw new Error('approved mappingのentityIdが重複しています: ' + entityId);
    index.set(entityId, freezeSourceRef(mapping.sourceRef));
  }
  return index;
}

function oldSourceRef(binding, sourceRevisionId) {
  const revision = binding.revisions.find((item) => item.sourceRevisionId === sourceRevisionId);
  if (!revision?.sourceRef)
    throw new Error(
      'BindingRegistryにDrawingDocument source revisionのmappingがありません: ' + binding.entityId,
    );
  return freezeSourceRef(revision.sourceRef);
}

function mappingStatus({ entityId, fromSourceRef, approvedSourceRef, candidates }) {
  if (approvedSourceRef) {
    const candidate = candidates.byKey.get(sourceRefKey(approvedSourceRef));
    if (!candidate)
      return Object.freeze({
        entityId,
        status: 'unresolved',
        reason: 'APPROVED_TARGET_NOT_FOUND',
        fromSourceRef,
        requestedSourceRef: approvedSourceRef,
      });
    if (approvedSourceRef.guid != null && approvedSourceRef.guid !== candidate.sourceRef.guid)
      return Object.freeze({
        entityId,
        status: 'unresolved',
        reason: 'APPROVED_TARGET_GUID_MISMATCH',
        fromSourceRef,
        requestedSourceRef: approvedSourceRef,
        candidateSourceRef: candidate.sourceRef,
      });
    return Object.freeze({
      entityId,
      status: 'resolved',
      method: 'approved',
      fromSourceRef,
      toSourceRef: candidate.sourceRef,
      candidateOrigin: candidate.origin,
      candidateState: candidate.state,
    });
  }

  if (fromSourceRef.guid == null)
    return Object.freeze({
      entityId,
      status: 'unresolved',
      reason: 'GUID_MISSING_REQUIRES_APPROVAL',
      fromSourceRef,
    });

  const matches = candidates.byGuid.get(guidKey(fromSourceRef)) || [];
  if (matches.length === 0)
    return Object.freeze({
      entityId,
      status: 'unresolved',
      reason: 'GUID_TARGET_NOT_FOUND',
      fromSourceRef,
    });
  if (matches.length > 1)
    return Object.freeze({
      entityId,
      status: 'unresolved',
      reason: 'GUID_AMBIGUOUS',
      fromSourceRef,
      candidateSourceRefs: Object.freeze(matches.map((item) => item.sourceRef)),
    });

  const candidate = matches[0];
  return Object.freeze({
    entityId,
    status: 'resolved',
    method: 'guid',
    fromSourceRef,
    toSourceRef: candidate.sourceRef,
    candidateOrigin: candidate.origin,
    candidateState: candidate.state,
  });
}

function storyCandidateSourceRefs(storyCandidates) {
  if (!Array.isArray(storyCandidates)) throw new TypeError('storyCandidatesは配列が必要です。');
  const byKey = new Map();
  const byGuid = new Map();
  for (const [index, candidateInput] of storyCandidates.entries()) {
    const sourceRef = freezeSourceRef(candidateInput?.sourceRef ?? candidateInput);
    if (sourceRef.elementType !== 'Story')
      throw new TypeError(`storyCandidates[${index}]はStory sourceRefである必要があります。`);
    const key = sourceRefKey(sourceRef);
    if (byKey.has(key)) throw new Error('Story candidate sourceRefが重複しています: ' + key);
    const candidate = Object.freeze({
      sourceRef,
      origin: 'story',
      state: null,
      metadata: candidateInput?.sourceRef ? candidateInput : null,
    });
    byKey.set(key, candidate);
    const gKey = guidKey(sourceRef);
    if (gKey) {
      const list = byGuid.get(gKey) || [];
      list.push(candidate);
      byGuid.set(gKey, list);
    }
  }
  return { byKey, byGuid };
}

/**
 * DrawingModel生成前にplan viewのStoryだけをsemantic bindingで解決する。
 * name/height/orderはUI候補表示に使えるが、ここではGUIDまたはexplicit approvalだけを採用する。
 */
export function planDrawingProjectStoryRevisionRebind({
  project,
  drawingId,
  storyCandidates = [],
  approvedMappings = [],
} = {}) {
  const normalized = normalizeDrawingProject(project);
  const document = documentById(normalized, drawingId);
  const entityId = document.view?.storyBinding?.entityId;
  if (!entityId)
    return Object.freeze({
      kind: 'DrawingProjectStoryRevisionRebindPlan',
      schemaVersion: 1,
      projectId: normalized.projectId,
      drawingId: document.id,
      modelSlotId: document.modelSlotId,
      status: 'legacy',
      mappings: Object.freeze([]),
      unresolved: Object.freeze([]),
      storyId: document.view.storyId,
    });

  const bindings = bindingByEntityId(normalized, document);
  const binding = bindings.get(entityId);
  if (!binding) throw new Error('plan viewのStory BindingRegistry entityがありません: ' + entityId);
  const fromSourceRef = oldSourceRef(binding, document.sourceRevisionId);
  if (fromSourceRef.elementType !== 'Story')
    throw new Error('plan viewのstory bindingはStoryを参照する必要があります。');
  const approved = approvedMappingIndex(approvedMappings, new Set([entityId]));
  const mapping = mappingStatus({
    entityId,
    fromSourceRef,
    approvedSourceRef: approved.get(entityId) || null,
    candidates: storyCandidateSourceRefs(storyCandidates),
  });
  const unresolved = mapping.status === 'resolved' ? [] : [mapping];
  return Object.freeze({
    kind: 'DrawingProjectStoryRevisionRebindPlan',
    schemaVersion: 1,
    projectId: normalized.projectId,
    drawingId: document.id,
    modelSlotId: document.modelSlotId,
    status: unresolved.length === 0 ? 'ready' : 'blocked',
    mappings: Object.freeze([mapping]),
    unresolved: Object.freeze(unresolved),
  });
}

function rejectDuplicateTargets(results) {
  const owners = new Map();
  for (const mapping of results) {
    if (mapping.status !== 'resolved' || !mapping.toSourceRef) continue;
    const key = sourceRefKey(mapping.toSourceRef);
    const entityIds = owners.get(key) || [];
    entityIds.push(mapping.entityId);
    owners.set(key, entityIds);
  }
  const conflicts = new Map([...owners.entries()].filter(([, entityIds]) => entityIds.length > 1));
  if (conflicts.size === 0) return results;

  return results.map((mapping) => {
    if (mapping.status !== 'resolved' || !mapping.toSourceRef) return mapping;
    const conflictingEntityIds = conflicts.get(sourceRefKey(mapping.toSourceRef));
    if (!conflictingEntityIds) return mapping;
    return Object.freeze({
      entityId: mapping.entityId,
      status: 'unresolved',
      reason: 'TARGET_MAPPING_CONFLICT',
      fromSourceRef: mapping.fromSourceRef,
      candidateSourceRef: mapping.toSourceRef,
      conflictingEntityIds: Object.freeze([...conflictingEntityIds]),
    });
  });
}

/**
 * 新DrawingModelをstagingして、現在DrawingDocumentでactiveなtag/dimension bindingだけを再解決する。
 * review/annotation historyは旧revision contextのまま保持するため、新revision mappingを要求しない。
 */
export function planDrawingProjectDrawingRevisionRebind({
  project,
  drawingId,
  newRevision,
  drawingModel,
  approvedMappings = [],
} = {}) {
  const normalized = normalizeDrawingProject(project);
  const document = documentById(normalized, drawingId);
  const slot = slotForDocument(normalized, document);
  if (slot.currentRevisionId !== document.sourceRevisionId)
    throw new Error('current revision以外のDrawingDocumentはreplacement対象にできません。');

  const toRevision = Object.freeze({
    id: requiredString(newRevision?.id, 'newRevision.id'),
    sha256: sha256(newRevision?.sha256, 'newRevision.sha256'),
  });
  if (toRevision.id === document.sourceRevisionId)
    throw new Error('replacement先revision IDは現在revisionと異なる必要があります。');
  const currentRevision = slot.revisions.find((item) => item.id === document.sourceRevisionId);
  if (!currentRevision) throw new Error('current source revisionがmodelSlotにありません。');
  if (String(currentRevision.sha256).toLowerCase() === toRevision.sha256)
    throw new Error('同一STB SHA-256を別revisionとしてreplacementできません。');

  const sameId = slot.revisions.find((item) => item.id === toRevision.id);
  if (sameId && String(sameId.sha256).toLowerCase() !== toRevision.sha256)
    throw new Error('newRevision.idが異なるSHA-256で既に登録されています。');
  const sameHash = slot.revisions.find(
    (item) => String(item.sha256).toLowerCase() === toRevision.sha256,
  );
  if (sameHash && sameHash.id !== toRevision.id)
    throw new Error('newRevision.sha256が別revision IDで既に登録されています。');

  if (drawingModel?.schemaVersion !== 1 || drawingModel.units !== 'mm')
    throw new TypeError('replacement検証にはDrawingModel v1(mm)が必要です。');
  if (String(drawingModel.source?.modelRevision || '').toLowerCase() !== toRevision.sha256)
    throw new Error('新DrawingModelのsource revisionがnewRevision.sha256と一致しません。');
  if (!samePlanView(document.view, drawingModel.view))
    throw new Error('新DrawingModelのviewがDrawingDocumentと一致しません。');

  const requiredIds = requiredEntityIds(document);
  const bindings = bindingByEntityId(normalized, document);
  const approved = approvedMappingIndex(approvedMappings, requiredIds);
  const candidates = candidateSourceRefs(drawingModel);
  const results = [];
  for (const entityId of [...requiredIds].sort()) {
    const binding = bindings.get(entityId);
    if (!binding)
      throw new Error('DrawingDocumentのBindingRegistry entityがありません: ' + entityId);
    const fromSourceRef = oldSourceRef(binding, document.sourceRevisionId);
    results.push(
      mappingStatus({
        entityId,
        fromSourceRef,
        approvedSourceRef: approved.get(entityId) || null,
        candidates,
      }),
    );
  }

  const checkedResults = rejectDuplicateTargets(results);
  const storyEntityId = document.view?.storyBinding?.entityId;
  if (storyEntityId) {
    const storyMapping = checkedResults.find((item) => item.entityId === storyEntityId);
    if (
      storyMapping?.status === 'resolved' &&
      (storyMapping.toSourceRef?.elementType !== 'Story' ||
        String(storyMapping.toSourceRef.elementId) !== String(drawingModel.view.storyId))
    )
      throw new Error('新DrawingModelの対象階がStory rebind targetと一致しません。');
  }
  const unresolved = checkedResults.filter((item) => item.status !== 'resolved');
  return Object.freeze({
    kind: DRAWING_PROJECT_REBIND_PLAN_KIND,
    schemaVersion: DRAWING_PROJECT_REBIND_PLAN_SCHEMA_VERSION,
    projectId: normalized.projectId,
    drawingId: document.id,
    modelSlotId: document.modelSlotId,
    fromRevisionId: document.sourceRevisionId,
    toRevision,
    status: unresolved.length === 0 ? 'ready' : 'blocked',
    mappings: Object.freeze(checkedResults),
    unresolved: Object.freeze(unresolved),
  });
}

function assertPlan(plan) {
  if (
    plan?.kind !== DRAWING_PROJECT_REBIND_PLAN_KIND ||
    plan.schemaVersion !== DRAWING_PROJECT_REBIND_PLAN_SCHEMA_VERSION ||
    !['ready', 'blocked'].includes(plan.status) ||
    !Array.isArray(plan.mappings)
  )
    throw new TypeError('DrawingProjectRevisionRebindPlan v1が必要です。');
  return plan;
}

/** ready planだけを一括適用する。失敗時に入力projectを部分更新しない。 */
export function commitDrawingProjectDrawingRevisionRebind({ project, plan: planInput } = {}) {
  const plan = assertPlan(planInput);
  if (plan.status !== 'ready') throw new Error('blocked rebind planはcommitできません。');
  const normalized = normalizeDrawingProject(project);
  if (normalized.projectId !== plan.projectId)
    throw new Error('rebind planのprojectIdが一致しません。');
  const document = documentById(normalized, plan.drawingId);
  const slot = slotForDocument(normalized, document);
  if (
    document.modelSlotId !== plan.modelSlotId ||
    document.sourceRevisionId !== plan.fromRevisionId
  )
    throw new Error('rebind plan作成後にDrawingDocument contextが変更されています。');
  if (slot.currentRevisionId !== plan.fromRevisionId)
    throw new Error('rebind plan作成後にmodelSlot current revisionが変更されています。');

  const activeEntityIds = [...requiredEntityIds(document)].sort();
  const plannedEntityIds = plan.mappings
    .map((mapping, index) => requiredString(mapping?.entityId, `plan.mappings[${index}].entityId`))
    .sort();
  if (JSON.stringify(activeEntityIds) !== JSON.stringify(plannedEntityIds))
    throw new Error('rebind plan作成後にDrawingDocumentのactive binding setが変更されています。');

  const currentBindings = bindingByEntityId(normalized, document);
  const targetOwners = new Map();
  for (const mapping of plan.mappings) {
    if (mapping.status !== 'resolved' || !mapping.toSourceRef)
      throw new Error('ready planにunresolved mappingが含まれています。');
    const binding = currentBindings.get(mapping.entityId);
    if (!binding)
      throw new Error('rebind plan作成後にcommit対象bindingが失われています: ' + mapping.entityId);
    const currentFromSourceRef = oldSourceRef(binding, document.sourceRevisionId);
    if (!sameSourceRef(currentFromSourceRef, mapping.fromSourceRef))
      throw new Error(
        'rebind plan作成後にBindingRegistry mappingが変更されています: ' + mapping.entityId,
      );
    const targetKey = sourceRefKey(freezeSourceRef(mapping.toSourceRef));
    if (targetOwners.has(targetKey))
      throw new Error(
        `ready planに重複target mappingが含まれています: ${targetOwners.get(targetKey)} / ${mapping.entityId}`,
      );
    targetOwners.set(targetKey, mapping.entityId);
  }

  const next = clone(normalized);
  const nextDocument = documentById(next, plan.drawingId);
  const nextSlot = slotForDocument(next, nextDocument);
  if (!nextSlot.revisions.some((item) => item.id === plan.toRevision.id))
    nextSlot.revisions.push({ ...plan.toRevision });
  nextSlot.currentRevisionId = plan.toRevision.id;

  const nextBindings = new Map(next.bindings.map((item) => [item.entityId, item]));
  for (const mapping of plan.mappings) {
    if (mapping.status !== 'resolved' || !mapping.toSourceRef)
      throw new Error('ready planにunresolved mappingが含まれています。');
    const binding = nextBindings.get(mapping.entityId);
    if (!binding || binding.modelSlotId !== nextDocument.modelSlotId)
      throw new Error('commit対象bindingがありません: ' + mapping.entityId);
    if (binding.revisions.some((item) => item.sourceRevisionId === plan.toRevision.id))
      throw new Error('commit対象bindingにnew revision mappingが既にあります: ' + mapping.entityId);
    binding.revisions.push({
      sourceRevisionId: plan.toRevision.id,
      sourceRef: clone(mapping.toSourceRef),
    });
  }
  const storyEntityId = nextDocument.view?.storyBinding?.entityId;
  if (storyEntityId) {
    const storyMapping = plan.mappings.find((mapping) => mapping.entityId === storyEntityId);
    if (storyMapping?.status !== 'resolved' || storyMapping.toSourceRef?.elementType !== 'Story')
      throw new Error('ready planにStory mappingがありません。');
    nextDocument.view.storyId = String(storyMapping.toSourceRef.elementId);
  }
  nextDocument.sourceRevisionId = plan.toRevision.id;
  return normalizeDrawingProject(next);
}
