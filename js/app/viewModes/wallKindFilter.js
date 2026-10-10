/**
 * @fileoverview canonical Wall の kind_wall 表示フィルタ。
 *
 * Scene / comparison / selection identity は Wall のまま維持し、
 * 耐力壁と一般壁の表示可否だけをここで管理する。
 */

import { isStbShearWall } from '../../common-stb/walls/wallClassification.js';
import { MATCHED_CATEGORIES, ONLY_CATEGORIES } from '../../constants/comparisonCategories.js';

export const WALL_KIND_FILTER = Object.freeze({
  SHEAR: 'shear',
  NORMAL: 'normal',
});

const visibility = {
  [WALL_KIND_FILTER.SHEAR]: true,
  [WALL_KIND_FILTER.NORMAL]: true,
};

function assertFilterKind(kind) {
  if (kind !== WALL_KIND_FILTER.SHEAR && kind !== WALL_KIND_FILTER.NORMAL) {
    throw new TypeError(`未対応の壁表示分類です: ${String(kind)}`);
  }
}

export function wallKindFilterForElement(element) {
  return isStbShearWall(element) ? WALL_KIND_FILTER.SHEAR : WALL_KIND_FILTER.NORMAL;
}

export function setWallKindVisible(kind, visible) {
  assertFilterKind(kind);
  visibility[kind] = visible === true;
}

export function isWallKindVisible(kind) {
  assertFilterKind(kind);
  return visibility[kind];
}

export function getWallKindVisibility() {
  return Object.freeze({ ...visibility });
}

export function resetWallKindVisibility() {
  visibility[WALL_KIND_FILTER.SHEAR] = true;
  visibility[WALL_KIND_FILTER.NORMAL] = true;
}

export function filterWallsByDisplayKind(elements) {
  if (!Array.isArray(elements)) return [];
  return elements.filter(isWallElementVisible);
}

export function isWallElementVisible(element) {
  return isWallKindVisible(wallKindFilterForElement(element));
}

function elementFromComparisonData(data) {
  return data?.rawElement || data?.element || data;
}

/**
 * Working A側の現在属性と最後の明示比較snapshotから、canonical Wallペアの表示可否を解決する。
 * matched pairは通常描画と同様にA/Bどちらか一方が表示対象ならペア全体を残す。
 * B側要素をsnapshotから復元できない場合は、既知のmatched identityを誤って消さないため表示を維持する。
 */
export function isWallComparisonSnapshotVisible(elementA, snapshot = null) {
  const visibleA = isWallElementVisible(elementA);
  if (snapshot?.modelSource !== 'matched') return visibleA;

  const elementB = elementFromComparisonData(snapshot?.dataB);
  if (!elementB) return true;
  return visibleA || isWallElementVisible(elementB);
}

/**
 * 全StbWallの比較済み結果から描画専用viewを作る。正本の比較結果は変更しない。
 * kind_wallの異なる対応ペアは、どちらか一方が表示対象ならペアのまま残す。
 * 片側が非表示でもonlyA/onlyBへ移さず、ID・属性差・カテゴリを維持する。
 * merged形状は既存描画経路と同じA側を代表とし、B overlayは別途B側の種別で絞る。
 */
export function filterWallComparisonForDisplay(elementType, comparisonResult) {
  if (elementType !== 'Wall' || !comparisonResult) return comparisonResult;
  const displayResult = { ...comparisonResult };
  for (const category of MATCHED_CATEGORIES) {
    displayResult[category] = (comparisonResult[category] || []).filter(
      (pair) =>
        isWallElementVisible(elementFromComparisonData(pair.dataA)) ||
        isWallElementVisible(elementFromComparisonData(pair.dataB)),
    );
  }
  for (const category of ONLY_CATEGORIES) {
    displayResult[category] = (comparisonResult[category] || []).filter((data) =>
      isWallElementVisible(elementFromComparisonData(data)),
    );
  }
  // 正規化結果のmatched getterと同じカテゴリ合成を、描画viewでも維持する。
  Object.defineProperty(displayResult, 'matched', {
    enumerable: true,
    configurable: true,
    get() {
      return MATCHED_CATEGORIES.flatMap((category) => this[category]);
    },
  });
  return displayResult;
}
