/**
 * @fileoverview プロファイル作成ユーティリティ（公開エントリ）
 *
 * Column, Post, FoundationColumn ジェネレーター間で共有される
 * プロファイル作成・断面解決ロジックを集約。
 *
 * 責務ごとに以下へ分割し、本ファイルは縦方向部材メッシュ生成と
 * 公開APIの再エクスポートを担当します:
 * - 形状判定 / 寸法解決 → ./ProfileSectionResolvers.js
 * - プロファイル生成     → ./SectionProfileFactory.js
 * - 複合部材メッシュ生成 → ./CompositeMemberMeshBuilders.js
 *
 * 抽出元:
 * - ProfileBasedColumnGenerator._tryIFCProfile, _createProfileUsingCalculator, etc.
 * - ProfileBasedPostGenerator._tryIFCProfile, _createProfileUsingCalculator, etc.
 * - ProfileBasedFoundationColumnGenerator._tryIFCProfile, _createProfileUsingCalculator, etc.
 *
 * @module viewer/geometry/core/ProfileCreationUtils
 */

import * as THREE from 'three';
import { createExtrudeGeometry, applyPlacementToMesh } from './ThreeJSConverter.js';
import { calculateColumnPlacement } from './GeometryCalculator.js';
import { colorManager } from '../../rendering/colorManager.js';
import { getNodePositions } from './ElementNodeResolver.js';
import { getSectionData } from './ElementSectionResolver.js';
import {
  isCrossHSection,
  isShapeTSection,
  resolveCrossHDimensions,
} from './ProfileSectionResolvers.js';
import { createSectionProfile } from './SectionProfileFactory.js';
import {
  createBasePlateMesh,
  createSRCConcreteGeometry,
  createCrossHSteelMeshes,
  createShapeTSteelMeshes,
} from './CompositeMemberMeshBuilders.js';

export {
  toFiniteNumber,
  isCrossHSection,
  isShapeTSection,
  resolveCrossHDimensions,
  resolveHDimensions,
} from './ProfileSectionResolvers.js';
export {
  tryIFCProfile,
  createProfileUsingCalculator,
  createSectionProfile,
} from './SectionProfileFactory.js';
export {
  createBasePlateMesh,
  createSRCConcreteGeometry,
  createCrossHSteelMeshes,
  createShapeTSteelMeshes,
} from './CompositeMemberMeshBuilders.js';

/**
 * 縦方向部材（柱・間柱）の共通メッシュ生成
 *
 * Column と Post の _createSingleMesh で重複していたロジックを統合。
 * 差異はオプションで吸収する:
 *   - options.supportMultiSection: true なら double/multi 断面モードをサポート
 *   - options.srcColors: SRC_COMPONENT_COLORS.Column 等の色設定（省略可）
 *   - options.createMultiSectionGeometry: multi-section用のジオメトリ生成関数
 *
 * @param {Object} element - 要素データ
 * @param {Object} context - コンテキスト（nodes, sections, steelSections, elementType, isJsonInput, log）
 * @param {Object} generator - ジェネレータークラス（BaseElementGenerator サブクラス）
 * @param {Object} [options={}] - オプション
 * @param {boolean} [options.supportMultiSection=false] - 多断面サポート
 * @param {Object|null} [options.srcColors=null] - SRC色設定 { steel, concrete }
 * @param {Function|null} [options.createMultiSectionGeometry=null] - 多断面ジオメトリ生成関数
 * @returns {THREE.Mesh|Array<THREE.Mesh>|null}
 */
