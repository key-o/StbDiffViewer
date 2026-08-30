/**
 * @fileoverview 柱・間柱（IfcColumn）のIFCエンティティ生成
 * IFCBeamExporter から分離した配置計算・エンティティ生成処理
 * @module export/ifc/builders/columnEntityBuilder
 */

import { generateIfcGuid } from '../StepWriter.js';

/**
 * 柱のIFCエンティティを作成
 * @param {Object} w - StepWriterインスタンス
 * @param {Object} params - 柱パラメータ
 * @param {string} params.name - 柱名
 * @param {Object} params.bottomPoint - 底部座標 {x, y, z} (mm)
 * @param {number} params.length - 柱長さ (mm)
 * @param {number} params.rotation - 断面の回転角度（度）
 * @param {boolean} params.isReferenceDirection - 基準方向フラグ（falseの場合90度回転追加）
 * @param {string} params.kindStructure - 構造種別 (S/RC/SRC/CFT)
 * @param {number} params.profileId - プロファイルエンティティID
 * @param {number} params.bodyContext - Body表現コンテキストのエンティティID
 * @param {Function|null} [params.createSteelProfileId] - SRC鉄骨プロファイル生成関数
 * @returns {number} 柱エンティティID
 */
export function createColumnEntities(w, params) {
  const {
    name,
    bottomPoint,
    length,
    rotation,
    isReferenceDirection,
    kindStructure,
    profileId,
    bodyContext,
    createSteelProfileId = null,
  } = params;

  // 押出方向（垂直: Z方向）
  const extrudeDir = w.createEntity('IFCDIRECTION', [[0.0, 0.0, 1.0]]);

  // プロファイルの位置（下端原点基準: 0 から length まで押出）
  const extrudeOrigin = w.createEntity('IFCCARTESIANPOINT', [[0.0, 0.0, 0.0]]);
  const extrudePosition = w.createEntity('IFCAXIS2PLACEMENT3D', [`#${extrudeOrigin}`, null, null]);

  // 押出形状を作成 (mm)
  const solidId = w.createEntity('IFCEXTRUDEDAREASOLID', [
    `#${profileId}`,
    `#${extrudePosition}`, // Position: Z = 0 から開始（下端原点基準）
    `#${extrudeDir}`,
    length,
  ]);

  // 形状表現の Items を構築
  const solidItems = [`#${solidId}`];

  // SRC造の場合、鉄骨プロファイルも追加（コンクリート外殻＋鉄骨内部の複合表現）
  if (createSteelProfileId) {
    const steelProfileId = createSteelProfileId();
    if (steelProfileId !== null) {
      const steelSolidId = w.createEntity('IFCEXTRUDEDAREASOLID', [
        `#${steelProfileId}`,
        `#${extrudePosition}`,
        `#${extrudeDir}`,
        length,
      ]);
      solidItems.push(`#${steelSolidId}`);
    }
  }

  // 柱の配置点（下端）(mm) - IFC標準に従い下端を原点とする
  const columnOrigin = w.createEntity('IFCCARTESIANPOINT', [
    [bottomPoint.x, bottomPoint.y, bottomPoint.z],
  ]);

  // 回転角度を計算（度 → ラジアン）
  // isReferenceDirection=false の場合は90度追加（H型配置）
  let effectiveRotationDeg = rotation;
  if (!isReferenceDirection) {
    effectiveRotationDeg += 90;
  }
  const effectiveRotationRad = (effectiveRotationDeg * Math.PI) / 180;

  // Z軸（垂直方向）
  const axisDir = w.createEntity('IFCDIRECTION', [[0.0, 0.0, 1.0]]);

  // 参照方向（XY平面上の回転）
  const cosVal = Math.cos(effectiveRotationRad);
  const sinVal = Math.sin(effectiveRotationRad);
  const refDir = w.createEntity('IFCDIRECTION', [[cosVal, sinVal, 0.0]]);

  // 配置座標系（軸・参照方向を設定）
  const columnPlacement3D = w.createEntity('IFCAXIS2PLACEMENT3D', [
    `#${columnOrigin}`,
    `#${axisDir}`, // Axis: Z方向
    `#${refDir}`, // RefDirection: 回転を反映
  ]);

  // 柱のローカル配置
  const columnLocalPlacement = w.createEntity('IFCLOCALPLACEMENT', [
    null, // PlacementRelTo: グローバル配置
    `#${columnPlacement3D}`,
  ]);

  // 形状表現
  const shapeRep = w.createEntity('IFCSHAPEREPRESENTATION', [
    `#${bodyContext}`,
    'Body',
    'SweptSolid',
    solidItems,
  ]);

  // 製品定義形状
  const productShape = w.createEntity('IFCPRODUCTDEFINITIONSHAPE', [null, null, [`#${shapeRep}`]]);

  // 柱エンティティ（ObjectTypeにkind_structureを格納）
  return w.createEntity('IFCCOLUMN', [
    generateIfcGuid(),
    null, // OwnerHistory
    name,
    null, // Description
    kindStructure, // ObjectType: kind_structure (S/RC/SRC/CFT)
    `#${columnLocalPlacement}`,
    `#${productShape}`,
    null, // Tag
    null, // PredefinedType
  ]);
}

