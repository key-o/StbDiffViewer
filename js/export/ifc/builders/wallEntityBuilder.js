/**
 * @fileoverview 壁（IfcWall）と開口（IfcOpeningElement）のIFCエンティティ生成
 * IFCExporterBase から分離したエンティティ生成関数群
 * @module export/ifc/builders/wallEntityBuilder
 */

import { generateIfcGuid } from '../StepWriter.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('export:ifc:wallEntityBuilder');

/**
 * 壁のIFCエンティティを作成
 * @param {Object} w - StepWriterインスタンス
 * @param {Object} wallData - 壁データ
 * @param {string} wallData.name - 壁名
 * @param {Object} wallData.startPoint - 始点 {x, y, z} (mm)
 * @param {Object} wallData.endPoint - 終点 {x, y, z} (mm)
 * @param {number} wallData.height - 高さ (mm)
 * @param {number} wallData.thickness - 厚さ (mm)
 * @param {string} [wallData.predefinedType='STANDARD'] - 壁タイプ
 * @param {Array<Object>} [wallData.openings] - 開口情報配列
 * @param {number} bodyContext - Body表現コンテキストのエンティティID
 * @returns {Object|null} 壁エンティティ情報（生成できない場合はnull）
 */
export function createWallEntities(w, wallData, bodyContext) {
  const {
    name = 'Wall',
    startPoint,
    endPoint,
    height = 3000,
    thickness = 200,
    predefinedType = 'STANDARD',
    kindStructure = 'RC',
    openings = [],
  } = wallData;

  if (!startPoint || !endPoint) {
    log.warn(`[IFC Export] 壁 "${name}" をスキップ: 始点・終点が不足`);
    return null;
  }

  const dx = endPoint.x - startPoint.x;
  const dy = endPoint.y - startPoint.y;
  const wallLength = Math.sqrt(dx * dx + dy * dy);

  if (wallLength < 1 || height <= 0 || thickness <= 0) {
    log.warn(`[IFC Export] 壁 "${name}" をスキップ: 寸法が不正`);
    return null;
  }

  // 壁の方向ベクトル（正規化）
  const dirX = dx / wallLength;
  const dirY = dy / wallLength;

  // 矩形プロファイル（長さ x 厚さ）
  const profileId = w.createEntity('IFCRECTANGLEPROFILEDEF', [
    '.AREA.',
    'WallProfile',
    null,
    wallLength,
    thickness,
  ]);

  // 押出方向: Z軸（上向き）
  const extrudeDirId = w.createEntity('IFCDIRECTION', [[0.0, 0.0, 1.0]]);

  // 押出形状
  const solidId = w.createEntity('IFCEXTRUDEDAREASOLID', [
    `#${profileId}`,
    null,
    `#${extrudeDirId}`,
    height,
  ]);

  // 壁の中心点を計算（始点と終点の中間）
  const centerX = (startPoint.x + endPoint.x) / 2;
  const centerY = (startPoint.y + endPoint.y) / 2;

  const wallOrigin = w.createEntity('IFCCARTESIANPOINT', [[centerX, centerY, startPoint.z]]);
  const wallRefDir = w.createEntity('IFCDIRECTION', [[dirX, dirY, 0.0]]);

  const wallPlacement3D = w.createEntity('IFCAXIS2PLACEMENT3D', [
    `#${wallOrigin}`,
    null,
    `#${wallRefDir}`,
  ]);

  const wallLocalPlacement = w.createEntity('IFCLOCALPLACEMENT', [null, `#${wallPlacement3D}`]);

  const shapeRep = w.createEntity('IFCSHAPEREPRESENTATION', [
    `#${bodyContext}`,
    'Body',
    'SweptSolid',
    [`#${solidId}`],
  ]);

  const productShape = w.createEntity('IFCPRODUCTDEFINITIONSHAPE', [null, null, [`#${shapeRep}`]]);

  const wallId = w.createEntity('IFCWALL', [
    generateIfcGuid(),
    null,
    name,
    null,
    kindStructure, // ObjectType: kind_structure (RC/S/SRC)
    `#${wallLocalPlacement}`,
    `#${productShape}`,
    null,
    `.${predefinedType}.`,
  ]);

  return { wallId, wallLength, thickness, wallLocalPlacement, baseZ: startPoint.z, openings };
}

/**
 * 壁に開口のIFCエンティティを追加
 * @param {Object} w - StepWriterインスタンス
 * @param {number} wallId - 壁エンティティID
 * @param {Array<Object>} openings - 開口情報配列
 * @param {Object} wallContext - 壁のコンテキスト情報
 * @param {number} bodyContext - Body表現コンテキストのエンティティID
 */
export function createWallOpeningEntities(w, wallId, openings, wallContext, bodyContext) {
  const { wallLength, thickness, wallLocalPlacement } = wallContext;

  for (const opening of openings) {
    const openingWidth = opening.width;
    const openingHeight = opening.height;

    if (!openingWidth || openingWidth <= 0 || !openingHeight || openingHeight <= 0) {
      log.warn(`[IFC Export] 開口 "${opening.id}" をスキップ: サイズが不正です`);
      continue;
    }

    const openingName = opening.name || `Opening_${opening.id}`;

    // 開口の矩形プロファイル
    const openingProfileId = w.createEntity('IFCRECTANGLEPROFILEDEF', [
      '.AREA.',
      'OpeningProfile',
      null,
      openingWidth,
      thickness + 100,
    ]);

    const extrudeDirId = w.createEntity('IFCDIRECTION', [[0.0, 0.0, 1.0]]);

    const openingSolidId = w.createEntity('IFCEXTRUDEDAREASOLID', [
      `#${openingProfileId}`,
      null,
      `#${extrudeDirId}`,
      openingHeight,
    ]);

    // 開口の位置計算（壁ローカル座標系での位置）
    const openingCenterX = opening.positionX + openingWidth / 2 - wallLength / 2;
    const openingCenterZ = opening.positionY;

    const openingOrigin = w.createEntity('IFCCARTESIANPOINT', [
      [openingCenterX, 0, openingCenterZ],
    ]);

    const openingPlacement3D = w.createEntity('IFCAXIS2PLACEMENT3D', [
      `#${openingOrigin}`,
      null,
      null,
    ]);

    const openingLocalPlacement = w.createEntity('IFCLOCALPLACEMENT', [
      `#${wallLocalPlacement}`,
      `#${openingPlacement3D}`,
    ]);

    const openingShapeRep = w.createEntity('IFCSHAPEREPRESENTATION', [
      `#${bodyContext}`,
      'Body',
      'SweptSolid',
      [`#${openingSolidId}`],
    ]);

    const openingProductShape = w.createEntity('IFCPRODUCTDEFINITIONSHAPE', [
      null,
      null,
      [`#${openingShapeRep}`],
    ]);

    const openingId = w.createEntity('IFCOPENINGELEMENT', [
      generateIfcGuid(),
      null,
      openingName,
      null,
      null,
      `#${openingLocalPlacement}`,
      `#${openingProductShape}`,
      null,
      '.OPENING.',
    ]);

    w.createEntity('IFCRELVOIDSELEMENT', [
      generateIfcGuid(),
      null,
      null,
      null,
      `#${wallId}`,
      `#${openingId}`,
    ]);
  }
}