export function createVerticalMemberMesh(element, context, generator, options = {}) {
  const { nodes, sections, steelSections, elementType, isJsonInput, log } = context;
  const {
    supportMultiSection = false,
    srcColors = null,
    createMultiSectionGeometry: multiSectionFn = null,
  } = options;

  const elementName = generator.getConfig().elementName;

  // 1. ノード位置の取得
  const nodePositions = getNodePositions(element, nodes, {
    nodeType: '2node-vertical',
    isJsonInput: isJsonInput,
    node1KeyStart: 'id_node_bottom',
    node1KeyEnd: 'id_node_top',
  });

  if (!generator._validateNodePositions(nodePositions, element, context)) {
    return null;
  }

  // 2. 断面データの取得
  const sectionData = getSectionData(element, sections, isJsonInput);

  if (!generator._validateSectionData(sectionData, element, context)) {
    return null;
  }

  // 3. 断面タイプの推定（SRC造対応）
  let sectionType = generator._resolveGeometryProfileType(sectionData);
  let steelSectionData = sectionData;
  let isCrossH = isCrossHSection(sectionData);
  let isShapeT = isShapeTSection(sectionData);

  if (sectionData.isSRC && sectionData.steelProfile?.section_type) {
    sectionType = generator._resolveGeometryProfileType(sectionData.steelProfile, {
      defaultType: sectionType,
    });
    steelSectionData = {
      section_type: sectionData.steelProfile.section_type,
      dimensions: sectionData.steelProfile.dimensions,
    };
    isCrossH =
      isCrossH || isCrossHSection(sectionData.steelProfile) || isCrossHSection(steelSectionData);
    isShapeT =
      isShapeT || isShapeTSection(sectionData.steelProfile) || isShapeTSection(steelSectionData);
    log.debug(
      `${elementName} ${element.id}: SRC造 S部分プロファイル: ${sectionType} (RC型から復元)`,
    );

    // CROSS_H断面の場合、shape名から実際のH鋼寸法を解決
    if (isCrossH) {
      const crossDims = resolveCrossHDimensions(steelSectionData.dimensions, steelSections);
      if (crossDims) {
        steelSectionData = { ...steelSectionData, dimensions: crossDims };
        log.debug(
          `${elementName} ${element.id}: CROSS_H寸法を解決 ` +
            `(X: ${crossDims.overallDepthX}x${crossDims.overallWidthX}, ` +
            `Y: ${crossDims.overallDepthY}x${crossDims.overallWidthY})`,
        );
      }
    }
  }

  log.debug(`Creating ${elementName.toLowerCase()} ${element.id}: section_type=${sectionType}`);

  // 4. プロファイル生成
  const profileResult = createSectionProfile(steelSectionData, sectionType, element.id, log);

  if (!generator._validateProfile(profileResult, element, context)) {
    return null;
  }

  // 5. 配置計算
  const bottomNodePlain = {
    x: nodePositions.bottomNode.x,
    y: nodePositions.bottomNode.y,
    z: nodePositions.bottomNode.z,
  };
  const topNodePlain = {
    x: nodePositions.topNode.x,
    y: nodePositions.topNode.y,
    z: nodePositions.topNode.z,
  };

  const bottomOffset = {
    x: Number(element.offset_bottom_X || 0),
    y: Number(element.offset_bottom_Y || 0),
    z: Number(element.offset_bottom_Z || 0),
  };
  const topOffset = {
    x: Number(element.offset_top_X || 0),
    y: Number(element.offset_top_Y || 0),
    z: Number(element.offset_top_Z || 0),
  };

  // 回転角度の取得（度単位）
  let rollAngleDegrees = 0;
  if (element.geometry && element.geometry.rotation !== undefined) {
    rollAngleDegrees = element.geometry.rotation;
  } else if (element.rotate !== undefined) {
    rollAngleDegrees = element.rotate;
  } else if (element.angle !== undefined) {
    rollAngleDegrees = element.angle;
  }

  rollAngleDegrees = generator._calculateRotation(sectionData, rollAngleDegrees);
  const rollAngle = (rollAngleDegrees * Math.PI) / 180;

  const placement = calculateColumnPlacement(bottomNodePlain, topNodePlain, {
    bottomOffset,
    topOffset,
    rollAngle,
  });

  if (!generator._validatePlacement(placement, element, context)) {
    return null;
  }

  log.debug(
    `${elementName} ${element.id}: length=${placement.length.toFixed(1)}mm` +
      (supportMultiSection ? `, mode=${sectionData.mode || 'single'}` : ''),
  );

  // T形複合断面（shape_H + shape_T）はH形鋼1本＋T形鋼1本として生成
  if (isShapeT) {
    const shapeTMeshes = createShapeTSteelMeshes({
      element,
      placement,
      shapeTDimensions: steelSectionData?.dimensions || {},
      steelSections,
      elementType,
      isJsonInput,
      log,
      buildMetadata: (args) => generator._buildColumnMetadata(args),
      steelColor: srcColors?.steel || null,
    });

    if (shapeTMeshes && shapeTMeshes.length > 0) {
      const extras = [];
      if (sectionData.isSRC && sectionData.concreteProfile) {
        const rcMesh = createSRCConcreteGeometry({
          sectionData,
          element,
          placement,
          elementType,
          isJsonInput,
          log,
          buildMetadata: (args) => generator._buildColumnMetadata(args),
          concreteColor: srcColors?.concrete || null,
        });
        if (rcMesh) {
          log.debug(`${elementName} ${element.id}: SRC造 T形複合 - RC部分のメッシュを追加生成`);
          extras.push(rcMesh);
        }
      }
      if (sectionData.basePlate) {
        const basePlateMesh = createBasePlateMesh(
          sectionData.basePlate,
          nodePositions.bottomNode,
          element,
          elementType,
          isJsonInput,
          rollAngle,
          log,
        );
        if (basePlateMesh) extras.push(basePlateMesh);
      }
      return [...shapeTMeshes, ...extras];
    }

    log.warn(
      `${elementName} ${element.id}: T形複合断面の生成に失敗したため単一断面にフォールバック`,
    );
  }

  // CROSS_H判定時は十字断面ではなく、90度回転したH鋼2本として生成
  if (isCrossH) {
    const crossHMeshes = createCrossHSteelMeshes({
      element,
      placement,
      crossDimensions: steelSectionData?.dimensions || {},
      steelSections,
      elementType,
      isJsonInput,
      log,
      buildMetadata: (args) => generator._buildColumnMetadata(args),
      steelColor: srcColors?.steel || null,
    });

    if (crossHMeshes && crossHMeshes.length > 0) {
      if (sectionData.isSRC && sectionData.concreteProfile) {
        const rcMesh = createSRCConcreteGeometry({
          sectionData,
          element,
          placement,
          elementType,
          isJsonInput,
          log,
          buildMetadata: (args) => generator._buildColumnMetadata(args),
          concreteColor: srcColors?.concrete || null,
        });
        if (rcMesh) {
          log.debug(`${elementName} ${element.id}: SRC造 - RC部分のメッシュを追加生成`);
          return [...crossHMeshes, rcMesh];
        }
      }

      if (sectionData.basePlate) {
        const basePlateMesh = createBasePlateMesh(
          sectionData.basePlate,
          nodePositions.bottomNode,
          element,
          elementType,
          isJsonInput,
          rollAngle,
          log,
        );
        if (basePlateMesh) {
          log.debug(
            `${elementName} ${element.id}: ベースプレートメッシュを追加生成 (${sectionData.basePlate.baseType})`,
          );
          return [...crossHMeshes, basePlateMesh];
        }
      }

      return crossHMeshes;
    }

    log.warn(
      `${elementName} ${element.id}: CROSS_Hの2本H鋼生成に失敗したため単一断面にフォールバック`,
    );
  }

  // 6. ジオメトリ作成
  let geometry = null;
  const mode = sectionData.mode || 'single';

  if (mode === 'single' || !supportMultiSection) {
    geometry = createExtrudeGeometry(profileResult.shape, placement.length);
  } else if (supportMultiSection && multiSectionFn && (mode === 'double' || mode === 'multi')) {
    geometry = multiSectionFn(sectionData, element, steelSections, placement.length);
  }

  if (!generator._validateGeometry(geometry, element, context)) {
    return null;
  }

  // 7. メッシュを作成
  const materialOptions = { comparisonState: 'matched' };
  if (sectionData.isSRC && srcColors?.steel) {
    materialOptions.overrideColor = srcColors.steel;
  }

  const mesh = new THREE.Mesh(geometry, colorManager.getMaterial('diff', materialOptions));

  // 8. 配置を適用
  applyPlacementToMesh(mesh, placement);

  // 9. メタデータを設定
  mesh.userData = generator._buildColumnMetadata({
    element,
    elementType,
    placement,
    sectionType,
    profileResult,
    sectionData,
    isJsonInput,
  });
  if (sectionData.isSRC) {
    mesh.userData.srcComponentType = 'S';
  }

  // 10. SRC造の場合、RC部分のメッシュも生成して配列で返す
  if (sectionData.isSRC && sectionData.concreteProfile) {
    const rcMesh = createSRCConcreteGeometry({
      sectionData,
      element,
      placement,
      elementType,
      isJsonInput,
      log,
      buildMetadata: (args) => generator._buildColumnMetadata(args),
      concreteColor: srcColors?.concrete || null,
    });
    if (rcMesh) {
      log.debug(`${elementName} ${element.id}: SRC造 - RC部分のメッシュを追加生成`);
      return [mesh, rcMesh];
    }
  }

  // 11. ベースプレートメッシュの生成
  if (sectionData.basePlate) {
    const basePlateMesh = createBasePlateMesh(
      sectionData.basePlate,
      nodePositions.bottomNode,
      element,
      elementType,
      isJsonInput,
      rollAngle,
      log,
    );
    if (basePlateMesh) {
      log.debug(
        `${elementName} ${element.id}: ベースプレートメッシュを追加生成 (${sectionData.basePlate.baseType})`,
      );
      return [mesh, basePlateMesh];
    }
  }

  return mesh;
}
