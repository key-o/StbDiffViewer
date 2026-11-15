/**
 * @fileoverview リソース解放モジュール
 *
 * Three.jsオブジェクトの再帰的なリソース解放を提供します。
 * ネストされた子要素、ジオメトリ、マテリアル、テクスチャを
 * 適切に解放してメモリリークを防止します。
 */

import { createLogger } from '../../utils/logger.js';

const log = createLogger('viewer:ResourceDisposer');

/**
 * マテリアルを解放
 * @param {THREE.Material} material
 */
export function disposeMaterial(material, preserved = new Set()) {
  if (!material || preserved.has(material)) return;

  // テクスチャを解放
  for (const key of Object.keys(material)) {
    const value = material[key];
    if (value && value.isTexture && !preserved.has(value)) {
      value.dispose();
    }
  }

  // マテリアル本体を解放
  material.dispose();
}

/**
 * 3Dオブジェクトを再帰的に解放
 * @param {THREE.Object3D} object - 解放するオブジェクト
 * @param {Object} [options] - オプション
 * @param {boolean} [options.removeFromParent=true] - 親から削除するか
 * @param {boolean} [options.disposeGeometry=true] - ジオメトリを解放するか
 * @param {boolean} [options.disposeMaterial=true] - マテリアルを解放するか
 * @returns {number} 解放したオブジェクト数
 */
export function disposeRecursive(object, options = {}) {
  if (!object) return 0;

  const {
    removeFromParent = true,
    disposeGeometry = true,
    disposeMaterial: shouldDisposeMaterial = true,
    preservedResources = new Set(),
  } = options;

  let disposedCount = 0;

  // 子要素を先に解放（後ろから処理して配列変更の影響を回避）
  while (object.children.length > 0) {
    const child = object.children[object.children.length - 1];
    disposedCount += disposeRecursive(child, {
      removeFromParent: true,
      disposeGeometry,
      disposeMaterial: shouldDisposeMaterial,
      preservedResources,
    });
  }

  // ジオメトリ解放
  if (disposeGeometry && object.geometry && !preservedResources.has(object.geometry)) {
    object.geometry.dispose();
    disposedCount++;
  }

  // マテリアル解放
  if (shouldDisposeMaterial && object.material) {
    if (Array.isArray(object.material)) {
      object.material.forEach((mat) => disposeMaterial(mat, preservedResources));
    } else {
      disposeMaterial(object.material, preservedResources);
    }
    disposedCount++;
  }

  // 親から削除
  if (removeFromParent && object.parent) {
    object.parent.remove(object);
  }

  return disposedCount;
}

/**
 * 要素グループを解放
 * @param {Object<string, THREE.Group>} elementGroups - 要素グループ
 * @returns {number} 解放したオブジェクト数
 */
export function disposeElementGroups(elementGroups) {
  if (!elementGroups) return 0;

  let totalDisposed = 0;

  for (const type in elementGroups) {
    if (!Object.prototype.hasOwnProperty.call(elementGroups, type)) continue;

    const group = elementGroups[type];
    if (!group) continue;

    // 子要素を解放（グループ自体は保持）
    while (group.children.length > 0) {
      const child = group.children[group.children.length - 1];
      totalDisposed += disposeRecursive(child, {
        removeFromParent: true,
        disposeGeometry: true,
        disposeMaterial: true,
      });
    }
  }

  log.info(`Disposed ${totalDisposed} resources from element groups`);
  return totalDisposed;
}

/**
 * ラベル（スプライト）配列を解放
 * @param {THREE.Sprite[]} labels - ラベル配列
 * @returns {number} 解放した数
 */
export function disposeLabels(labels) {
  if (!labels || !Array.isArray(labels)) return 0;

  let disposed = 0;

  for (const label of labels) {
    if (!label) continue;

    // テクスチャ解放
    if (label.material && label.material.map) {
      label.material.map.dispose();
    }

    // マテリアル解放
    if (label.material) {
      label.material.dispose();
    }

    // 親から削除
    if (label.parent) {
      label.parent.remove(label);
    }

    disposed++;
  }

  // 配列をクリア
  labels.length = 0;

  return disposed;
}

/**
 * シーン全体をクリーンアップ
 * @param {THREE.Scene} scene
 * @param {Object} [options]
 * @param {string[]} [options.preserveTypes] - 保持するオブジェクトタイプ
 * @returns {number} 解放したオブジェクト数
 */
export function cleanupScene(scene, options = {}) {
  if (!scene) return 0;

  const { preserveTypes = ['AmbientLight', 'DirectionalLight', 'HemisphereLight'] } = options;

  let disposed = 0;
  const toRemove = [];

  // 削除対象を収集
  scene.traverse((object) => {
    if (object === scene) return;

    const typeName = object.constructor.name;
    if (preserveTypes.includes(typeName)) return;

    // グループの場合は中身だけ削除
    if (object.isGroup && object.parent === scene) {
      return;
    }

    toRemove.push(object);
  });

  // 削除実行
  for (const object of toRemove) {
    disposed += disposeRecursive(object);
  }

  log.info(`Scene cleanup: disposed ${disposed} objects`);
  return disposed;
}

/**
 * 解放可能なリソースの統計を取得
 * @param {THREE.Scene} scene
 * @returns {Object}
 */
export function getResourceStats(scene) {
  if (!scene) {
    return { geometries: 0, materials: 0, textures: 0, meshes: 0 };
  }

  const stats = {
    geometries: new Set(),
    materials: new Set(),
    textures: new Set(),
    meshes: 0,
  };

  scene.traverse((object) => {
    if (object.geometry) {
      stats.geometries.add(object.geometry.uuid);
    }

    if (object.material) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];

      for (const mat of materials) {
        stats.materials.add(mat.uuid);

        for (const key of Object.keys(mat)) {
          const value = mat[key];
          if (value && value.isTexture) {
            stats.textures.add(value.uuid);
          }
        }
      }
    }

    if (object.isMesh) {
      stats.meshes++;
    }
  });

  return {
    geometries: stats.geometries.size,
    materials: stats.materials.size,
    textures: stats.textures.size,
    meshes: stats.meshes,
  };
}
