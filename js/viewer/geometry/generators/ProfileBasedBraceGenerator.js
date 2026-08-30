/**
 * @fileoverview プロファイルベースブレース形状生成モジュール（リファクタリング版）
 *
 * BaseElementGeneratorを継承した統一アーキテクチャ:
 * - MeshCreationValidator: バリデーション
 * - MeshMetadataBuilder: メタデータ構築
 * - sectionTypeUtil: 断面タイプ正規化
 *
 * ブレース特有の機能:
 * - 中心配置（placementMode: 'center'）
 * - 斜め配置への対応
 *
 * リファクタリング: 2025-12
 * - BaseElementGenerator基底クラスを使用
 * - 統一されたバリデーションとメタデータ構築
 */

import * as THREE from 'three';
import { createExtrudeGeometry } from '../core/ThreeJSConverter.js';
import { colorManager } from '../../rendering/colorManager.js';
import { getNodePositions } from '../core/ElementNodeResolver.js';
import { getSectionData } from '../core/ElementSectionResolver.js';
import {
  calculateHorizontalElementPlacement,
  getHorizontalElementOffsets,
} from '../core/ElementPlacementResolver.js';
import { createProfileFromSectionData } from '../core/SectionProfileFactory.js';
import { BaseElementGenerator } from '../core/BaseElementGenerator.js';
import { MeshMetadataBuilder } from '../core/MeshMetadataBuilder.js';

/**
 * プロファイルベースのブレース形状生成
 */
export class ProfileBasedBraceGenerator extends BaseElementGenerator {
  /**
   * ジェネレーター設定
   */
  static getConfig() {
    return {
      elementName: 'Brace',
      loggerName: 'viewer:profile:brace',
      defaultElementType: 'Brace',
    };
  }

  /**
   * ブレース要素からメッシュを作成
   * @param {Array} braceElements - ブレース要素配列
   * @param {Map<string, THREE.Vector3>} nodes - ノードマップ
   * @param {Map<string, Object>} braceSections - ブレース断面マップ
   * @param {Map<string, Object>} steelSections - 鋼材形状マップ
   * @param {string} elementType - 要素タイプ
   * @param {boolean} isJsonInput - JSON入力かどうか
   * @returns {Array<THREE.Mesh>} 生成されたメッシュ配列
   */
  static createBraceMeshes(
    braceElements,
    nodes,
    braceSections,
    steelSections,
    elementType = 'Brace',
    isJsonInput = false,
  ) {
    return this.createMeshes(
      braceElements,
      nodes,
      braceSections,
      steelSections,
      elementType,
      isJsonInput,
    );
  }

  /**
   * 単一ブレースメッシュを作成
   * @param {Object} brace - ブレース要素
   * @param {Object} context - コンテキスト
   * @returns {THREE.Mesh|null} メッシュまたはnull
   */
  static _createSingleMesh(brace, context) {
    const { nodes, sections, elementType, isJsonInput, log } = context;

    // 1. ノード位置の取得
    const nodePositions = getNodePositions(brace, nodes, {
      nodeType: '2node-horizontal',
      isJsonInput: isJsonInput,
      node1KeyStart: 'id_node_start',
      node1KeyEnd: 'id_node_end',
    });

    if (!this._validateNodePositions(nodePositions, brace, context)) {
      return null;
    }

    // 2. 断面データの取得
    const sectionData = getSectionData(brace, sections, isJsonInput);

    if (!this._validateSectionData(sectionData, brace, context)) {
      return null;
    }

    // 3. 断面タイプの推定
    const sectionType = this._resolveGeometryProfileType(sectionData);

    log.debug(`Creating brace ${brace.id}: section_type=${sectionType}`);

    // 4. オフセットと回転角度の取得
    const offsets = getHorizontalElementOffsets(brace);

    // 5. 配置計算
    // ブレースは中心配置
    const placement = calculateHorizontalElementPlacement(
      nodePositions.startNode,
      nodePositions.endNode,
      {
        startOffset: offsets.startOffset,
        endOffset: offsets.endOffset,
        rollAngle: (offsets.rollAngle * Math.PI) / 180, // 度→ラジアン
        placementMode: 'center',
        sectionHeight: 0,
      },
    );

    if (!this._validatePlacement(placement, brace, context)) {
      return null;
    }

    // 6. プロファイル生成
    const profileResult = createProfileFromSectionData(sectionData, sectionType, brace, log);

    if (!this._validateProfile(profileResult, brace, context)) {
      return null;
    }

    // 7. 押し出しジオメトリを作成
    const geometry = createExtrudeGeometry(profileResult.shape, placement.length);

    if (!this._validateGeometry(geometry, brace, context)) {
      return null;
    }

    // 7.5. 材軸（Z軸）回りの断面回転をジオメトリに適用
    // rotate属性は配置基準線（材軸）を中心に断面を回転させる
    if (placement.rollAngle && placement.rollAngle !== 0) {
      geometry.rotateZ(placement.rollAngle);
    }

    // 8. メッシュを作成
    const mesh = new THREE.Mesh(
      geometry,
      colorManager.getMaterial('diff', { comparisonState: 'matched' }),
    );

    // 9. 配置を適用
    mesh.position.copy(placement.center);
    mesh.quaternion.copy(placement.rotation);

    // 10. メタデータを設定（MeshMetadataBuilder使用）
    mesh.userData = MeshMetadataBuilder.build({
      element: brace,
      elementType: elementType,
      placement: placement,
      sectionType: sectionType,
      profileResult: profileResult,
      sectionData: sectionData,
      isJsonInput: isJsonInput,
      extraData: {
        placementMode: 'center',
      },
    });

    log.debug(
      `Brace ${brace.id}: length=${placement.length.toFixed(1)}mm, ` + `sectionType=${sectionType}`,
    );

    return mesh;
  }
}

// デフォルトエクスポート用のレガシーインターフェース
export function createBraceMeshes(
  braceElements,
  nodes,
  braceSections,
  steelSections,
  elementType = 'Brace',
  isJsonInput = false,
) {
  return ProfileBasedBraceGenerator.createBraceMeshes(
    braceElements,
    nodes,
    braceSections,
    steelSections,
    elementType,
    isJsonInput,
  );
}
