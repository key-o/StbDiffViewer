/**
 * @fileoverview 杭形状生成モジュール（リファクタリング版）
 *
 * BaseElementGeneratorを継承した統一アーキテクチャ:
 * - MeshCreationValidator: バリデーション
 * - MeshMetadataBuilder: メタデータ構築
 * - sectionTypeUtil: 断面タイプ正規化
 *
 * 杭特有の機能:
 * - 1-node / 2-node 両フォーマット対応
 * - 拡底杭（ExtendedFoot, ExtendedTop, ExtendedTopFoot）対応
 * - 地中配置（負のZ座標）対応
 *
 * リファクタリング: 2025-12
 * - BaseElementGenerator基底クラスを使用
 * - 統一されたバリデーションとメタデータ構築
 */

import * as THREE from 'three';
import { calculateCircleProfile } from '../core/ProfileCalculator.js';
import { createExtrudeGeometry } from '../core/ThreeJSConverter.js';
import {
  createTaperedGeometry,
  createMultiSectionGeometry,
} from '../core/TaperedGeometryBuilder.js';
import { colorManager } from '../../rendering/colorManager.js';
import { getNodePositions } from '../core/ElementNodeResolver.js';
import { getSectionData } from '../core/ElementSectionResolver.js';
import {
  calculateDualNodePlacement,
  getOffsetAndRotation,
} from '../core/ElementPlacementResolver.js';
import { createProfileFromSectionData } from '../core/SectionProfileFactory.js';
import { isExtendedPile } from '../../../common-stb/import/data/dimensionNormalizer.js';
import { BaseElementGenerator } from '../core/BaseElementGenerator.js';
import { MeshMetadataBuilder } from '../core/MeshMetadataBuilder.js';

/**
 * 杭形状生成クラス
 */
export class PileGenerator extends BaseElementGenerator {
  /**
   * ジェネレーター設定
   */
  static getConfig() {
    return {
      elementName: 'Pile',
      loggerName: 'viewer:geometry:pile',
      defaultElementType: 'Pile',
    };
  }

  /**
   * 杭要素からメッシュを作成
   * @param {Array} pileElements - 杭要素配列
   * @param {Map<string, THREE.Vector3>} nodes - ノードマップ
   * @param {Map<string, Object>} pileSections - 杭断面マップ
   * @param {Map<string, Object>} steelSections - 鋼材形状マップ（未使用だがインターフェース統一のため）
   * @param {string} elementType - 要素タイプ（デフォルト: "Pile"）
   * @param {boolean} isJsonInput - JSON入力かどうか
   * @returns {Array<THREE.Mesh>} 生成されたメッシュ配列
   */
  static createPileMeshes(
    pileElements,
    nodes,
    pileSections,
    steelSections,
    elementType = 'Pile',
    isJsonInput = false,
  ) {
    return this.createMeshes(
      pileElements,
      nodes,
      pileSections,
      steelSections,
      elementType,
      isJsonInput,
    );
  }

  /**
   * 単一杭メッシュを作成
   * @param {Object} pile - 杭要素
   * @param {Object} context - コンテキスト
   * @returns {THREE.Mesh|null} メッシュまたはnull
   */
  static _createSingleMesh(pile, context) {
    const { nodes, sections, elementType, isJsonInput, log } = context;

    // 1. 断面データの取得（1-node format時に長さ情報が必要なため先に取得）
    const sectionData = getSectionData(pile, sections, isJsonInput);

    if (!this._validateSectionData(sectionData, pile, context)) {
      return null;
    }

    // 2. ノード位置の取得
    const nodePositions = this._getNodePositions(pile, nodes, sectionData, isJsonInput, log);

    if (!this._validateNodePositions(nodePositions, pile, context)) {
      return null;
    }

    // 3. 断面タイプの推定
    const sectionType = this._resolveGeometryProfileType(sectionData);
    const dims = sectionData.dimensions || {};

    log.debug(
      `Creating pile ${pile.id}: section_type=${sectionType}, kind=${pile.kind}, pile_type=${dims.pile_type || 'Straight'}`,
    );

    // 4. オフセットと回転の取得
    const offsetAndRotation = getOffsetAndRotation(pile);

    // 5. 配置計算
    // 注: 1ノード形式では_getNodePositionsでオフセットを既に適用済み
    const placement = calculateDualNodePlacement(nodePositions.bottomNode, nodePositions.topNode, {
      // オフセットが既に適用されている場合はスキップ（二重適用防止）
      startOffset: nodePositions.offsetsApplied ? { x: 0, y: 0 } : offsetAndRotation.startOffset,
      endOffset: nodePositions.offsetsApplied ? { x: 0, y: 0 } : offsetAndRotation.endOffset,
      rollAngle: offsetAndRotation.rollAngle,
    });

    if (!this._validatePlacement(placement, pile, context)) {
      return null;
    }

    log.debug(`Pile ${pile.id}: length=${placement.length.toFixed(1)}mm`);

    // 6. ジオメトリ生成
    let geometry = null;
    let profileMeta = null;

    // 拡底杭の判定
    if (isExtendedPile(dims) && dims.pile_type !== 'Straight') {
      // 拡底杭: テーパージオメトリを生成
      geometry = this._createExtendedPileGeometry(dims, placement.length, pile.id, log);
      profileMeta = {
        profileSource: 'extended-pile',
        pileType: dims.pile_type,
      };
    } else {
      // 通常杭: 単一断面の押し出しジオメトリ
      const profileResult = createProfileFromSectionData(sectionData, sectionType, pile, log);

      if (!this._validateProfile(profileResult, pile, context)) {
        return null;
      }

      geometry = createExtrudeGeometry(profileResult.shape, placement.length);
      profileMeta = profileResult.meta;
    }

    if (!this._validateGeometry(geometry, pile, context)) {
      return null;
    }

    // 7. メッシュ作成
    const mesh = new THREE.Mesh(
      geometry,
      colorManager.getMaterial('diff', { comparisonState: 'matched' }),
    );

    // 8. 配置を適用
    mesh.position.copy(placement.center);
    mesh.quaternion.copy(placement.rotation);

    // 9. メタデータを設定（MeshMetadataBuilder使用）
    mesh.userData = MeshMetadataBuilder.buildForPile({
      element: pile,
      elementType: elementType,
      placement: placement,
      sectionType: sectionType,
      profileResult: { shape: null, meta: profileMeta },
      sectionData: sectionData,
      isJsonInput: isJsonInput,
      pileType: dims.pile_type || 'Straight',
    });

    return mesh;
  }

