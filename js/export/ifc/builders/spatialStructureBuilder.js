/**
 * @fileoverview IFCの共通エンティティ（基本ジオメトリ・単位系・コンテキスト・
 * プロジェクト/サイト/建物階層・階）の生成
 * IFCExporterBase から分離したエンティティ生成関数群
 * @module export/ifc/builders/spatialStructureBuilder
 */

import { generateIfcGuid } from '../StepWriter.js';

/**
 * 共通のIFCエンティティ（基本ジオメトリ、単位系、コンテキスト、
 * プロジェクト・サイト・建物）を作成する
 * @param {Object} w - StepWriterインスタンス
 * @returns {Object} 生成したエンティティIDのマップ（_refs へマージして使用する）
 */
export function createSpatialContextEntities(w) {
  const refs = {};

  // ===== 基本ジオメトリ =====
  // 原点
  refs.origin = w.createEntity('IFCCARTESIANPOINT', [[0.0, 0.0, 0.0]]);

  // 方向ベクトル
  refs.dirZ = w.createEntity('IFCDIRECTION', [[0.0, 0.0, 1.0]]);
  refs.dirX = w.createEntity('IFCDIRECTION', [[1.0, 0.0, 0.0]]);
  refs.dirY = w.createEntity('IFCDIRECTION', [[0.0, 1.0, 0.0]]);
  refs.dir2dX = w.createEntity('IFCDIRECTION', [[1.0, 0.0]]);
  refs.dir2dY = w.createEntity('IFCDIRECTION', [[0.0, 1.0]]);

  // 2D原点
  refs.origin2d = w.createEntity('IFCCARTESIANPOINT', [[0.0, 0.0]]);

  // ワールド座標系
  refs.worldCoordSystem = w.createEntity('IFCAXIS2PLACEMENT3D', [
    `#${refs.origin}`,
    `#${refs.dirZ}`,
    `#${refs.dirX}`,
  ]);

  // 2D座標系（プロファイル用）
  refs.profilePlacement = w.createEntity('IFCAXIS2PLACEMENT2D', [
    `#${refs.origin2d}`,
    `#${refs.dir2dX}`,
  ]);

  // ===== 単位系 =====
  // 長さ: ミリメートル (STBデータと同じ)
  refs.unitLength = w.createEntity('IFCSIUNIT', ['*', '.LENGTHUNIT.', '.MILLI.', '.METRE.']);
  // 面積: 平方メートル
  refs.unitArea = w.createEntity('IFCSIUNIT', ['*', '.AREAUNIT.', null, '.SQUARE_METRE.']);
  // 体積: 立方メートル
  refs.unitVolume = w.createEntity('IFCSIUNIT', ['*', '.VOLUMEUNIT.', null, '.CUBIC_METRE.']);
  // 角度: ラジアン
  refs.unitAngle = w.createEntity('IFCSIUNIT', ['*', '.PLANEANGLEUNIT.', null, '.RADIAN.']);

  // 単位割当
  refs.unitAssignment = w.createEntity('IFCUNITASSIGNMENT', [
    [`#${refs.unitLength}`, `#${refs.unitArea}`, `#${refs.unitVolume}`, `#${refs.unitAngle}`],
  ]);

  // ===== コンテキスト =====
  // 幾何表現コンテキスト
  refs.geometricContext = w.createEntity('IFCGEOMETRICREPRESENTATIONCONTEXT', [
    null, // ContextIdentifier
    'Model', // ContextType
    3, // CoordinateSpaceDimension
    1.0e-5, // Precision
    `#${refs.worldCoordSystem}`, // WorldCoordinateSystem
    null, // TrueNorth
  ]);

  // サブコンテキスト（Body用）
  refs.bodyContext = w.createEntity('IFCGEOMETRICREPRESENTATIONSUBCONTEXT', [
    'Body', // ContextIdentifier
    'Model', // ContextType
    '*', // CoordinateSpaceDimension (inherited)
    '*', // Precision (inherited)
    '*', // WorldCoordinateSystem (inherited)
    '*', // TrueNorth (inherited)
    `#${refs.geometricContext}`, // ParentContext
    null, // TargetScale
    '.MODEL_VIEW.', // TargetView
    null, // UserDefinedTargetView
  ]);

  // ===== プロジェクト =====
  refs.project = w.createEntity('IFCPROJECT', [
    generateIfcGuid(), // GlobalId
    null, // OwnerHistory
    'STB Export Project', // Name
    'Exported from StbDiffViewer', // Description
    null, // ObjectType
    null, // LongName
    null, // Phase
    [`#${refs.geometricContext}`], // RepresentationContexts
    `#${refs.unitAssignment}`, // UnitsInContext
  ]);

  // ===== サイト =====
  refs.sitePlacement = w.createEntity('IFCLOCALPLACEMENT', [
    null, // PlacementRelTo
    `#${refs.worldCoordSystem}`, // RelativePlacement
  ]);

  refs.site = w.createEntity('IFCSITE', [
    generateIfcGuid(), // GlobalId
    null, // OwnerHistory
    'Default Site', // Name
    null, // Description
    null, // ObjectType
    `#${refs.sitePlacement}`, // ObjectPlacement
    null, // Representation
    null, // LongName
    '.ELEMENT.', // CompositionType
    null, // RefLatitude
    null, // RefLongitude
    null, // RefElevation
    null, // LandTitleNumber
    null, // SiteAddress
  ]);

  // プロジェクト → サイト 関係
  refs.relProjectSite = w.createEntity('IFCRELAGGREGATES', [
    generateIfcGuid(), // GlobalId
    null, // OwnerHistory
    null, // Name
    null, // Description
    `#${refs.project}`, // RelatingObject
    [`#${refs.site}`], // RelatedObjects
  ]);

  // ===== 建物 =====
  refs.buildingPlacement = w.createEntity('IFCLOCALPLACEMENT', [
    `#${refs.sitePlacement}`, // PlacementRelTo
    `#${refs.worldCoordSystem}`, // RelativePlacement
  ]);

  refs.building = w.createEntity('IFCBUILDING', [
    generateIfcGuid(), // GlobalId
    null, // OwnerHistory
    'Default Building', // Name
    null, // Description
    null, // ObjectType
    `#${refs.buildingPlacement}`, // ObjectPlacement
    null, // Representation
    null, // LongName
    '.ELEMENT.', // CompositionType
    null, // ElevationOfRefHeight
    null, // ElevationOfTerrain
    null, // BuildingAddress
  ]);

  // サイト → 建物 関係
  refs.relSiteBuilding = w.createEntity('IFCRELAGGREGATES', [
    generateIfcGuid(), // GlobalId
    null, // OwnerHistory
    null, // Name
    null, // Description
    `#${refs.site}`, // RelatingObject
    [`#${refs.building}`], // RelatedObjects
  ]);

  return refs;
}

