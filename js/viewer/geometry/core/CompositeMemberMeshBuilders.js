/**
 * @fileoverview 複合部材メッシュビルダー
 *
 * ベースプレート / SRC造RC部分 / CROSS_H（十字H）/ SHAPE_T（T形複合）の
 * メッシュ生成ロジックを集約します（ProfileCreationUtils から分割）。
 *
 * @module viewer/geometry/core/CompositeMemberMeshBuilders
 */

import * as THREE from 'three';
import { createExtrudeGeometry, applyPlacementToMesh } from './ThreeJSConverter.js';
import { colorManager } from '../../rendering/colorManager.js';
import { createSectionProfile } from './SectionProfileFactory.js';
import {
  toFiniteNumber,
  resolveHDimensions,
  resolveSteelDimsByName,
} from './ProfileSectionResolvers.js';

/**
 * ベースプレート（柱脚プレート）のメッシュを生成
 * @param {Object} basePlate - ベースプレートデータ {baseType, B_X, B_Y, t, offset_X, offset_Y}
 * @param {Object} bottomNode - 下端ノード座標 {x, y, z}
 * @param {Object} element - 要素データ
 * @param {string} elementType - 要素タイプ
 * @param {boolean} isJsonInput - JSON入力かどうか
 * @param {number} rollAngle - 回転角度（ラジアン）
 * @param {Object} log - ロガー
 * @returns {THREE.Mesh|null}
 */
export function createBasePlateMesh(
  basePlate,
  bottomNode,
  element,
  elementType,
  isJsonInput,
  rollAngle,
  log,
) {
  const { B_X, B_Y, t, offset_X = 0, offset_Y = 0 } = basePlate;

  if (!B_X || !B_Y || !t) {
    log.warn(`${element.id}: ベースプレートの寸法が不足 (B_X=${B_X}, B_Y=${B_Y}, t=${t})`);
    return null;
  }

  const geometry = new THREE.BoxGeometry(B_X, B_Y, t);
  const mesh = new THREE.Mesh(
    geometry,
    colorManager.getMaterial('diff', { comparisonState: 'matched' }),
  );

  mesh.position.set(bottomNode.x + offset_X, bottomNode.y + offset_Y, bottomNode.z - t / 2);

  if (rollAngle !== 0) {
    mesh.rotation.z = rollAngle;
  }

  mesh.userData = {
    elementType: elementType,
    elementId: element.id,
    isJsonInput: isJsonInput,
    isBasePlate: true,
    basePlateData: { baseType: basePlate.baseType, B_X, B_Y, t },
    sectionType: 'RECTANGLE',
    profileBased: false,
    profileMeta: { profileSource: 'BoxGeometry', profileType: 'BASE_PLATE' },
  };

  return mesh;
}

/**
 * SRC造のRC（コンクリート）部分のジオメトリを生成
 * @param {Object} params - パラメータ
 * @param {Object} params.sectionData - 断面データ
 * @param {Object} params.element - 要素データ
 * @param {Object} params.placement - 配置情報
 * @param {string} params.elementType - 要素タイプ
 * @param {boolean} params.isJsonInput - JSON入力かどうか
 * @param {Object} params.log - ロガー
 * @param {Function} params.buildMetadata - メタデータ構築関数
 * @param {number|null} [params.concreteColor] - コンクリート部分のカラー
 * @returns {THREE.Mesh|null}
 */
