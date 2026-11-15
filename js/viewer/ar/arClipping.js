/**
 * @fileoverview ARセッションへのクリッピング状態引き継ぎユーティリティ（FR-5.4）
 *
 * 通常ビューのクリッピング（階・通り芯・セクションボックス）は
 * renderer.clippingPlanes にワールド座標（mm・Z-up）のグローバル平面として
 * 設定される。AR中はモデルが ARルート（_arRoot）配下で回転・縮尺・移動される
 * ため、グローバル平面のままではモデルと位置が合わず、レティクル等の
 * AR用オブジェクトまでクリップされてしまう。
 *
 * そこでAR中は、平面をモデルの要素グループのマテリアルに限定して適用し、
 * ARルートの matrixWorld で毎フレーム変換して追従させる。
 * DOM・レンダラー非依存の純粋なユーティリティとして分離し、
 * ユニットテストを可能にしている。
 */

/**
 * クリッピング平面配列を複製する
 * @param {import('three').Plane[]} planes - 複製元の平面配列
 * @returns {import('three').Plane[]} 各平面を clone した新しい配列
 */
export function cloneClippingPlanes(planes) {
  return planes.map((plane) => plane.clone());
}

/**
 * モデル座標系の平面をAR空間（ワールド座標系）の平面へ変換する
 *
 * targetPlanes の各平面を「sourcePlanes を matrix で変換した値」で
 * in-place 更新する。マテリアルが保持している Plane インスタンスを
 * 差し替えずに値だけ更新するための形。
 * @param {import('three').Plane[]} sourcePlanes - モデル座標系（mm・Z-up）の平面
 * @param {import('three').Matrix4} matrix - ARルートの matrixWorld
 * @param {import('three').Plane[]} targetPlanes - 更新対象（sourcePlanes と同数）
 */
export function transformClippingPlanes(sourcePlanes, matrix, targetPlanes) {
  const count = Math.min(sourcePlanes.length, targetPlanes.length);
  for (let i = 0; i < count; i++) {
    targetPlanes[i].copy(sourcePlanes[i]).applyMatrix4(matrix);
  }
}

/**
 * 要素グループ配下の全マテリアルへクリッピング平面を設定する
 * @param {Object<string, import('three').Object3D>} groups - elementGroups
 * @param {import('three').Plane[]|null} planes - 設定する平面（null で解除）
 */
export function setElementGroupsClippingPlanes(groups, planes) {
  Object.values(groups).forEach((group) => {
    if (!group || typeof group.traverse !== 'function') return;
    group.traverse((child) => {
      if (!child.material) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        material.clippingPlanes = planes;
        material.needsUpdate = true;
      }
    });
  });
}

/** AR開始前の個別マテリアルのクリッピング配列を参照ごと退避する。 */
export function captureElementGroupsMaterialClipping(groups) {
  const saved = new Map();
  Object.values(groups).forEach((group) => {
    group?.traverse?.((child) => {
      if (!child.material) return;
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if (!saved.has(material)) saved.set(material, material.clippingPlanes);
      }
    });
  });
  return saved;
}

/** AR中に付け替えた平面を解除し、材質固有の設定をそのまま戻す。 */
export function restoreElementGroupsMaterialClipping(saved) {
  for (const [material, planes] of saved) {
    material.clippingPlanes = planes;
    material.needsUpdate = true;
  }
}