/**
 * 単一の階（IFCBUILDINGSTOREY）を作成
 * @param {Object} w - StepWriterインスタンス
 * @param {string} name - 階名
 * @param {number} elevation - 階高さ（mm）
 * @param {Object} refs - 共通エンティティ参照（dirZ, dirX, buildingPlacement を使用）
 * @returns {{storeyId: number, storeyPlacement: number}} 階エンティティIDと配置ID
 */
export function createSingleStoreyEntity(w, name, elevation, refs) {
  // 階の配置（高さを反映）
  const storeyOrigin = w.createEntity('IFCCARTESIANPOINT', [[0.0, 0.0, elevation]]);
  const storeyAxis2Placement = w.createEntity('IFCAXIS2PLACEMENT3D', [
    `#${storeyOrigin}`,
    `#${refs.dirZ}`,
    `#${refs.dirX}`,
  ]);
  const storeyPlacement = w.createEntity('IFCLOCALPLACEMENT', [
    `#${refs.buildingPlacement}`, // PlacementRelTo
    `#${storeyAxis2Placement}`, // RelativePlacement
  ]);

  const storeyId = w.createEntity('IFCBUILDINGSTOREY', [
    generateIfcGuid(), // GlobalId
    null, // OwnerHistory
    name, // Name
    null, // Description
    null, // ObjectType
    `#${storeyPlacement}`, // ObjectPlacement
    null, // Representation
    null, // LongName
    '.ELEMENT.', // CompositionType
    elevation, // Elevation
  ]);

  return { storeyId, storeyPlacement };
}