export function createSRCConcreteGeometry(params) {
  const {
    sectionData,
    element,
    placement,
    elementType,
    isJsonInput,
    log,
    buildMetadata,
    concreteColor = null,
  } = params;

  const concreteProfile = sectionData.concreteProfile;
  if (!concreteProfile) {
    return null;
  }

  let width, height;
  if (concreteProfile.profileType === 'CIRCLE') {
    const diameter = concreteProfile.diameter;
    if (!diameter) {
      log.warn(`${element.id}: SRC円形断面の直径が不明です`);
      return null;
    }
    width = diameter;
    height = diameter;
  } else {
    width = concreteProfile.width_X || concreteProfile.width;
    height = concreteProfile.width_Y || concreteProfile.height;
    if (!width || !height) {
      log.warn(`${element.id}: SRC矩形断面の寸法が不明です (width=${width}, height=${height})`);
      return null;
    }
  }

  log.debug(`${element.id}: SRC RC部分 - ${concreteProfile.profileType} ${width}x${height}`);

  const rcDimensions = {
    width: width,
    height: height,
    outer_width: width,
    outer_height: height,
  };

  // 円形の場合はdiameterを明示的に設定
  if (concreteProfile.profileType === 'CIRCLE') {
    rcDimensions.diameter = concreteProfile.diameter;
  }

  const rcSectionData = {
    section_type: concreteProfile.profileType,
    dimensions: rcDimensions,
  };

  const rcProfileResult = createSectionProfile(
    rcSectionData,
    concreteProfile.profileType,
    element.id,
    log,
  );

  if (!rcProfileResult || !rcProfileResult.shape) {
    log.warn(`${element.id}: SRC RC部分のプロファイル生成に失敗`);
    return null;
  }

  const rcGeometry = createExtrudeGeometry(rcProfileResult.shape, placement.length);
  if (!rcGeometry) {
    log.warn(`${element.id}: SRC RC部分のジオメトリ生成に失敗`);
    return null;
  }

  const materialOptions = { comparisonState: 'matched', isTransparent: true };
  if (concreteColor) {
    materialOptions.overrideColor = concreteColor;
  }

  const rcMesh = new THREE.Mesh(rcGeometry, colorManager.getMaterial('diff', materialOptions));

  applyPlacementToMesh(rcMesh, placement);

  rcMesh.userData = buildMetadata({
    element: element,
    elementType: elementType,
    placement: placement,
    sectionType: concreteProfile.profileType,
    profileResult: rcProfileResult,
    sectionData: rcSectionData,
    isJsonInput: isJsonInput,
  });
  rcMesh.userData.isSRCConcrete = true;
  rcMesh.userData.srcComponentType = 'RC';

  return rcMesh;
}

/**
 * CROSS_H断面をH鋼2本（0度/90度）として生成
 * @param {Object} params - パラメータ
 * @param {Object} params.element - 要素データ
 * @param {Object} params.placement - 配置情報
 * @param {Object} params.crossDimensions - CROSS_H寸法/shape情報
 * @param {Map} params.steelSections - 鋼材形状マップ
 * @param {string} params.elementType - 要素タイプ
 * @param {boolean} params.isJsonInput - JSON入力かどうか
 * @param {Object} params.log - ロガー
 * @param {Function} params.buildMetadata - メタデータ構築関数
 * @param {number|null} [params.steelColor] - 鋼材部分のカラー
 * @returns {Array<THREE.Mesh>|null}
 */
export function createCrossHSteelMeshes(params) {
  const {
    element,
    placement,
    crossDimensions,
    steelSections,
    elementType,
    isJsonInput,
    log,
    buildMetadata,
    steelColor = null,
  } = params;

  if (!crossDimensions) return null;

  const shapeX = crossDimensions.crossH_shapeX || null;
  const shapeY = crossDimensions.crossH_shapeY || shapeX;
  if (!shapeX) return null;

  const fallbackX = {
    H: crossDimensions.overallDepthX || crossDimensions['H_x'] || crossDimensions.H,
    B: crossDimensions.overallWidthX || crossDimensions['B_x'] || crossDimensions.B,
  };
  const fallbackY = {
    H: crossDimensions.overallDepthY || crossDimensions['H_y'] || fallbackX.H,
    B: crossDimensions.overallWidthY || crossDimensions['B_y'] || fallbackX.B,
  };

  const dimsX = resolveHDimensions(shapeX, steelSections, fallbackX);
  const dimsY = resolveHDimensions(shapeY, steelSections, { ...dimsX, ...fallbackY });

  const armDefs = [
    { arm: 'X', shapeName: shapeX, dimensions: dimsX, angle: 0 },
    { arm: 'Y', shapeName: shapeY, dimensions: dimsY, angle: Math.PI / 2 },
  ];

  const meshes = [];
  for (const armDef of armDefs) {
    const armSectionData = {
      section_type: 'H',
      dimensions: armDef.dimensions,
    };
    const armProfile = createSectionProfile(armSectionData, 'H', element.id, log);
    if (!armProfile || !armProfile.shape) {
      log.warn(`${element.id}: CROSS_H ${armDef.arm}アームのH断面生成に失敗`);
      continue;
    }

    const armGeometry = createExtrudeGeometry(armProfile.shape, placement.length);
    if (!armGeometry) {
      log.warn(`${element.id}: CROSS_H ${armDef.arm}アームのジオメトリ生成に失敗`);
      continue;
    }

    if (armDef.angle !== 0) {
      armGeometry.rotateZ(armDef.angle);
    }

    const materialOptions = { comparisonState: 'matched' };
    if (steelColor) {
      materialOptions.overrideColor = steelColor;
    }

    const armMesh = new THREE.Mesh(armGeometry, colorManager.getMaterial('diff', materialOptions));
    applyPlacementToMesh(armMesh, placement);

    armMesh.userData = buildMetadata({
      element: element,
      elementType: elementType,
      placement: placement,
      sectionType: 'H',
      profileResult: armProfile,
      sectionData: armSectionData,
      isJsonInput: isJsonInput,
    });
    armMesh.userData.srcComponentType = 'S';
    armMesh.userData.isCrossHSteel = true;
    armMesh.userData.crossHArm = armDef.arm;
    armMesh.userData.crossHShape = armDef.shapeName;

    meshes.push(armMesh);
  }

  return meshes.length > 0 ? meshes : null;
}

