/**
 * @fileoverview 基礎形状生成モジュール（リファクタリング版）
 *
 * BaseElementGeneratorを継承した統一アーキテクチャ:
 * - 単一ノード（id_node）+ level_bottom属性による配置
 * - STB形式とJSON形式の両対応
 * - 直方体形状（width_X, width_Y, depth）
 * - 地中配置（負のZ座標）対応
 *
 * リファクタリング: 2025-12
 * - BaseElementGenerator基底クラスを使用
 * - 統一されたバリデーションとメタデータ構築
 */

import * as THREE from 'three';
import { colorManager } from '../../rendering/colorManager.js';
import { getNodePositions } from '../core/ElementNodeResolver.js';
import { getSectionData } from '../core/ElementSectionResolver.js';
import {
  calculateSingleNodePlacement,
  getOffsetAndRotation,
} from '../core/ElementPlacementResolver.js';
import { MeshMetadataBuilder } from '../core/MeshMetadataBuilder.js';
import { BaseElementGenerator } from '../core/BaseElementGenerator.js';

/**
 * 基礎形状生成クラス
 */
export class FootingGenerator extends BaseElementGenerator {
  /**
   * ジェネレーター設定
   */
  static getConfig() {
    return {
      elementName: 'Footing',
      loggerName: 'viewer:geometry:footing',
      defaultElementType: 'Footing',
    };
  }

  /**
   * 基礎要素からメッシュを作成
   * @param {Array} footingElements - 基礎要素配列
   * @param {Map<string, THREE.Vector3>} nodes - ノードマップ
   * @param {Map<string, Object>} footingSections - 基礎断面マップ
   * @param {Map<string, Object>} steelSections - 鋼材形状マップ（未使用だがインターフェース統一のため）
   * @param {string} elementType - 要素タイプ（デフォルト: "Footing"）
   * @param {boolean} isJsonInput - JSON入力かどうか
   * @returns {Array<THREE.Mesh>} 生成されたメッシュ配列
   */
  static createFootingMeshes(
    footingElements,
    nodes,
    footingSections,
    steelSections,
    elementType = 'Footing',
    isJsonInput = false,
  ) {
    return this.createMeshes(
      footingElements,
      nodes,
      footingSections,
      steelSections,
      elementType,
      isJsonInput,
    );
  }

  /**
   * 単一基礎メッシュを作成（BaseElementGeneratorの抽象メソッドを実装）
   * @param {Object} footing - 基礎要素
   * @param {Object} context - コンテキスト
   * @returns {THREE.Mesh|null} メッシュまたはnull
   */
  static _createSingleMesh(footing, context) {
    const { nodes, sections, elementType, isJsonInput, log } = context;

    // 1. ノード位置の取得
    const nodePositions = getNodePositions(footing, nodes, {
      nodeType: '1node',
      isJsonInput: isJsonInput,
      node1Key: 'id_node',
    });

    if (!this._validateNodePositions(nodePositions, footing, context)) {
      return null;
    }

    // 2. 断面データの取得
    const sectionData = getSectionData(footing, sections, isJsonInput);

    if (!this._validateSectionData(sectionData, footing, context)) {
      return null;
    }

    // 3. 断面寸法の取得
    const dimensions = sectionData.dimensions || sectionData;

    // 基礎の寸法（STB属性名に対応）
    const widthX = dimensions.width_X || dimensions.outer_width || dimensions.width || 1000; // mm
    const widthY = dimensions.width_Y || dimensions.overall_depth || dimensions.height || 1000; // mm
    const depth = dimensions.depth || dimensions.overall_height || 1500; // mm

    if (!widthX || !widthY || !depth) {
      log.warn(
        `Skipping footing ${footing.id}: Invalid dimensions (widthX=${widthX}, widthY=${widthY}, depth=${depth})`,
      );
      return null;
    }

    log.debug(`Creating footing ${footing.id}: ${widthX}×${widthY}×${depth}mm`);

    // 4. level_bottom の取得
    const levelBottom = footing.level_bottom || 0;

    // 5. オフセットと回転の取得
    const offsetAndRotation = getOffsetAndRotation(footing);

    // 6. 配置計算（1ノード要素専用ロジック）
    const placement = calculateSingleNodePlacement(nodePositions.node, levelBottom, depth, {
      offset: offsetAndRotation.startOffset,
      rotation: (offsetAndRotation.rollAngle * Math.PI) / 180, // 度→ラジアン変換
    });

    log.debug(
      `Footing ${footing.id}: position=(${placement.position.x.toFixed(
        0,
      )}, ${placement.position.y.toFixed(0)}, ${placement.position.z.toFixed(0)}), ` +
        `bottomZ=${placement.bottomZ.toFixed(0)}, topZ=${placement.topZ.toFixed(0)}`,
    );

    // 7. 直方体ジオメトリを作成
    const geometry = new THREE.BoxGeometry(widthX, widthY, depth);

    if (!this._validateGeometry(geometry, footing, context)) {
      return null;
    }

    // 8. メッシュ作成
    const mesh = new THREE.Mesh(
      geometry,
      colorManager.getMaterial('diff', { comparisonState: 'matched' }),
    );
    mesh.userData = MeshMetadataBuilder.build({
      element: footing,
      elementType,
      placement: { length: depth },
      sectionType: 'RECTANGLE',
      profileResult: {
        meta: { profileSource: 'BoxGeometry', profileType: 'RECTANGLE' },
      },
      sectionData,
      isJsonInput,
    });

    // 9. 配置を適用
    mesh.position.copy(placement.position);
    mesh.quaternion.setFromEuler(placement.rotation);

    // 10. 追加メタデータ（基礎固有情報）
    mesh.userData.footingData = {
      widthX: widthX,
      widthY: widthY,
      depth: depth,
      levelBottom: levelBottom,
      bottomZ: placement.bottomZ,
      topZ: placement.topZ,
    };

    return mesh;
  }
}

// デバッグ・開発支援
if (typeof window !== 'undefined') {
  window.FootingGenerator = FootingGenerator;
}

export default FootingGenerator;
