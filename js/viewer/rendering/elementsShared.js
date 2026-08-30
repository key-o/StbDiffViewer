/**
 * @fileoverview 構造要素描画の共有ヘルパー
 *
 * 線要素 / ポリゴン要素 / 節点要素の各描画モジュールから共通で利用される
 * ヘルパー群を集約します：
 * - 断面ID取得・バリデーション連動の重要度解決
 * - 共有ジオメトリ（節点スフィア）とグループ破棄
 * - ラベルプロバイダー（依存性注入）の可変状態
 * - 座標バリデーション・重要度による視覚調整
 *
 * ラベルプロバイダーの可変状態はこのモジュールにのみ保持し、
 * 各描画モジュールはここから参照します（状態の複製禁止）。
 *
 * @module viewer/rendering/elementsShared
 */

import * as THREE from 'three';
import { createLogger } from '../../utils/logger.js';
import { IMPORTANCE_LEVELS } from '../../constants/importanceLevels.js';
import {
  getSectionValidation,
  getElementValidation,
} from '../../common-stb/validation/validationManager.js';

export const log = createLogger('viewer:elements');
export const LINE_ELEMENT_LABEL_OFFSET_MM = 150;

/**
 * 要素から id_section 属性を取得する
 * @param {Element|Object|null} element
 * @returns {string|null}
 */
export function getSectionIdFromElement(element) {
  if (!element) return null;
  if (typeof element.getAttribute === 'function') {
    return element.getAttribute('id_section');
  }
  return element.id_section ?? null;
}

/**
 * バリデーションエラーがある場合、重要度を REQUIRED に上書きする
 * sectionValidationMap および elementValidationMap（JSONスキーマエラー格納先）の両方をチェックする
 * @param {string} importance - 現在の重要度
 * @param {Element|Object|null} element
 * @returns {string} 解決済み重要度
 */
export function resolveImportanceWithSectionValidation(importance, element) {
  if (importance === IMPORTANCE_LEVELS.REQUIRED) return importance;
  const sectionId = getSectionIdFromElement(element);
  if (!sectionId) return importance;
  // sectionValidationMap のチェック（セマンティックバリデーションエラー）
  const sectionValidation = getSectionValidation(sectionId);
  if (sectionValidation?.errors?.length > 0) return IMPORTANCE_LEVELS.REQUIRED;
  // elementValidationMap のチェック（JSONスキーマバリデーションエラーはここに格納される）
  const sectionElementValidation = getElementValidation(sectionId);
  if (sectionElementValidation?.errors?.length > 0) return IMPORTANCE_LEVELS.REQUIRED;
  return importance;
}

// ============================================
// 共有ジオメトリ（パフォーマンス最適化）
// ============================================

/** @type {THREE.SphereGeometry|null} */
let sharedNodeSphereGeometry = null;

/**
 * ノード用の共有SphereGeometryを取得
 * @returns {THREE.SphereGeometry}
 */
export function getSharedNodeSphereGeometry() {
  if (!sharedNodeSphereGeometry) {
    sharedNodeSphereGeometry = new THREE.SphereGeometry(50, 12, 8);
  }
  return sharedNodeSphereGeometry;
}

/**
 * グループ内の子要素のジオメトリを適切に破棄してからクリア
 * @param {THREE.Group} group - クリアするグループ
 */
export function disposeAndClearGroup(group) {
  // 子要素を逆順で処理（削除時のインデックス変更を避ける）
  while (group.children.length > 0) {
    const child = group.children[group.children.length - 1];

    // ジオメトリの破棄（共有ジオメトリは除く）
    if (child.geometry && child.geometry !== sharedNodeSphereGeometry) {
      child.geometry.dispose();
    }

    // 親から削除
    group.remove(child);
  }
}

// ============================================
// ラベル処理プロバイダー（依存性注入）
// ============================================

/**
 * @typedef {Object} ElementsLabelProvider
 * @property {function(Object, string): string} generateLabelText - ラベルテキスト生成
 * @property {function(THREE.Sprite, Object): void} attachElementDataToLabel - 要素データをラベルに付与
 * @property {function(string, THREE.Vector3, THREE.Group, string, Object=): THREE.Sprite|null} createLabelSprite - ラベルスプライト作成
 */