/**
 * T形複合断面（shape_H + shape_T）をH形鋼1本＋T形鋼1本として生成
 *
 * STB仕様 StbSecColumn_SRC_*ShapeT（ver.2.0.2 図「T1/T2の例」）準拠。
 * - H形鋼: 図心基準で (offset_HX, offset_HY) に配置。T1/T3 はウェブ水平、T2/T4 はウェブ鉛直。
 * - T形鋼: H形鋼と「直交」する。ウェブの自由端を必ずH形鋼のウェブ線へ接合し、フランジは外側を向く
 *   （T1=下/T2=左/T3=上/T4=右）。offset_T は H形鋼ウェブ中心からT形鋼ウェブまでの距離
 *   （H形ウェブ方向に沿う）。
 *
 * @param {Object} params
 * @param {Object} params.element - 要素データ
 * @param {Object} params.placement - 配置情報
 * @param {Object} params.shapeTDimensions - shapeT_* を含む寸法データ
 * @param {Map} params.steelSections - 鋼材形状マップ
 * @param {string} params.elementType - 要素タイプ
 * @param {boolean} params.isJsonInput - JSON入力かどうか
 * @param {Object} params.log - ロガー
 * @param {Function} params.buildMetadata - メタデータ構築関数
 * @param {number|null} [params.steelColor] - 鋼材部分のカラー
 * @returns {Array<THREE.Mesh>|null}
 */
