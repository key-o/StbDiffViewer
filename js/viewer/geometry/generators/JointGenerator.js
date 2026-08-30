/**
 * @fileoverview 継手形状生成モジュール
 *
 * BaseElementGeneratorを継承した統一アーキテクチャ:
 * - 鋼構造の梁・柱接合部の継手プレートを3D表示
 * - H形鋼、角形鋼管、T形鋼の継手に対応
 * - フランジプレート、ウェブプレート、ボルトを表現
 *
 * 作成: 2025-12
 */

import * as THREE from 'three';
import { colorManager } from '../../rendering/colorManager.js';
import { BaseElementGenerator } from '../core/BaseElementGenerator.js';
import { getSectionHeight } from '../core/ElementSectionResolver.js';
import { getHorizontalElementOffsets } from '../core/ElementPlacementResolver.js';

/**
 * 継手形状生成クラス
 * 鋼構造の梁・柱継手を3D表示
 */
export class JointGenerator extends BaseElementGenerator {
  /**
   * ジェネレーター設定
   */
  static getConfig() {
    return {
      elementName: 'Joint',
      loggerName: 'viewer:geometry:joint',
      defaultElementType: 'Joint',
    };
  }

  /**
   * 継手要素からメッシュを作成
   * 梁・柱の端部に配置された継手を描画
   * @param {Array} jointedElements - 継手情報を持つ梁・柱要素配列
   * @param {Map<string, THREE.Vector3>} nodes - ノードマップ
   * @param {Map<string, Object>} jointDefinitions - 継手定義マップ（extractJointElementsの戻り値）
   * @param {Map<string, Object>} steelSections - 鋼材形状マップ
   * @param {string} elementType - 要素タイプ（デフォルト: "Joint"）
   * @param {boolean} isJsonInput - JSON入力かどうか
   * @param {Object} additionalData - 追加データ（断面情報など）
   * @returns {Array<THREE.Mesh>} 生成されたメッシュ配列
   */
  static createJointMeshes(
    jointedElements,
    nodes,
    jointDefinitions,
    steelSections,
    elementType = 'Joint',
    isJsonInput = false,
    additionalData = null,
  ) {
    const config = this.getConfig();
    const log = this._getLogger();

    if (!jointedElements || jointedElements.length === 0) {
      log.warn(`No ${config.elementName} elements provided.`);
      return [];
    }

    if (!jointDefinitions || jointDefinitions.size === 0) {
      log.warn(`No joint definitions provided.`);
      return [];
    }

    const meshes = [];
    let processed = 0;
    let skipped = 0;

    // 断面情報を取得
    const girderSections = additionalData?.girderSections || new Map();
    const beamSections = additionalData?.beamSections || new Map();

    for (const element of jointedElements) {
      const context = {
        nodes,
        jointDefinitions,
        steelSections,
        elementType,
        isJsonInput,
        log,
        girderSections,
        beamSections,
      };

      try {
        // 始端継手
        if (element.joint_id_start) {
          const startMeshes = this._createJointAtPosition(element, 'start', context);
          if (startMeshes && startMeshes.length > 0) {
            meshes.push(...startMeshes);
            processed++;
          }
        }

        // 終端継手
        if (element.joint_id_end) {
          const endMeshes = this._createJointAtPosition(element, 'end', context);
          if (endMeshes && endMeshes.length > 0) {
            meshes.push(...endMeshes);
            processed++;
          }
        }
      } catch (error) {
        log.warn(`Error creating ${config.elementName} for element ${element.id}:`, error.message);
        skipped++;
      }
    }

    log.info(`${config.elementName}: Created ${processed} joints, Skipped ${skipped}`);
    return meshes;
  }

