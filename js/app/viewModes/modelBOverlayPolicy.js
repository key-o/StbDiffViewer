/**
 * @fileoverview 一致要素に対するモデルBオーバーレイ表示判定。
 *
 * 断面・タイプ差と配置位置差の2つの表示トグルを独立して扱い、
 * 両方に該当する要素でもモデルBメッシュを1回だけ生成できるようにする。
 */

import { COMPARISON_CATEGORY } from '../../constants/comparisonCategories.js';
import { getLineElementKey, getPolyElementKey } from '../../common-stb/comparison/keyGenerator.js';

const PLACEMENT_INSTANCE_ATTRIBUTES = new Set([
  'rotate',
  'offset_X',
  'offset_Y',
  'offset_Z',
  'offset_bottom_X',
  'offset_bottom_Y',
  'offset_bottom_Z',
  'offset_top_X',
  'offset_top_Y',
  'offset_top_Z',
  'offset_start_X',
  'offset_start_Y',
  'offset_start_Z',
  'offset_end_X',
  'offset_end_Y',
  'offset_end_Z',
  'level_top',
  'level_bottom',
]);

/**
 * 断面・タイプ差としてモデルB形状を重ねる対象か判定する。
 * @param {Object} item - 正規化済みmatchedペア
 * @returns {boolean}
 */
export function isSectionMismatchOverlayCandidate(item) {
  return (
    item?.attributeMismatchKind === 'type' ||
    item?.attributeMismatchKind === 'both' ||
    item?.diffStatus === 'attributeMismatchType' ||
    item?.diffStatus === 'attributeMismatchBoth'
  );
}

function hasExtractedGeometryPlacementDifference(item) {
  const dataA = item?.dataA;
  const dataB = item?.dataB;

  if (dataA?.startCoords && dataA?.endCoords && dataB?.startCoords && dataB?.endCoords) {
    const keyA = getLineElementKey(dataA.startCoords, dataA.endCoords);
    const keyB = getLineElementKey(dataB.startCoords, dataB.endCoords);
    return keyA !== null && keyB !== null && keyA !== keyB;
  }

  if (Array.isArray(dataA?.vertexCoordsList) && Array.isArray(dataB?.vertexCoordsList)) {
    const keyA = getPolyElementKey(dataA.vertexCoordsList);
    const keyB = getPolyElementKey(dataB.vertexCoordsList);
    return keyA !== null && keyB !== null && keyA !== keyB;
  }

  return false;
}

/**
 * 配置位置差としてモデルB形状を重ねる対象か判定する。
 * WITHIN_TOLERANCE は配置位置が完全一致ではない対応要素を表す。
 * ATTRIBUTE_MISMATCH と位置差が同時にある場合は positionState を優先して拾う。
 * また、厳密比較/GUID比較などで offset・rotate 等がインスタンス属性差として
 * 分類されたケースも配置位置差として扱う。
 * @param {Object} item - 正規化済みmatchedペア
 * @param {string} category - COMPARISON_CATEGORY の値
 * @returns {boolean}
 */
export function isPositionMismatchOverlayCandidate(item, category) {
  if (
    category === COMPARISON_CATEGORY.WITHIN_TOLERANCE ||
    item?.positionState === 'withinTolerance' ||
    item?.diffStatus === 'positionTolerance' ||
    item?.diffStatus === 'combined'
  ) {
    return true;
  }

  const instanceDiffs = item?.attributeDiffDetails?.instance;
  if (
    Array.isArray(instanceDiffs) &&
    instanceDiffs.some((diff) => PLACEMENT_INSTANCE_ATTRIBUTES.has(diff?.attribute))
  ) {
    return true;
  }

  // GUID/所属通芯・階など、対応キー自体に座標を含めない厳密比較では、
  // 同一要素として対応していても節点座標差が positionState に反映されない。
  // キー抽出済みの実座標を比較し、描画上の配置差を補足する。
  return hasExtractedGeometryPlacementDifference(item);
}

/**
 * 現在の表示トグルに基づき、matchedペアのモデルB形状を重ねるか判定する。
 * @param {Object} item - 正規化済みmatchedペア
 * @param {string} category - COMPARISON_CATEGORY の値
 * @param {Object} options - 表示設定
 * @param {boolean} [options.showSectionMismatch=false] - 断面・タイプ差を重ねる
 * @param {boolean} [options.showPositionMismatch=false] - 配置位置差を重ねる
 * @returns {boolean}
 */
export function shouldOverlayMatchedModelB(
  item,
  category,
  { showSectionMismatch = false, showPositionMismatch = false } = {},
) {
  return (
    (showSectionMismatch && isSectionMismatchOverlayCandidate(item)) ||
    (showPositionMismatch && isPositionMismatchOverlayCandidate(item, category))
  );
}