  /**
   * ノード位置を取得（1-node / 2-node 両対応）
   * @private
   */
  static _getNodePositions(pile, nodes, sectionData, isJsonInput, log) {
    // 1-node format (id_node + level_top)
    if (pile.pileFormat === '1node') {
      const topNode = nodes.get(pile.id_node);
      if (!topNode) {
        log.warn(`Skipping pile ${pile.id}: Node ${pile.id_node} not found`);
        return { valid: false };
      }

      // Extract pile length
      let pileLength = 0;
      const dims = sectionData.dimensions || {};

      // length_all が有効（0より大きい）場合は使用
      const lengthAll = parseFloat(pile.length_all);
      if (pile.length_all !== undefined && pile.length_all !== null && lengthAll > 0) {
        pileLength = lengthAll;
        log.debug(`Pile ${pile.id}: Using length_all=${pileLength}mm from element attribute`);
      } else if (dims.length_pile && dims.length_pile > 0) {
        // 断面データのlength_pileにフォールバック（鋼管杭・既製杭のセグメント合計長）
        pileLength = parseFloat(dims.length_pile);
        log.debug(`Pile ${pile.id}: Using length_pile=${pileLength}mm from section dimensions`);
      } else if (dims.D || dims.diameter) {
        const diameter = dims.D || dims.diameter;
        pileLength = parseFloat(diameter) * 20;
        log.warn(`Pile ${pile.id}: No explicit length, estimating ${pileLength}mm (20×diameter)`);
      } else {
        log.warn(`Pile ${pile.id}: Cannot determine pile length`);
        return { valid: false };
      }

      const topNodePos = {
        x: topNode.x + (pile.offset_X || 0),
        y: topNode.y + (pile.offset_Y || 0),
        z: topNode.z + (pile.level_top || 0),
      };

      const bottomNode = {
        x: topNodePos.x,
        y: topNodePos.y,
        z: topNodePos.z - pileLength,
      };

      log.debug(`Pile ${pile.id} (1-node format): length=${pileLength}mm`);

      return {
        type: '2node-vertical',
        bottomNode: bottomNode,
        topNode: topNodePos,
        valid: true,
        offsetsApplied: true, // 1ノード形式ではオフセットを既に適用済み
      };
    }

    // 2-node format (id_node_bottom + id_node_top)
    const result = getNodePositions(pile, nodes, {
      nodeType: '2node-vertical',
      isJsonInput: isJsonInput,
      node1KeyStart: 'id_node_bottom',
      node1KeyEnd: 'id_node_top',
    });
    // 2ノード形式ではオフセットは適用されていない
    if (result.valid) {
      result.offsetsApplied = false;
    }
    return result;
  }