  /**
   * 指定位置の継手メッシュを作成
   * @param {Object} element - 梁・柱要素
   * @param {string} position - 位置（'start' または 'end'）
   * @param {Object} context - コンテキスト
   * @returns {Array<THREE.Mesh>|null} メッシュ配列またはnull
   */
  static _createJointAtPosition(element, position, context) {
    const { nodes, jointDefinitions, elementType, isJsonInput, log, girderSections, beamSections } =
      context;

    // 継手ID取得
    const jointId = position === 'start' ? element.joint_id_start : element.joint_id_end;
    if (!jointId) return null;

    // 継手定義取得
    const jointDef = jointDefinitions.get(jointId.toString());
    if (!jointDef) {
      log.warn(`Joint definition not found: ${jointId}`);
      return null;
    }
    // ノード座標取得
    const startNodeId = element.id_node_start;
    const endNodeId = element.id_node_end;
    const startNode = nodes.get(startNodeId);
    const endNode = nodes.get(endNodeId);

    if (!startNode || !endNode) {
      log.warn(`Nodes not found for element ${element.id}`);
      return null;
    }
    // 断面高さを取得（梁の天端基準配置のオフセットに使用）
    let beamHeight = 300; // デフォルト値（RC高さ = 配置基準）
    let steelHeight = 300; // 鉄骨高さ（継手プレート配置基準）
    const sectionId = element.id_section;
    if (sectionId) {
      // 要素タイプに応じて断面マップを選択
      const sections = element.elementType === 'Girder' ? girderSections : beamSections;
      const sectionData = sections?.get(sectionId) || sections?.get(parseInt(sectionId, 10));
      if (sectionData) {
        // SRC造の場合: RC高さ(配置基準)と鉄骨高さ(プレート配置)を分離
        if (sectionData.isSRC && sectionData.concreteProfile?.height) {
          beamHeight = sectionData.concreteProfile.height;
          // 鉄骨高さは steelProfile から取得
          if (sectionData.steelProfile?.dimensions) {
            const steelSectionType = sectionData.steelProfile.section_type || 'H';
            const sh = getSectionHeight(
              { dimensions: sectionData.steelProfile.dimensions },
              steelSectionType,
            );
            if (sh > 0) steelHeight = sh;
          }
        } else {
          const height = getSectionHeight(sectionData, sectionData.shape || 'H');
          if (height > 0) {
            beamHeight = height;
            steelHeight = height;
          }
        }
      }
    }

    // 継手位置を計算（梁のオフセットを適用）
    const offsets = getHorizontalElementOffsets(element);
    const startPos = new THREE.Vector3(
      startNode.x + offsets.startOffset.x,
      startNode.y + offsets.startOffset.y,
      startNode.z + offsets.startOffset.z,
    );
    const endPos = new THREE.Vector3(
      endNode.x + offsets.endOffset.x,
      endNode.y + offsets.endOffset.y,
      endNode.z + offsets.endOffset.z,
    );
    const direction = new THREE.Vector3().subVectors(endPos, startPos).normalize();
    const elementLength = startPos.distanceTo(endPos);

    // 継手位置のオフセット距離
    const jointOffset =
      position === 'start' ? element.joint_start || 0 : elementLength - (element.joint_end || 0);

    // 継手中心位置（天端基準のため、断面せいの半分だけ下にオフセット）
    const jointCenter = new THREE.Vector3().copy(startPos).addScaledVector(direction, jointOffset);
    jointCenter.z -= beamHeight / 2;

    const meshes = [];

    // contextにbeamHeight（配置基準）とsteelHeight（プレート配置基準）を追加
    const jointContext = { ...context, beamHeight, steelHeight };

    // 継手タイプに応じた形状を生成
    switch (jointDef.joint_type) {
      case 'BeamShapeH':
      case 'ColumnShapeH':
        meshes.push(
          ...this._createHShapeJoint(jointDef, jointCenter, direction, element, jointContext),
        );
        break;
      case 'BeamShapeBox':
      case 'ColumnShapeBox':
        meshes.push(
          ...this._createBoxShapeJoint(jointDef, jointCenter, direction, element, jointContext),
        );
        break;
      case 'BeamShapeT':
      case 'ColumnShapeT':
        meshes.push(
          ...this._createTShapeJoint(jointDef, jointCenter, direction, element, jointContext),
        );
        break;
      default:
        log.warn(`Unknown joint type: ${jointDef.joint_type}`);
        return null;
    }

    // メタデータ設定
    meshes.forEach((mesh) => {
      mesh.userData = {
        id: `joint_${element.id}_${position}`,
        elementId: element.id,
        name: jointDef.joint_name || `Joint_${jointId}`,
        elementType: elementType,
        jointId: jointId,
        jointPosition: position,
        jointData: {
          joint_type: jointDef.joint_type,
          joint_mark: jointDef.joint_mark,
          parent_element_id: element.id,
          parent_element_type: element.elementType || 'Girder',
          position: position,
          center: { x: jointCenter.x, y: jointCenter.y, z: jointCenter.z },
        },
        isSTB: !isJsonInput,
      };
    });

    return meshes;
  }

