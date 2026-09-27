/**
 * @fileoverview Working structural add/restoration 用の「最後の明示比較 snapshot」解決。
 *
 * Issue #249 では編集と比較を分離するため、Working edit 自体では comparisonResults を更新しない。
 * 既存 source 要素を Undo/Discard で scene へ戻す場合は最後の明示比較カテゴリを復元し、
 * source に存在しない真の Working add だけを Model A onlyA として扱う。
 */

import { COMPARISON_CATEGORY } from '../../constants/comparisonCategories.js';
import { getViewerWallElementType } from '../../common-stb/walls/wallClassification.js';
import { findElementByTagAndId, resolveElementTagName } from './attributeCommandUtils.js';

const MATCHED_CATEGORIES = Object.freeze([
  COMPARISON_CATEGORY.EXACT,
  COMPARISON_CATEGORY.WITHIN_TOLERANCE,
  COMPARISON_CATEGORY.ATTRIBUTE_MISMATCH,
]);

function comparisonResultCandidates(comparisonResults, elementType) {
  if (!(comparisonResults instanceof Map)) return [];
  const keys = elementType === 'ShearWall' ? ['ShearWall', 'Wall'] : [elementType];
  const result = [];
  const seen = new Set();
  for (const key of keys) {
    const value = comparisonResults.get(key);
    if (value && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function normalizeId(value) {
  if (value === null || value === undefined || String(value) === '') return null;
  return String(value);
}

function elementIdFromOnlyItem(item) {
  return normalizeId(item?.id ?? item?.elementId ?? item?.element?.id);
}

function matchedItemIdA(item) {
  return normalizeId(item?.dataA?.id ?? item?.idA ?? item?.elementIdA);
}

function sourceElementExists(sourceDocument, elementType, elementId) {
  if (!sourceDocument) return false;
  const tagName = resolveElementTagName(elementType);
  const element = findElementByTagAndId(sourceDocument, tagName, elementId);
  if (!element) return false;
  if (
    tagName === 'StbWall' &&
    (elementType === 'Wall' || elementType === 'ShearWall') &&
    getViewerWallElementType(element) !== elementType
  ) {
    return false;
  }
  return true;
}

function diffStatusForCategory(category, item = {}) {
  if (item.diffStatus) return item.diffStatus;
  if (category === COMPARISON_CATEGORY.EXACT) return 'matched';
  if (category === COMPARISON_CATEGORY.WITHIN_TOLERANCE) return 'positionTolerance';
  if (category === COMPARISON_CATEGORY.ATTRIBUTE_MISMATCH) {
    if (item.positionState === 'withinTolerance') return 'combined';
    switch (item.attributeMismatchKind) {
      case 'instance':
        return 'attributeMismatchInstance';
      case 'type':
        return 'attributeMismatchType';
      case 'both':
        return 'attributeMismatchBoth';
      default:
        return 'attributeMismatch';
    }
  }
  if (category === COMPARISON_CATEGORY.ONLY_B) return 'onlyB';
  return 'onlyA';
}

function snapshotFromMatchedItem(item, category, elementId) {
  const idA = normalizeId(item?.dataA?.id) || String(elementId);
  const idB = normalizeId(item?.dataB?.id);
  return {
    known: true,
    origin: 'explicit-comparison',
    modelSource: 'matched',
    elementId: idA,
    elementIdA: idA,
    elementIdB: idB,
    category,
    toleranceState: item?.matchType || category,
    positionState:
      item?.positionState ||
      (category === COMPARISON_CATEGORY.WITHIN_TOLERANCE ? 'withinTolerance' : 'exact'),
    attributeState:
      item?.attributeState ||
      (category === COMPARISON_CATEGORY.ATTRIBUTE_MISMATCH ? 'mismatch' : 'matched'),
    diffStatus: diffStatusForCategory(category, item),
    attributeMismatchKind: item?.attributeMismatchKind || null,
    dataA: item?.dataA || null,
    dataB: item?.dataB || null,
  };
}

function snapshotOnlyA(item, elementId, origin = 'explicit-comparison') {
  const idA = elementIdFromOnlyItem(item) || String(elementId);
  return {
    known: origin === 'explicit-comparison',
    origin,
    modelSource: 'A',
    elementId: idA,
    elementIdA: idA,
    elementIdB: null,
    category: COMPARISON_CATEGORY.ONLY_A,
    toleranceState: null,
    positionState: null,
    attributeState: null,
    diffStatus: 'onlyA',
    attributeMismatchKind: null,
    dataA: item || null,
    dataB: null,
  };
}

function findSnapshotInResult(result, elementId) {
  for (const category of MATCHED_CATEGORIES) {
    const items = Array.isArray(result?.[category]) ? result[category] : [];
    const item = items.find((candidate) => matchedItemIdA(candidate) === String(elementId));
    if (item) return snapshotFromMatchedItem(item, category, elementId);
  }

  // 正規化前/互換結果も防御的に扱う。
  if (!MATCHED_CATEGORIES.some((category) => Array.isArray(result?.[category]))) {
    const matched = Array.isArray(result?.matched) ? result.matched : [];
    const item = matched.find((candidate) => matchedItemIdA(candidate) === String(elementId));
    if (item) {
      const category = item.category || item.matchType || COMPARISON_CATEGORY.EXACT;
      return snapshotFromMatchedItem(item, category, elementId);
    }
  }

  const onlyA = Array.isArray(result?.onlyA)
    ? result.onlyA
    : Array.isArray(result?.[COMPARISON_CATEGORY.ONLY_A])
      ? result[COMPARISON_CATEGORY.ONLY_A]
      : [];
  const onlyItem = onlyA.find(
    (candidate) => elementIdFromOnlyItem(candidate) === String(elementId),
  );
  return onlyItem ? snapshotOnlyA(onlyItem, elementId) : null;
}

/**
 * structural add の visual provenance を解決する。
 *
 * source に要素が無い場合は true Working add のため onlyA。
 * source に存在する場合は最後の明示 comparisonResults を優先し、見つからなければ
 * 比較情報欠落として onlyA fallback に倒す（comparisonResults 自体は変更しない）。
 */
export function resolveWorkingComparisonSnapshot({
  comparisonResults,
  sourceDocument,
  elementType,
  elementId,
}) {
  const id = String(elementId);
  if (!sourceElementExists(sourceDocument, elementType, id)) {
    return snapshotOnlyA(null, id, 'working-add');
  }

  for (const result of comparisonResultCandidates(comparisonResults, elementType)) {
    const snapshot = findSnapshotInResult(result, id);
    if (snapshot) return snapshot;
  }
  return snapshotOnlyA(null, id, 'source-fallback');
}

export function applyComparisonSnapshotToUserData(userData = {}, snapshot = {}) {
  const next = { ...userData };
  const assignments = {
    modelSource: snapshot.modelSource,
    elementId: snapshot.elementId,
    elementIdA: snapshot.elementIdA,
    elementIdB: snapshot.elementIdB,
    category: snapshot.category,
    toleranceState: snapshot.toleranceState,
    positionState: snapshot.positionState,
    attributeState: snapshot.attributeState,
    diffStatus: snapshot.diffStatus,
    attributeMismatchKind: snapshot.attributeMismatchKind,
  };
  for (const [key, value] of Object.entries(assignments)) {
    if (value === null || value === undefined || value === '') delete next[key];
    else next[key] = String(value);
  }
  return next;
}
