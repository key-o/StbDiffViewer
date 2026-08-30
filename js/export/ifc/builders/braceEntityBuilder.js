/**
 * @fileoverview ブレース（IfcMember）のIFCエンティティ生成
 * IFCBeamExporter から分離した配置計算・エンティティ生成処理
 * @module export/ifc/builders/braceEntityBuilder
 */

import { generateIfcGuid } from '../StepWriter.js';
import { calculateBeamBasis, rotateVectorAroundAxis } from '../../../data/geometry/vectorMath.js';

/**
 * ブレースのIFCエンティティを作成
 * @param {Object} w - StepWriterインスタンス
 * @param {Object} params - ブレースパラメータ
 * @param {string} params.name - ブレース名
 * @param {Object} params.startPoint - 始点座標 {x, y, z} (mm)
 * @param {Object} params.endPoint - 終点座標 {x, y, z} (mm)
 * @param {number} params.length - ブレース長さ (mm)
 * @param {number} params.rotation - 断面の回転角度（度）
 * @param {string} params.kindStructure - 構造種別 (S)
 * @param {number} params.profileId - プロファイルエンティティID
 * @param {number} params.bodyContext - Body表現コンテキストのエンティティID
 * @returns {number} ブレースエンティティID
 */
export function createBraceEntities(w, params) {
  const { name, startPoint, endPoint, length, rotation, kindStructure, profileId, bodyContext } =
    params;

  // ブレースの方向ベクトル（正規化）
  const dx = endPoint.x - startPoint.x;
  const dy = endPoint.y - startPoint.y;
  const dz = endPoint.z - startPoint.z;
  const dirX = dx / length;
  const dirY = dy / length;
  const dirZ = dz / length;

  // ブレースの配置点（始点）(mm)
  const braceOrigin = w.createEntity('IFCCARTESIANPOINT', [
    [startPoint.x, startPoint.y, startPoint.z],
  ]);

  // ブレースの軸方向（押出方向と同じ）
  const braceAxisDir = w.createEntity('IFCDIRECTION', [[dirX, dirY, dirZ]]);

  // 参照方向の計算（vectorMath共通関数を使用）
  // ブレースでは dir × globalUp を参照方向とする（梁のxAxisの反転に相当）
  const dir = { x: dirX, y: dirY, z: dirZ };
  const basis = calculateBeamBasis(dir);
  // ブレースの参照方向は -xAxis（dir × globalUp = -(globalUp × dir)）
  let baseRefDir = { x: -basis.xAxis.x, y: -basis.xAxis.y, z: -basis.xAxis.z };

  // 垂直に近い場合はY方向を参照（calculateBeamBasisの垂直時とは異なるため上書き）
  if (Math.abs(dirZ) >= 0.99) {
    baseRefDir = { x: 0, y: 1, z: 0 };
  }

  // 回転角度を適用（ブレース軸周りの回転）
  let refDir = baseRefDir;
  if (Math.abs(rotation) > 1e-6) {
    const rotationRad = (rotation * Math.PI) / 180;
    refDir = rotateVectorAroundAxis(baseRefDir, dir, rotationRad);
  }
  const braceRefDir = w.createEntity('IFCDIRECTION', [[refDir.x, refDir.y, refDir.z]]);

  // 配置座標系（始点、軸方向、参照方向）
  const bracePlacement3D = w.createEntity('IFCAXIS2PLACEMENT3D', [
    `#${braceOrigin}`,
    `#${braceAxisDir}`,
    `#${braceRefDir}`,
  ]);

  // ローカル配置（グローバル基準）
  const braceLocalPlacement = w.createEntity('IFCLOCALPLACEMENT', [
    null, // PlacementRelTo: グローバル配置
    `#${bracePlacement3D}`,
  ]);

  // 押出方向（ローカル座標系のZ方向 = 軸方向）
  const extrudeDir = w.createEntity('IFCDIRECTION', [[0.0, 0.0, 1.0]]);

  // 押出形状 (mm)
  const solidId = w.createEntity('IFCEXTRUDEDAREASOLID', [
    `#${profileId}`,
    null, // Position: デフォルト
    `#${extrudeDir}`,
    length,
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

  // ブレースエンティティ（IFCMEMBER、ObjectTypeにkind_structureを格納）
  return w.createEntity('IFCMEMBER', [
    generateIfcGuid(),
    null, // OwnerHistory
    name,
    null, // Description
    kindStructure, // ObjectType: kind_structure (S)
    `#${braceLocalPlacement}`,
    `#${productShape}`,
    null, // Tag
    '.BRACE.', // PredefinedType
  ]);
}