  /**
   * H形鋼継手の形状を作成
   * フランジプレート（上下）とウェブプレートを生成
   * @param {Object} jointDef - 継手定義
   * @param {THREE.Vector3} center - 継手中心位置
   * @param {THREE.Vector3} direction - 部材方向ベクトル
   * @param {Object} element - 親要素
   * @param {Object} context - コンテキスト
   * @returns {Array<THREE.Mesh>} メッシュ配列
   */
  static _createHShapeJoint(jointDef, center, direction, element, context) {
    const { log, steelHeight: contextSteelHeight } = context;
    const meshes = [];

    // フランジプレート
    if (jointDef.flange) {
      const flange = jointDef.flange;
      const plateThickness = flange.outside_thickness || 12;
      const plateWidth = flange.outside_width || 100;
      const plateLength = flange.outside_length || 200;

      // 上フランジプレート
      const topFlangeGeometry = new THREE.BoxGeometry(plateLength, plateWidth, plateThickness);

      // 鉄骨高さを使用（SRC造の場合、RC高さではなく鉄骨高さでフランジ位置を決定）
      const steelH = contextSteelHeight || 300; // mm
      const flangeOffset = steelH / 2 + plateThickness / 2;

      // 上フランジ
      const topFlangeMesh = new THREE.Mesh(
        topFlangeGeometry,
        colorManager.getMaterial('diff', { comparisonState: 'matched' }),
      );
      topFlangeMesh.position.copy(center);
      topFlangeMesh.position.z += flangeOffset;
      this._applyDirection(topFlangeMesh, direction);
      meshes.push(topFlangeMesh);

      // 下フランジ
      const bottomFlangeMesh = new THREE.Mesh(
        topFlangeGeometry.clone(),
        colorManager.getMaterial('diff', { comparisonState: 'matched' }),
      );
      bottomFlangeMesh.position.copy(center);
      bottomFlangeMesh.position.z -= flangeOffset;
      this._applyDirection(bottomFlangeMesh, direction);
      meshes.push(bottomFlangeMesh);

      log.debug(`Created H-shape flange plates: ${plateLength}x${plateWidth}x${plateThickness}`);
    }

    // ウェブプレート
    if (jointDef.web) {
      const web = jointDef.web;
      const plateThickness = web.plate_thickness || 6;
      const plateWidth = web.plate_width || 100;
      const plateLength = web.plate_length || 150;

      const webGeometry = new THREE.BoxGeometry(plateLength, plateThickness, plateWidth);

      // 両側にウェブプレート
      const webOffset = 50; // H形鋼のウェブ厚さ + プレート厚さの半分

      const leftWebMesh = new THREE.Mesh(
        webGeometry,
        colorManager.getMaterial('diff', { comparisonState: 'matched' }),
      );
      leftWebMesh.position.copy(center);
      leftWebMesh.position.y += webOffset;
      this._applyDirection(leftWebMesh, direction);
      meshes.push(leftWebMesh);

      const rightWebMesh = new THREE.Mesh(
        webGeometry.clone(),
        colorManager.getMaterial('diff', { comparisonState: 'matched' }),
      );
      rightWebMesh.position.copy(center);
      rightWebMesh.position.y -= webOffset;
      this._applyDirection(rightWebMesh, direction);
      meshes.push(rightWebMesh);

      log.debug(`Created H-shape web plates: ${plateLength}x${plateWidth}x${plateThickness}`);
    }

    return meshes;
  }

