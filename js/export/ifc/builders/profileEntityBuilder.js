/**
 * @fileoverview IFC断面プロファイル定義（IfcProfileDef系）エンティティの生成
 * IFCExporterBase から分離した形状別のプロファイル生成関数群。
 * position には IFCAXIS2PLACEMENT2D への参照文字列（例: '#12'）または null を渡す。
 * @module export/ifc/builders/profileEntityBuilder
 */

/**
 * H形鋼プロファイルを作成
 * @param {Object} w - StepWriterインスタンス
 * @param {string|null} position - Position（IFCAXIS2PLACEMENT2D参照）
 * @param {Object} params - プロファイルパラメータ
 * @param {number} params.overallDepth - 全高 (mm)
 * @param {number} params.overallWidth - 全幅 (mm)
 * @param {number} params.webThickness - ウェブ厚 (mm)
 * @param {number} params.flangeThickness - フランジ厚 (mm)
 * @param {number} [params.filletRadius=0] - フィレット半径 (mm)
 * @returns {number} プロファイルエンティティID
 */
export function createIShapeProfileEntity(w, position, params) {
  const {
    overallDepth = 400,
    overallWidth = 200,
    webThickness = 8,
    flangeThickness = 13,
    filletRadius = 0,
  } = params;

  return w.createEntity('IFCISHAPEPROFILEDEF', [
    '.AREA.', // ProfileType
    'H-Shape', // ProfileName
    position, // Position
    overallWidth, // OverallWidth (mm)
    overallDepth, // OverallDepth (mm)
    webThickness, // WebThickness (mm)
    flangeThickness, // FlangeThickness (mm)
    filletRadius > 0 ? filletRadius : null, // FilletRadius (mm)
    null, // FlangeEdgeRadius (optional)
    null, // FlangeSlope (optional)
  ]);
}

/**
 * 矩形プロファイルを作成
 * @param {Object} w - StepWriterインスタンス
 * @param {string|null} position - Position（IFCAXIS2PLACEMENT2D参照）
 * @param {Object} params - プロファイルパラメータ
 * @param {number} params.width - 幅 (mm)
 * @param {number} params.height - 高さ (mm)
 * @returns {number} プロファイルエンティティID
 */
export function createRectangleProfileEntity(w, position, params) {
  const { width = 400, height = 600 } = params;

  return w.createEntity('IFCRECTANGLEPROFILEDEF', [
    '.AREA.', // ProfileType
    'Rectangle', // ProfileName
    position, // Position
    width, // XDim (mm)
    height, // YDim (mm)
  ]);
}

/**
 * 角形鋼管（BOX）プロファイルを作成
 * @param {Object} w - StepWriterインスタンス
 * @param {string|null} position - Position（IFCAXIS2PLACEMENT2D参照）
 * @param {Object} params - プロファイルパラメータ
 * @param {number} params.width - 幅 (mm)
 * @param {number} params.height - 高さ (mm)
 * @param {number} params.wallThickness - 板厚 (mm)
 * @returns {number} プロファイルエンティティID
 */
export function createHollowRectangleProfileEntity(w, position, params) {
  const {
    width = 200,
    height = 200,
    wallThickness = 9,
    innerFilletRadius = null,
    outerFilletRadius = null,
  } = params;

  return w.createEntity('IFCRECTANGLEHOLLOWPROFILEDEF', [
    '.AREA.', // ProfileType
    'Box', // ProfileName
    position, // Position
    width, // XDim (mm)
    height, // YDim (mm)
    wallThickness, // WallThickness (mm)
    innerFilletRadius, // InnerFilletRadius
    outerFilletRadius, // OuterFilletRadius
  ]);
}

/**
 * 円形鋼管（PIPE）プロファイルを作成
 * @param {Object} w - StepWriterインスタンス
 * @param {string|null} position - Position（IFCAXIS2PLACEMENT2D参照）
 * @param {Object} params - プロファイルパラメータ
 * @param {number} params.diameter - 外径 (mm)
 * @param {number} params.wallThickness - 板厚 (mm)
 * @returns {number} プロファイルエンティティID
 */
export function createCircularHollowProfileEntity(w, position, params) {
  const { diameter = 200, wallThickness = 6 } = params;

  return w.createEntity('IFCCIRCLEHOLLOWPROFILEDEF', [
    '.AREA.', // ProfileType
    'Pipe', // ProfileName
    position, // Position
    diameter / 2, // Radius (mm)
    wallThickness, // WallThickness (mm)
  ]);
}

