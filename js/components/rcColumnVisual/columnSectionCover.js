/**
 * RC柱断面リストの作図用かぶり・主筋芯位置設定。
 *
 * 基準DXF（柱リスト.dxf）の650角C1を実測すると、
 * - コンクリート面 -> 外周HOOP芯 = 50 mm
 * - コンクリート面 -> D22主筋芯 = 72 mm
 * であるため、STBに主筋重心位置が無い場合の既定作図値として使用する。
 *
 * X/Yのstart/endはST-Bridgeの座標系に合わせる。
 * - startX: X始側（左）
 * - endX:   X終側（右）
 * - startY: Y始側（下）
 * - endY:   Y終側（上）
 */

import { BASELINE_RC_SCHEDULE_PROFILE } from '../rcScheduleProfile.js';
import { normalizeRcScheduleFaces, resolveRcScheduleMainFaces } from '../rcSchedulePlacement.js';

export const BASELINE_COLUMN_COVER_FACES = BASELINE_RC_SCHEDULE_PROFILE.column.hoopCenterFaces;

export const BASELINE_COLUMN_MAIN_CENTER_FACES =
  BASELINE_RC_SCHEDULE_PROFILE.column.mainCenterFaces;

export const BASELINE_COLUMN_MAIN_CENTER_DELTA =
  BASELINE_COLUMN_MAIN_CENTER_FACES.startX - BASELINE_COLUMN_COVER_FACES.startX;

const COLUMN_FACE_KEYS = ['startX', 'endX', 'startY', 'endY'];

export function normalizeColumnCoverFaces(value = {}, fallback = BASELINE_COLUMN_COVER_FACES) {
  return normalizeRcScheduleFaces(value, COLUMN_FACE_KEYS, fallback);
}

/**
 * 主筋芯位置を4面別に解決する。
 * STBの center_* が正の値で明示されている面はその値を優先し、
 * 欠損または0の面のみ「作図かぶり + 基準DXFの22 mm差」で補う。
 */
export function resolveColumnMainCenterFaces(
  mainBar = {},
  coverFaces = BASELINE_COLUMN_COVER_FACES,
) {
  const cover = normalizeColumnCoverFaces(coverFaces);
  return resolveRcScheduleMainFaces(
    {
      startX: mainBar.centerStartX ?? mainBar.dtX,
      endX: mainBar.centerEndX ?? mainBar.dtX,
      startY: mainBar.centerStartY ?? mainBar.dtY,
      endY: mainBar.centerEndY ?? mainBar.dtY,
    },
    cover,
    COLUMN_FACE_KEYS,
    BASELINE_COLUMN_MAIN_CENTER_DELTA,
  );
}

/**
 * 現行SVGレンダラーの内部軸定義へ変換する。
 * 現行は countX を上下辺、countY を左右辺として使用するため、
 * ST-Bridgeの N_main_X（左右辺）/N_main_Y（上下辺）をここで入れ替える。
 */
export function adaptMainBarForCurrentSvg(mainBar, coverFaces = BASELINE_COLUMN_COVER_FACES) {
  if (!mainBar) return null;
  const centers = resolveColumnMainCenterFaces(mainBar, coverFaces);
  const swapGroup = (group) =>
    group
      ? {
          ...group,
          countX: group.countY,
          countY: group.countX,
        }
      : group;
  const swapLayer = (layer) =>
    layer
      ? {
          ...layer,
          groups: Array.isArray(layer.groups) ? layer.groups.map(swapGroup) : layer.groups,
        }
      : layer;

  return {
    ...mainBar,
    // STB X方向主筋=左右辺、Y方向主筋=上下辺。
    countX: mainBar.countY,
    countY: mainBar.countX,
    // SVGの上側はSTBのY終、下側はY始に対応する。
    centerStartX: centers.startX,
    centerEndX: centers.endX,
    centerStartY: centers.endY,
    centerEndY: centers.startY,
    firstLayerExtraGroups: Array.isArray(mainBar.firstLayerExtraGroups)
      ? mainBar.firstLayerExtraGroups.map(swapGroup)
      : mainBar.firstLayerExtraGroups,
    layers: Array.isArray(mainBar.layers) ? mainBar.layers.map(swapLayer) : mainBar.layers,
    secondLayer: mainBar.secondLayer
      ? {
          ...swapGroup(mainBar.secondLayer),
          groups: Array.isArray(mainBar.secondLayer.groups)
            ? mainBar.secondLayer.groups.map(swapGroup)
            : mainBar.secondLayer.groups,
        }
      : mainBar.secondLayer,
  };
}

/**
 * 基準DXFの中子筋アンカー選択。
 * 外周2脚を除いた内脚数だけ主筋スロットを選ぶ。
 * 偶数スロットから内脚を1本だけ選ぶ場合は、基準DXFに合わせて終側を採用する。
 */
export function selectBaselineInnerLegSlotIndices(slotCount, fullLegCount) {
  const slots = Math.max(0, Number.parseInt(slotCount, 10) || 0);
  const innerCount = Math.max(0, (Number.parseInt(fullLegCount, 10) || 0) - 2);
  const candidates = Array.from({ length: Math.max(0, slots - 2) }, (_, index) => index + 1);
  if (innerCount <= 0 || candidates.length === 0) return [];
  if (innerCount >= candidates.length) return candidates;
  if (innerCount === 1) return [candidates[Math.floor(candidates.length / 2)]];

  return Array.from({ length: innerCount }, (_, index) => {
    const candidateIndex = Math.round((index * (candidates.length - 1)) / (innerCount - 1));
    return candidates[candidateIndex];
  }).filter((value, index, values) => values.indexOf(value) === index);
}

export function averageColumnCoverFaces(coverFaces = BASELINE_COLUMN_COVER_FACES) {
  const cover = normalizeColumnCoverFaces(coverFaces);
  return (cover.startX + cover.endX + cover.startY + cover.endY) / 4;
}