  /**
   * 角形鋼管継手の形状を作成
   * @param {Object} jointDef - 継手定義
   * @param {THREE.Vector3} center - 継手中心位置
   * @param {THREE.Vector3} direction - 部材方向ベクトル
   * @param {Object} element - 親要素
   * @param {Object} context - コンテキスト
   * @returns {Array<THREE.Mesh>} メッシュ配列
   */
  static _createBoxShapeJoint(jointDef, center, direction, element, context) {
    const { log } = context;
    const meshes = [];

    // フランジプレート（4面）
    if (jointDef.flange) {
      const flange = jointDef.flange;
      const plateThickness = flange.outside_thickness || 12;
      const plateWidth = flange.outside_width || 100;
      const plateLength = flange.outside_length || 200;

      const boxSize = 300; // 角形鋼管の概算サイズ
      const offset = boxSize / 2 + plateThickness / 2;

      // 4面のフランジプレート
      const directions = [
        new THREE.Vector3(0, 0, offset),
        new THREE.Vector3(0, 0, -offset),
        new THREE.Vector3(0, offset, 0),
        new THREE.Vector3(0, -offset, 0),
      ];

      for (const dir of directions) {
        const isVertical = Math.abs(dir.z) > 0.5;
        const geometry = new THREE.BoxGeometry(
          plateLength,
          isVertical ? plateWidth : plateThickness,
          isVertical ? plateThickness : plateWidth,
        );

        const mesh = new THREE.Mesh(
          geometry,
          colorManager.getMaterial('diff', { comparisonState: 'matched' }),
        );
        mesh.position.copy(center).add(dir);
        this._applyDirection(mesh, direction);
        meshes.push(mesh);
      }

      log.debug(`Created Box-shape flange plates: ${plateLength}x${plateWidth}x${plateThickness}`);
    }

    return meshes;
  }

  /**
   * T形鋼継手の形状を作成
   * @param {Object} jointDef - 継手定義
   * @param {THREE.Vector3} center - 継手中心位置
   * @param {THREE.Vector3} direction - 部材方向ベクトル
   * @param {Object} element - 親要素
   * @param {Object} context - コンテキスト
   * @returns {Array<THREE.Mesh>} メッシュ配列
   */
  static _createTShapeJoint(jointDef, center, direction, element, context) {
    const { log, steelHeight: contextSteelHeight } = context;
    // T形継手はH形と同様だが上フランジのみ
    const meshes = [];

    if (jointDef.flange) {
      const flange = jointDef.flange;
      const plateThickness = flange.outside_thickness || 12;
      const plateWidth = flange.outside_width || 100;
      const plateLength = flange.outside_length || 200;

      const flangeGeometry = new THREE.BoxGeometry(plateLength, plateWidth, plateThickness);

      const steelH = contextSteelHeight || 200;
      const flangeOffset = steelH / 2 + plateThickness / 2;

      const flangeMesh = new THREE.Mesh(
        flangeGeometry,
        colorManager.getMaterial('diff', { comparisonState: 'matched' }),
      );
      flangeMesh.position.copy(center);
      flangeMesh.position.z += flangeOffset;
      this._applyDirection(flangeMesh, direction);
      meshes.push(flangeMesh);

      log.debug(`Created T-shape flange plate: ${plateLength}x${plateWidth}x${plateThickness}`);
    }

    // ウェブプレート
    if (jointDef.web) {
      const web = jointDef.web;
      const plateThickness = web.plate_thickness || 6;
      const plateWidth = web.plate_width || 100;
      const plateLength = web.plate_length || 150;

      const webGeometry = new THREE.BoxGeometry(plateLength, plateThickness, plateWidth);

      const webMesh = new THREE.Mesh(
        webGeometry,
        colorManager.getMaterial('diff', { comparisonState: 'matched' }),
      );
      webMesh.position.copy(center);
      this._applyDirection(webMesh, direction);
      meshes.push(webMesh);

      log.debug(`Created T-shape web plate: ${plateLength}x${plateWidth}x${plateThickness}`);
    }

    return meshes;
  }

  /**
   * メッシュを部材方向に合わせて回転
   * @param {THREE.Mesh} mesh - メッシュ
   * @param {THREE.Vector3} direction - 方向ベクトル
   */
  static _applyDirection(mesh, direction) {
    // XY平面上の回転角度
    const angle = Math.atan2(direction.y, direction.x);
    mesh.rotation.z = angle;
  }
}

export default JointGenerator;