/**
 * 中実円（丸鋼）プロファイルを作成
 * @param {Object} w - StepWriterインスタンス
 * @param {string|null} position - Position（IFCAXIS2PLACEMENT2D参照）
 * @param {Object} params - プロファイルパラメータ
 * @param {number} params.diameter - 直径 (mm)
 * @returns {number} プロファイルエンティティID
 */
export function createCircleProfileEntity(w, position, params) {
  const { diameter = 60 } = params;

  return w.createEntity('IFCCIRCLEPROFILEDEF', [
    '.AREA.', // ProfileType
    'Circle', // ProfileName
    position, // Position
    diameter / 2, // Radius (mm)
  ]);
}

/**
 * L形鋼プロファイルを作成
 * @param {Object} w - StepWriterインスタンス
 * @param {string|null} position - Position（IFCAXIS2PLACEMENT2D参照）
 * @param {Object} params - プロファイルパラメータ
 * @param {number} params.depth - 長辺 (mm)
 * @param {number} params.width - 短辺 (mm)
 * @param {number} params.thickness - 板厚 (mm)
 * @param {number} [params.filletRadius=0] - フィレット半径 (mm)
 * @returns {number} プロファイルエンティティID
 */
export function createLShapeProfileEntity(w, position, params) {
  const { depth = 75, width = 75, thickness = 6, filletRadius = 0 } = params;

  return w.createEntity('IFCLSHAPEPROFILEDEF', [
    '.AREA.', // ProfileType
    'L-Shape', // ProfileName
    position, // Position
    depth, // Depth (mm)
    width, // Width (mm)
    thickness, // Thickness (mm)
    filletRadius > 0 ? filletRadius : null, // FilletRadius (mm)
    null, // EdgeRadius
    null, // LegSlope (傾斜角度)
  ]);
}

/**
 * U形鋼（C形鋼・チャンネル）プロファイル作成
 * @param {Object} w - StepWriterインスタンス
 * @param {string|null} position - Position（IFCAXIS2PLACEMENT2D参照）
 * @param {Object} params - プロファイルパラメータ
 * @param {number} [params.depth=200] - 高さ（ウェブ長さ）(mm)
 * @param {number} [params.flangeWidth=80] - フランジ幅 (mm)
 * @param {number} [params.webThickness=7.5] - ウェブ厚 (mm)
 * @param {number} [params.flangeThickness=11] - フランジ厚 (mm)
 * @param {number} [params.filletRadius=0] - フィレット半径 (mm)
 * @returns {number} プロファイルエンティティID
 */
export function createUShapeProfileEntity(w, position, params) {
  const {
    depth = 200,
    flangeWidth = 80,
    webThickness = 7.5,
    flangeThickness = 11,
    filletRadius = 0,
  } = params;

  return w.createEntity('IFCUSHAPEPROFILEDEF', [
    '.AREA.', // ProfileType
    'U-Shape', // ProfileName
    position, // Position
    depth, // Depth (mm)
    flangeWidth, // FlangeWidth (mm)
    webThickness, // WebThickness (mm)
    flangeThickness, // FlangeThickness (mm)
    filletRadius > 0 ? filletRadius : null, // FilletRadius (mm)
    null, // EdgeRadius
    null, // FlangeSlope
  ]);
}

/**
 * T形鋼プロファイルを作成
 * @param {Object} w - StepWriterインスタンス
 * @param {string|null} position - Position（IFCAXIS2PLACEMENT2D参照）
 * @param {Object} params - プロファイルパラメータ
 * @param {number} [params.depth=200] - ウェブ高さ (mm)
 * @param {number} [params.flangeWidth=150] - フランジ幅 (mm)
 * @param {number} [params.webThickness=8] - ウェブ厚 (mm)
 * @param {number} [params.flangeThickness=12] - フランジ厚 (mm)
 * @param {number} [params.filletRadius=0] - フィレット半径 (mm)
 * @returns {number} プロファイルエンティティID
 */
export function createTShapeProfileEntity(w, position, params) {
  const {
    depth = 200,
    flangeWidth = 150,
    webThickness = 8,
    flangeThickness = 12,
    filletRadius = 0,
  } = params;

  return w.createEntity('IFCTSHAPEPROFILEDEF', [
    '.AREA.', // ProfileType
    'T-Shape', // ProfileName
    position, // Position
    depth, // Depth (ウェブ高さ) (mm)
    flangeWidth, // FlangeWidth (mm)
    webThickness, // WebThickness (mm)
    flangeThickness, // FlangeThickness (mm)
    filletRadius > 0 ? filletRadius : null, // FilletRadius (mm)
    null, // FlangeEdgeRadius
    null, // WebEdgeRadius
    null, // WebSlope
  ]);
}
