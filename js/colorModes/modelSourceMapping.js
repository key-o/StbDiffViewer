/**
 * @fileoverview モデル由来情報と差分表示状態の変換ヘルパー
 *
 * @module colorModes/modelSourceMapping
 */

/**
 * 3Dオブジェクトの modelSource を差分色管理の状態名へ正規化する。
 * @param {string|null|undefined} modelSource - 'A' | 'B' | 'matched' | 'onlyA' | 'onlyB' など
 * @returns {'matched'|'onlyA'|'onlyB'|string}
 */
export function normalizeModelSourceToComparisonState(modelSource) {
  switch (modelSource) {
    case 'A':
      return 'onlyA';
    case 'B':
      return 'onlyB';
    case 'solid':
    case 'line':
    case null:
    case undefined:
    case '':
      return 'matched';
    default:
      return modelSource;
  }
}

/**
 * 3Dオブジェクトの userData から getMaterialForElementWithMode 用の
 * マテリアルオプションを構築する。
 * 一括適用（applyColorModeToAllObjects）とロード後の再適用
 * （modelLoaderMaterialUpdate）で同一の内容を渡すために共有する。
 * @param {Object} userData - THREE.Object3D の userData
 * @returns {{isTransparent: boolean, srcComponentType: *, modelSource: *, diffStatus: *, positionState: *, attributeState: *}}
 */
export function buildMaterialOptionsFromUserData(userData) {
  return {
    isTransparent: userData.isSRCConcrete === true,
    srcComponentType: userData.srcComponentType || null,
    modelSource: userData.modelSource || null,
    diffStatus: userData.diffStatus || null,
    positionState: userData.positionState || null,
    attributeState: userData.attributeState || null,
  };
}
