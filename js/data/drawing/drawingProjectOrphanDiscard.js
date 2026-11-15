/**
 * @fileoverview 孤児化したtag/寸法の作図意図を、明示操作で削除するpure transaction。
 *
 * 削除対象は対象DrawingDocumentの現在改訂で孤児になっているentityに紐づくtag/寸法意図だけ。
 * BindingRegistryと過去改訂のレビュー・注記は履歴として保持し、入力projectは変更しない。
 */
import { normalizeDrawingProject } from './drawingProjectSchema.js';

function currentRevisionMapping(binding, sourceRevisionId) {
  return binding.revisions.find((item) => item.sourceRevisionId === sourceRevisionId);
}

function orphanedEntityIdSet(project, document) {
  const result = new Set();
  for (const binding of project.bindings) {
    if (binding.modelSlotId !== document.modelSlotId) continue;
    if (currentRevisionMapping(binding, document.sourceRevisionId)?.orphaned)
      result.add(binding.entityId);
  }
  return result;
}

/**
 * 現在改訂で孤児になっていて、tag/寸法意図が残っているentityを列挙する。
 * @param {{project: object, drawingId: string}} options
 * @returns {Array<{entityId: string, lastSourceRef: object|null, tagIds: string[], dimensionIds: string[]}>}
 */
export function listOrphanedDrawingIntents({ project, drawingId } = {}) {
  const normalized = normalizeDrawingProject(project);
  const document = normalized.drawingDocuments.find((item) => item.id === drawingId);
  if (!document) throw new Error('DrawingDocumentがありません: ' + drawingId);
  const result = [];
  for (const entityId of orphanedEntityIdSet(normalized, document)) {
    const tagIds = document.tagIntents
      .filter((tag) => tag.binding.entityId === entityId)
      .map((tag) => tag.id);
    const dimensionIds = document.dimensionIntents
      .filter((dimension) => dimension.references.some((ref) => ref.binding.entityId === entityId))
      .map((dimension) => dimension.id);
    if (!tagIds.length && !dimensionIds.length) continue;
    const binding = normalized.bindings.find((item) => item.entityId === entityId);
    const last = [...binding.revisions].reverse().find((item) => item.sourceRef);
    result.push({ entityId, lastSourceRef: last ? last.sourceRef : null, tagIds, dimensionIds });
  }
  return result.sort((a, b) => a.entityId.localeCompare(b.entityId));
}

/**
 * @param {{project: object, drawingId: string, entityIds: string[]}} options
 * @returns {{project: object, removedTagIds: string[], removedDimensionIds: string[]}}
 */
export function discardOrphanedDrawingIntents({ project, drawingId, entityIds } = {}) {
  const normalized = normalizeDrawingProject(project);
  const document = normalized.drawingDocuments.find((item) => item.id === drawingId);
  if (!document) throw new Error('DrawingDocumentがありません: ' + drawingId);
  if (!Array.isArray(entityIds) || entityIds.length === 0)
    throw new TypeError('entityIdsは1件以上の配列が必要です。');
  const orphaned = orphanedEntityIdSet(normalized, document);
  const targets = new Set();
  for (const raw of entityIds) {
    const entityId = String(raw ?? '').trim();
    if (!orphaned.has(entityId))
      throw new Error('現在改訂で孤児化していないentityは削除できません: ' + entityId);
    targets.add(entityId);
  }

  const next = JSON.parse(JSON.stringify(normalized));
  const nextDocument = next.drawingDocuments.find((item) => item.id === drawingId);
  const removedTagIds = [];
  const removedDimensionIds = [];
  nextDocument.tagIntents = nextDocument.tagIntents.filter((tag) => {
    if (!targets.has(tag.binding.entityId)) return true;
    removedTagIds.push(tag.id);
    return false;
  });
  nextDocument.dimensionIntents = nextDocument.dimensionIntents.filter((dimension) => {
    if (!dimension.references.some((ref) => targets.has(ref.binding.entityId))) return true;
    removedDimensionIds.push(dimension.id);
    return false;
  });
  if (removedTagIds.length === 0 && removedDimensionIds.length === 0)
    throw new Error('指定entityに紐づく削除対象のtag/寸法意図がありません。');
  return { project: normalizeDrawingProject(next), removedTagIds, removedDimensionIds };
}