export function createShapeTSteelMeshes(params) {
  const {
    element,
    placement,
    shapeTDimensions,
    steelSections,
    elementType,
    isJsonInput,
    log,
    buildMetadata,
    steelColor = null,
  } = params;

  const dims = shapeTDimensions || {};
  const shapeH = dims.shapeT_shapeH;
  const shapeT = dims.shapeT_shapeT;
  if (!shapeH || !shapeT) return null;

  const direction = String(dims.shapeT_direction || 'T1').toUpperCase();
  const offsetHX = toFiniteNumber(dims.shapeT_offsetHX, 0);
  const offsetHY = toFiniteNumber(dims.shapeT_offsetHY, 0);
  const offsetT = toFiniteNumber(dims.shapeT_offsetT, 0);

  const meshes = [];
  const matOptions = () => {
    const o = { comparisonState: 'matched' };
    if (steelColor) o.overrideColor = steelColor;
    return o;
  };

  // 寸法解決（T形鋼のせい/2 = halfT を配置計算に使う）
  const hDims = resolveHDimensions(shapeH, steelSections);
  const tDims = resolveSteelDimsByName(shapeT, steelSections);
  const tDepth = toFiniteNumber(tDims.overall_depth ?? tDims.H ?? tDims.height ?? tDims.A, 350);
  const halfT = tDepth / 2;

  // direction_type ごとの向き・配置（STB仕様 ver.2.0.2 図「T1/T2の例」準拠）
  //   T形鋼はH形鋼と「直交」し、ウェブの自由端をH形鋼のウェブ線へ接合、フランジは外側を向く。
  //   offset_T = H形鋼ウェブ中心からT形鋼ウェブまでの距離（H形ウェブ方向に沿う）。
  //   hAngle : H形鋼のZ回り回転（T1/T3=ウェブ水平、T2/T4=ウェブ鉛直）
  //   tAngle : T形鋼のZ回り回転（基準プロファイルはフランジ下・ウェブ上）
  //   tCenter: T形鋼の幾何中心。ウェブ自由端（基準+Y側, 中心から halfT）をH形ウェブ線へ合わせる。
  const DIR = {
    // T1(⊤): H水平・T下（フランジ下, ステム上）, offset_TはX方向
    T1: { hAngle: Math.PI / 2, tAngle: 0, tCenter: { x: offsetHX + offsetT, y: offsetHY - halfT } },
    // T3(⊥): H水平・T上（フランジ上, ステム下）, offset_TはX方向
    T3: {
      hAngle: Math.PI / 2,
      tAngle: Math.PI,
      tCenter: { x: offsetHX + offsetT, y: offsetHY + halfT },
    },
    // T2(⊣): H鉛直・T左（フランジ左, ステム右）, offset_TはY方向
    T2: {
      hAngle: 0,
      tAngle: -Math.PI / 2,
      tCenter: { x: offsetHX - halfT, y: offsetHY + offsetT },
    },
    // T4(⊢): H鉛直・T右（フランジ右, ステム左）, offset_TはY方向
    T4: { hAngle: 0, tAngle: Math.PI / 2, tCenter: { x: offsetHX + halfT, y: offsetHY + offsetT } },
  };
  const cfg = DIR[direction] || DIR.T1;

  // --- H形鋼（図心を (offset_HX, offset_HY) に配置） ---
  const hSectionData = { section_type: 'H', dimensions: hDims };
  const hProfile = createSectionProfile(hSectionData, 'H', element.id, log);
  if (hProfile?.shape) {
    const hGeo = createExtrudeGeometry(hProfile.shape, placement.length);
    if (hGeo) {
      if (cfg.hAngle !== 0) hGeo.rotateZ(cfg.hAngle);
      hGeo.translate(offsetHX, offsetHY, 0);
      const hMesh = new THREE.Mesh(hGeo, colorManager.getMaterial('diff', matOptions()));
      applyPlacementToMesh(hMesh, placement);
      hMesh.userData = buildMetadata({
        element,
        elementType,
        placement,
        sectionType: 'H',
        profileResult: hProfile,
        sectionData: hSectionData,
        isJsonInput,
      });
      hMesh.userData.srcComponentType = 'S';
      hMesh.userData.isShapeTSteel = true;
      hMesh.userData.shapeTPart = 'H';
      hMesh.userData.shapeTShape = shapeH;
      meshes.push(hMesh);
    }
  } else {
    log.warn(`${element.id}: SHAPE_T H形鋼の断面生成に失敗 (${shapeH})`);
  }

  // --- T形鋼（H形鋼と直交、ウェブをH形ウェブ線へ接合） ---
  const tSectionData = { section_type: 'T', dimensions: tDims };
  const tProfile = createSectionProfile(tSectionData, 'T', element.id, log);
  if (tProfile?.shape) {
    const tGeo = createExtrudeGeometry(tProfile.shape, placement.length);
    if (tGeo) {
      if (cfg.tAngle !== 0) tGeo.rotateZ(cfg.tAngle);
      tGeo.translate(cfg.tCenter.x, cfg.tCenter.y, 0);
      const tMesh = new THREE.Mesh(tGeo, colorManager.getMaterial('diff', matOptions()));
      applyPlacementToMesh(tMesh, placement);
      tMesh.userData = buildMetadata({
        element,
        elementType,
        placement,
        sectionType: 'T',
        profileResult: tProfile,
        sectionData: tSectionData,
        isJsonInput,
      });
      tMesh.userData.srcComponentType = 'S';
      tMesh.userData.isShapeTSteel = true;
      tMesh.userData.shapeTPart = 'T';
      tMesh.userData.shapeTShape = shapeT;
      meshes.push(tMesh);
    }
  } else {
    log.warn(`${element.id}: SHAPE_T T形鋼の断面生成に失敗 (${shapeT})`);
  }

  return meshes.length > 0 ? meshes : null;
}