/** @type {ElementsLabelProvider|null} */
let elementsLabelProvider = null;

/**
 * ラベルプロバイダーを設定（依存性注入）
 * @param {ElementsLabelProvider} provider - ラベルプロバイダー
 */
export function setElementsLabelProvider(provider) {
  elementsLabelProvider = provider;
}

/**
 * ラベルスプライトを作成（プロバイダー経由）
 * @param {string} text - ラベルテキスト
 * @param {THREE.Vector3} position - 位置
 * @param {THREE.Group} group - グループ
 * @param {string} elementType - 要素タイプ
 * @param {Object} [meta] - メタ情報
 * @returns {THREE.Sprite|null}
 */
export function createLabelSpriteInternal(text, position, group, elementType, meta) {
  if (elementsLabelProvider && elementsLabelProvider.createLabelSprite) {
    return elementsLabelProvider.createLabelSprite(text, position, group, elementType, meta);
  }
  // プロバイダー未設定時はnull（初期化タイミングによる正常な状態）
  return null;
}

/**
 * ラベルテキストを生成（プロバイダー経由）
 * @param {Object} element - 要素データ
 * @param {string} elementType - 要素タイプ
 * @returns {string} ラベルテキスト
 */
export function generateLabelTextInternal(element, elementType) {
  if (elementsLabelProvider && elementsLabelProvider.generateLabelText) {
    return elementsLabelProvider.generateLabelText(element, elementType);
  }
  // フォールバック: 要素名またはID
  return element?.name || element?.id || '';
}

/**
 * 要素データをラベルに付与（プロバイダー経由）
 * @param {THREE.Sprite} sprite - ラベルスプライト
 * @param {Object} element - 要素データ
 */
export function attachElementDataToLabelInternal(sprite, element) {
  if (elementsLabelProvider && elementsLabelProvider.attachElementDataToLabel) {
    elementsLabelProvider.attachElementDataToLabel(sprite, element);
  }
}

/**
 * 1点の座標がすべて有限数かバリデートする
 * @param {Object} coords - 座標 {x, y, z}
 * @returns {boolean} 有効な場合true
 */
export function isValidPointCoords(coords) {
  return (
    coords && Number.isFinite(coords.x) && Number.isFinite(coords.y) && Number.isFinite(coords.z)
  );
}

/**
 * 始点・終点の両方が有効な座標かバリデートする
 * @param {Object} startCoords - 始点座標 {x, y, z}
 * @param {Object} endCoords - 終点座標 {x, y, z}
 * @returns {boolean} 有効な場合true
 */
export function isValidLineCoords(startCoords, endCoords) {
  return isValidPointCoords(startCoords) && isValidPointCoords(endCoords);
}

/**
 * 重要度に基づいて要素の視覚的調整を適用する
 * @param {THREE.Object3D} object - 調整対象の3Dオブジェクト
 * @param {string} importance - 重要度レベル
 */
export function applyImportanceVisuals(object, importance) {
  if (!importance) return;

  // 重要度に応じた透明度設定
  const opacityLevels = {
    [IMPORTANCE_LEVELS.REQUIRED]: 1.0,
    [IMPORTANCE_LEVELS.OPTIONAL]: 1.0,
    [IMPORTANCE_LEVELS.UNNECESSARY]: 1.0,
    [IMPORTANCE_LEVELS.NOT_APPLICABLE]: 0.1,
  };

  const targetOpacity = opacityLevels[importance] || 1.0;

  if (object.material) {
    if (Array.isArray(object.material)) {
      // マテリアル配列の場合
      object.material.forEach((mat) => {
        mat.opacity = targetOpacity;
        mat.transparent = targetOpacity < 1.0;
      });
    } else {
      // 単一マテリアルの場合
      object.material.opacity = targetOpacity;
      object.material.transparent = targetOpacity < 1.0;
    }
  }

  // userDataに重要度情報を記録
  object.userData.importance = importance;
}