  /**
   * 拡底杭のテーパージオメトリを生成
   * @private
   * @param {Object} dims - 寸法データ（pile_type, D_axial, D_extended_foot, etc.）
   * @param {number} length - 杭長さ（mm）
   * @param {string} pileId - デバッグ用の杭ID
   * @param {Object} log - ロガー
   * @returns {THREE.BufferGeometry|null} テーパージオメトリまたはnull
   */
  static _createExtendedPileGeometry(dims, length, pileId, log) {
    const pileType = dims.pile_type;
    const D_axial = dims.D_axial || dims.diameter || dims.D;

    if (!D_axial) {
      log.warn(`Pile ${pileId}: Missing D_axial for extended pile`);
      return null;
    }

    log.debug(
      `Creating extended pile geometry: type=${pileType}, D_axial=${D_axial}, length=${length}`,
    );

    // 円形プロファイル生成のヘルパー（segments=32で生成）
    const createCircle = (diameter) => {
      const profile = calculateCircleProfile({ radius: diameter / 2, segments: 32 });
      return { vertices: profile.vertices, holes: [] };
    };

    try {
      switch (pileType) {
        case 'ExtendedFoot': {
          const D_foot = dims.D_extended_foot;
          const footLength = dims.length_extended_foot || 0;
          const taperAngle = dims.angle_extended_foot_taper || 0;

          if (!D_foot) {
            log.warn(`Pile ${pileId}: Missing D_extended_foot`);
            return null;
          }

          let taperLength = 0;
          if (taperAngle > 0) {
            const radiusDiff = (D_foot - D_axial) / 2;
            taperLength = radiusDiff / Math.tan((taperAngle * Math.PI) / 180);
          }

          log.debug(
            `ExtendedFoot: D_foot=${D_foot}, footLength=${footLength}, ` +
              `taperAngle=${taperAngle}°, taperLength=${taperLength.toFixed(1)}`,
          );

          if (taperLength > 0) {
            const sections = [
              { pos: 'TOP', profile: createCircle(D_axial) },
              { pos: 'CENTER', profile: createCircle(D_axial) },
              { pos: 'BOTTOM', profile: createCircle(D_foot) },
            ];

            return createMultiSectionGeometry(sections, length, {
              start: 0,
              end: footLength + taperLength,
            });
          } else {
            const topProfile = createCircle(D_axial);
            const bottomProfile = createCircle(D_foot);
            return createTaperedGeometry(topProfile, bottomProfile, length, { segments: 8 });
          }
        }

        case 'ExtendedTop': {
          const D_top = dims.D_extended_top;
          const taperAngle = dims.angle_extended_top_taper || 0;

          if (!D_top) {
            log.warn(`Pile ${pileId}: Missing D_extended_top`);
            return null;
          }

          let taperLength = 0;
          if (taperAngle > 0) {
            const radiusDiff = (D_top - D_axial) / 2;
            taperLength = radiusDiff / Math.tan((taperAngle * Math.PI) / 180);
          }

          log.debug(
            `ExtendedTop: D_top=${D_top}, taperAngle=${taperAngle}°, taperLength=${taperLength.toFixed(1)}`,
          );

          if (taperLength > 0) {
            const sections = [
              { pos: 'TOP', profile: createCircle(D_top) },
              { pos: 'CENTER', profile: createCircle(D_axial) },
              { pos: 'BOTTOM', profile: createCircle(D_axial) },
            ];

            return createMultiSectionGeometry(sections, length, {
              start: taperLength,
              end: 0,
            });
          } else {
            const topProfile = createCircle(D_top);
            const bottomProfile = createCircle(D_axial);
            return createTaperedGeometry(topProfile, bottomProfile, length, { segments: 8 });
          }
        }

        case 'ExtendedTopFoot': {
          const D_top = dims.D_extended_top;
          const D_foot = dims.D_extended_foot;
          const footLength = dims.length_extended_foot || 0;
          const topTaperAngle = dims.angle_extended_top_taper || 0;
          const footTaperAngle = dims.angle_extended_foot_taper || 0;

          if (!D_top || !D_foot) {
            log.warn(`Pile ${pileId}: Missing D_extended_top or D_extended_foot`);
            return null;
          }

          let topTaperLength = 0;
          if (topTaperAngle > 0) {
            const radiusDiff = (D_top - D_axial) / 2;
            topTaperLength = radiusDiff / Math.tan((topTaperAngle * Math.PI) / 180);
          }

          let footTaperLength = 0;
          if (footTaperAngle > 0) {
            const radiusDiff = (D_foot - D_axial) / 2;
            footTaperLength = radiusDiff / Math.tan((footTaperAngle * Math.PI) / 180);
          }

          log.debug(
            `ExtendedTopFoot: D_top=${D_top}, D_foot=${D_foot}, ` +
              `topTaper=${topTaperLength.toFixed(1)}, footTaper=${footTaperLength.toFixed(1)}`,
          );

          const sections = [
            { pos: 'TOP', profile: createCircle(D_top) },
            { pos: 'HAUNCH_S', profile: createCircle(D_axial) },
            { pos: 'CENTER', profile: createCircle(D_axial) },
            { pos: 'HAUNCH_E', profile: createCircle(D_axial) },
            { pos: 'BOTTOM', profile: createCircle(D_foot) },
          ];

          return createMultiSectionGeometry(sections, length, {
            start: topTaperLength,
            end: footLength + footTaperLength,
          });
        }

        default:
          log.warn(`Pile ${pileId}: Unknown extended pile type: ${pileType}`);
          return null;
      }
    } catch (error) {
      log.error(`Pile ${pileId}: Failed to create extended pile geometry:`, error);
      return null;
    }
  }
}

// デバッグ・開発支援
if (typeof window !== 'undefined') {
  window.PileGenerator = PileGenerator;
}

export default PileGenerator;
