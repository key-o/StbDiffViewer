/**
 * @fileoverview 梁（IfcBeam）のIFCエンティティ生成
 * IFCBeamExporter から分離した配置計算・エンティティ生成処理
 * @module export/ifc/builders/beamEntityBuilder
 */

import { generateIfcGuid } from '../StepWriter.js';
import { calculateBeamBasis, rotateVectorAroundAxis } from '../../../data/geometry/vectorMath.js';
import { STB_TAG_NAMES } from '../../../constants/elementTypes.js';

/**
 * 梁のIFCエンティティを作成
 * @param {Object} w - StepWriterインスタンス
 * @param {Object} params - 梁パラメータ
 * @param {string} params.name - 梁名
 * @param {Object} params.startPoint - 始点座標 {x, y, z} (mm)
 * @param {Object} params.endPoint - 終点座標 {x, y, z} (mm)
 * @param {number} params.length - 梁長さ (mm)
 * @param {number} params.rotation - 断面の回転角度（度）
 * @param {string} params.placementMode - 配置モード ('center' | 'top-aligned')
 * @param {number} params.sectionHeight - 断面高さ（mm）天端基準配置用
 * @param {string} params.kindStructure - 構造種別 (S/RC/SRC)
 * @param {string} params.stbType - STBタグ名（StbGirder / StbBeam）
 * @param {number} params.profileId - プロファイルエンティティID
 * @param {number} params.bodyContext - Body表現コンテキストのエンティティID
 * @param {Function|null} [params.createSteelProfileId] - SRC鉄骨プロファイル生成関数
 * @returns {{beamId: number, beamZ: number}} 梁エンティティIDと階判定用Z座標
 */
export function createBeamEntities(w, params) {
  const {
    name,
    startPoint,
    endPoint,
    length,
    rotation,
    placementMode,
    sectionHeight,
    kindStructure,
    stbType,
    profileId,
    bodyContext,
    createSteelProfileId = null,
  } = params;

  // 梁の方向ベクトル
  const dx = endPoint.x - startPoint.x;
  const dy = endPoint.y - startPoint.y;
  const dz = endPoint.z - startPoint.z;
  const dirX = dx / length;
  const dirY = dy / length;
  const dirZ = dz / length;

  // 梁のローカル基底ベクトルを計算（vectorMath共通関数を使用）
  const dir = { x: dirX, y: dirY, z: dirZ };
  const basis = calculateBeamBasis(dir);

  // 天端基準配置の場合、配置点をローカルY軸方向に -sectionHeight/2 シフト
  let adjustedStartX = startPoint.x;
  let adjustedStartY = startPoint.y;
  let adjustedStartZ = startPoint.z;

  if (placementMode === 'top-aligned' && sectionHeight > 0 && isFinite(sectionHeight)) {
    const shift = -sectionHeight / 2;
    adjustedStartX += basis.yAxis.x * shift;
    adjustedStartY += basis.yAxis.y * shift;
    adjustedStartZ += basis.yAxis.z * shift;
  }

  // 梁の配置点（天端基準調整後）(mm)
  const beamOrigin = w.createEntity('IFCCARTESIANPOINT', [
    [adjustedStartX, adjustedStartY, adjustedStartZ],
  ]);

  // 梁の軸方向
  const beamAxisDir = w.createEntity('IFCDIRECTION', [[dirX, dirY, dirZ]]);

  // 梁の参照方向（RefDirection）- 回転角度を適用
  let refDir = basis.xAxis;
  if (Math.abs(rotation) > 1e-6) {
    const rotationRad = (rotation * Math.PI) / 180;
    refDir = rotateVectorAroundAxis(basis.xAxis, dir, rotationRad);
  }
  const beamRefDir = w.createEntity('IFCDIRECTION', [[refDir.x, refDir.y, refDir.z]]);

  // 梁の配置座標系
  const beamPlacement3D = w.createEntity('IFCAXIS2PLACEMENT3D', [
    `#${beamOrigin}`,
    `#${beamAxisDir}`,
    `#${beamRefDir}`,
  ]);

  // 梁のローカル配置（柱と同様にグローバル座標系を使用）
  const beamLocalPlacement = w.createEntity('IFCLOCALPLACEMENT', [
    null, // PlacementRelTo: グローバル配置
    `#${beamPlacement3D}`,
  ]);

  // 押出方向（ローカル座標系のZ方向）
  const extrudeDir = w.createEntity('IFCDIRECTION', [[0.0, 0.0, 1.0]]);

  // 押出用の配置（プロファイルの位置）
  const extrudeOrigin = w.createEntity('IFCCARTESIANPOINT', [[0.0, 0.0, 0.0]]);
  const extrudePlacement = w.createEntity('IFCAXIS2PLACEMENT3D', [`#${extrudeOrigin}`, null, null]);

  // 押出形状を作成 (mm)
  const solidId = w.createEntity('IFCEXTRUDEDAREASOLID', [
    `#${profileId}`,
    `#${extrudePlacement}`,
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
        `#${extrudePlacement}`,
        `#${extrudeDir}`,
        length,
      ]);
      solidItems.push(`#${steelSolidId}`);
    }
  }

  // 形状表現
  const shapeRep = w.createEntity('IFCSHAPEREPRESENTATION', [
    `#${bodyContext}`, // ContextOfItems
    'Body', // RepresentationIdentifier
    'SweptSolid', // RepresentationType
    solidItems, // Items
  ]);

  // 製品定義形状
  const productShape = w.createEntity('IFCPRODUCTDEFINITIONSHAPE', [
    null, // Name
    null, // Description
    [`#${shapeRep}`], // Representations
  ]);

  // 梁エンティティ（ObjectTypeにkind_structureを格納）
  const beamId = w.createEntity('IFCBEAM', [
    generateIfcGuid(), // GlobalId
    null, // OwnerHistory
    name, // Name
    null, // Description
    kindStructure, // ObjectType: kind_structure (S/RC/SRC)
    `#${beamLocalPlacement}`, // ObjectPlacement
    `#${productShape}`, // Representation
    null, // Tag
    stbType === STB_TAG_NAMES.BEAM ? '.USERDEFINED.' : '.BEAM.', // PredefinedType: StbBeam=USERDEFINED, StbGirder=BEAM
  ]);

  // 天端基準配置調整後のZ座標で適切な階を決定する
  const beamZ = Math.min(adjustedStartZ, adjustedStartZ + dz);

  return { beamId, beamZ };
}
