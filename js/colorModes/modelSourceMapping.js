/**
 * @fileoverview モデル由来情報と差分表示状態の変換ヘルパー
 *
 * @module colorModes/modelSourceMapping
 */

/**
 * 3D配筋表示中は構造部材をSRC造RC部分と同等の半透明マテリアルへ切り替える。
 * 色付けモード変更・モデル再読込時にも同じ状態を再適用できるよう、
 * マテリアルオプション構築側で参照する共有状態として保持する。
 */
let rebarGhostActive = false;

/**
 * 配筋表示用の半透明（ghost）状態を設定する。
 * @param {boolean} active - 半透明表示を有効にするか
 * @returns {boolean} 状態が変化した場合 true
 */
export function setRebarGhostActive(active) {
  const next = Boolean(active);
  if (next === rebarGhostActive) return false;
  rebarGhostActive = next;
  return true;
}

/**
 * 配筋表示用の半透明（ghost）状態を返す。
 * @returns {boolean} 有効なら true
 */
export function isRebarGhostActive() {
  return rebarGhostActive;
}

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
 *
 * 配筋表示中は通常の構造部材も `isTransparent=true` とし、SRC造RC部分と
 * 同じ半透明マテリアル経路を使う。線要素は colorManager 側で線用マテリアルが
 * 優先されるため、通り芯・外形線などの視認性は維持される。
 * @param {Object} userData - THREE.Object3D の userData
 * @returns {{isTransparent: boolean, srcComponentType: *, modelSource: *, diffStatus: *, positionState: *, attributeState: *}}
 */
export function buildMaterialOptionsFromUserData(userData) {
  return {
    isTransparent: userData.isSRCConcrete === true || rebarGhostActive,
    srcComponentType: userData.srcComponentType || null,
    modelSource: userData.modelSource || null,
    diffStatus: userData.diffStatus || null,
    positionState: userData.positionState || null,
    attributeState: userData.attributeState || null,
  };
}