/**
 * 間柱のIFCエンティティを作成（IFCCOLUMNとして出力、PredefinedTypeで区別）
 * @param {Object} w - StepWriterインスタンス
 * @param {Object} params - 間柱パラメータ
 * @param {string} params.name - 間柱名
 * @param {Object} params.bottomPoint - 底部座標 {x, y, z} (mm)
 * @param {number} params.length - 間柱長さ (mm)
 * @param {number} params.rotation - 断面の回転角度（度）
 * @param {boolean} params.isReferenceDirection - 基準方向フラグ（falseの場合90度回転追加）
 * @param {string} params.kindStructure - 構造種別 (S/RC/SRC/CFT)
 * @param {number} params.profileId - プロファイルエンティティID
 * @param {number} params.bodyContext - Body表現コンテキストのエンティティID
 * @returns {number} 間柱エンティティID
 */
export function createPostEntities(w, params) {
  const {
    name,
    bottomPoint,
    length,
    rotation,
    isReferenceDirection,
    kindStructure,
    profileId,
    bodyContext,
  } = params;

  // 押出方向（垂直: Z方向）
  const extrudeDir = w.createEntity('IFCDIRECTION', [[0.0, 0.0, 1.0]]);

  // プロファイルの位置（下端原点基準: 0 から length まで押出）
  const extrudeOrigin = w.createEntity('IFCCARTESIANPOINT', [[0.0, 0.0, 0.0]]);
  const extrudePosition = w.createEntity('IFCAXIS2PLACEMENT3D', [`#${extrudeOrigin}`, null, null]);

  // 押出形状を作成 (mm)
  const solidId = w.createEntity('IFCEXTRUDEDAREASOLID', [
    `#${profileId}`,
    `#${extrudePosition}`, // Position: Z = 0 から開始（下端原点基準）
    `#${extrudeDir}`,
    length,
  ]);

  // 間柱の配置点（下端）(mm) - IFC標準に従い下端を原点とする
  const postOrigin = w.createEntity('IFCCARTESIANPOINT', [
    [bottomPoint.x, bottomPoint.y, bottomPoint.z],
  ]);

  // 回転角度を計算（度 → ラジアン）
  // isReferenceDirection=false の場合は90度追加（H型配置）
  let effectiveRotationDeg = rotation;
  if (!isReferenceDirection) {
    effectiveRotationDeg += 90;
  }
  const effectiveRotationRad = (effectiveRotationDeg * Math.PI) / 180;

  // Z軸（垂直方向）
  const axisDir = w.createEntity('IFCDIRECTION', [[0.0, 0.0, 1.0]]);

  // 参照方向（XY平面上の回転）
  const cosVal = Math.cos(effectiveRotationRad);
  const sinVal = Math.sin(effectiveRotationRad);
  const refDir = w.createEntity('IFCDIRECTION', [[cosVal, sinVal, 0.0]]);

  // 配置座標系（軸・参照方向を設定）
  const postPlacement3D = w.createEntity('IFCAXIS2PLACEMENT3D', [
    `#${postOrigin}`,
    `#${axisDir}`, // Axis: Z方向
    `#${refDir}`, // RefDirection: 回転を反映
  ]);

  // 間柱のローカル配置
  const postLocalPlacement = w.createEntity('IFCLOCALPLACEMENT', [
    null, // PlacementRelTo: グローバル配置
    `#${postPlacement3D}`,
  ]);

  // 形状表現
  const shapeRep = w.createEntity('IFCSHAPEREPRESENTATION', [
    `#${bodyContext}`,
    'Body',
    'SweptSolid',
    [`#${solidId}`],
  ]);

  // 製品定義形状
  const productShape = w.createEntity('IFCPRODUCTDEFINITIONSHAPE', [null, null, [`#${shapeRep}`]]);

  // 間柱エンティティ（IFCCOLUMNとして出力、ObjectTypeで区別）
  return w.createEntity('IFCCOLUMN', [
    generateIfcGuid(),
    null, // OwnerHistory
    name,
    null, // Description
    kindStructure, // ObjectType: kind_structure (S/RC/SRC/CFT)
    `#${postLocalPlacement}`,
    `#${productShape}`,
    null, // Tag
    '.USERDEFINED.', // PredefinedType: 間柱識別子
  ]);
}
