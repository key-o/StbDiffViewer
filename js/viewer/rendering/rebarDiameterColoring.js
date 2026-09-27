/**
 * @fileoverview 3D鉄筋メッシュへ鉄筋径別色を適用する。
 *
 * 各generatorのgeometry/material契約を変えず、生成後のRebar meshを径別materialへ差し替える。
 * materialは「元material × 鉄筋径」で共有し、色変更時は既存materialをその場で更新する。
 */

import rebarDiameterColorManager, {
  normalizeRebarDiameterColorKey,
} from './rebarDiameterColorManager.js';

/** @type {Map<string, {material: import('three').Material, colorKey: string}>} */
const materialCache = new Map();

function recolorMaterial(material, colorKey) {
  if (!material?.color?.set) return material;
  material.color.set(rebarDiameterColorManager.getRebarDiameterColor(colorKey));
  material.needsUpdate = true;
  return material;
}

function materialForDiameter(sourceMaterial, colorKey) {
  if (!sourceMaterial?.clone || !sourceMaterial?.uuid) return sourceMaterial;
  const cacheKey = `${sourceMaterial.uuid}|${colorKey}`;
  let entry = materialCache.get(cacheKey);
  if (!entry) {
    const material = sourceMaterial.clone();
    material.name = `${sourceMaterial.name || sourceMaterial.type || 'rebar'}-${colorKey}`;
    entry = { material, colorKey };
    materialCache.set(cacheKey, entry);
  }
  return recolorMaterial(entry.material, colorKey);
}

/**
 * 生成済み3D鉄筋メッシュへ径別色を適用する。
 * @param {Array<import('three').Object3D>} meshes
 * @returns {Array<import('three').Object3D>}
 */
export function applyRebarDiameterColors(meshes) {
  for (const mesh of meshes || []) {
    if (!mesh?.userData?.isRebar) continue;
    const colorKey = normalizeRebarDiameterColorKey(mesh.userData.barDiameterMm);
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((material) => materialForDiameter(material, colorKey));
    } else if (mesh.material) {
      mesh.material = materialForDiameter(mesh.material, colorKey);
    }
    mesh.userData.rebarDiameterColorKey = colorKey;
  }
  return meshes;
}

/** 鉄筋径色の変更を表示中meshへ即時反映する。 */
export function refreshRebarDiameterMaterialColors() {
  for (const { material, colorKey } of materialCache.values()) {
    recolorMaterial(material, colorKey);
  }
}

/** テスト・破棄用。 */
export function clearRebarDiameterMaterialCache() {
  for (const { material } of materialCache.values()) material?.dispose?.();
  materialCache.clear();
}

rebarDiameterColorManager.onColorChange(() => refreshRebarDiameterMaterialColors());
