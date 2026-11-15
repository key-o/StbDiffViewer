/**
 * SRC 3Dメッシュと2D断面リストが共有する内蔵鉄骨の配置記述。
 * 幾何形状は別途同一 createSectionProfile で生成する。
 */
import {
  toFiniteNumber, resolveHDimensions, resolveSteelDimsByName,
} from './ProfileSectionResolvers.js';

/**
 * 3D createCrossHSteelMeshes と2D一覧で使用する2本のH形鋼の位置。
 * @returns {Array<{arm:string,shapeName:string,dimensions:object,profileType:string,angle:number,x:number,y:number}>}
 */
export function describeCrossHSteelComponents(crossDimensions, steelSections) {
  if (!crossDimensions?.crossH_shapeX) return [];
  const shapeX = crossDimensions.crossH_shapeX;
  const shapeY = crossDimensions.crossH_shapeY || shapeX;
  const fallbackX = {
    H: crossDimensions.overallDepthX || crossDimensions.H_x || crossDimensions.H,
    B: crossDimensions.overallWidthX || crossDimensions.B_x || crossDimensions.B,
  };
  const fallbackY = {
    H: crossDimensions.overallDepthY || crossDimensions.H_y || fallbackX.H,
    B: crossDimensions.overallWidthY || crossDimensions.B_y || fallbackX.B,
  };
  const dimsX = resolveHDimensions(shapeX, steelSections, fallbackX);
  const dimsY = resolveHDimensions(shapeY, steelSections, { ...dimsX, ...fallbackY });
  return [
    { arm: 'X', shapeName: shapeX, dimensions: dimsX, profileType: 'H', angle: 0, x: 0, y: 0 },
    { arm: 'Y', shapeName: shapeY, dimensions: dimsY, profileType: 'H', angle: Math.PI / 2, x: 0, y: 0 },
  ];
}

/**
 * STBのT1〜T4ごとの回転・配置。3Dのメッシュ生成で使う同じ座標値を返す。
 * H: 図心が offset_HX/HY、T: 自由端をHのウェブ中心線に接続する。
 */
export function describeShapeTSteelComponents(shapeTDimensions, steelSections) {
  const dims = shapeTDimensions || {};
  const shapeH = dims.shapeT_shapeH;
  const shapeT = dims.shapeT_shapeT;
  if (!shapeH || !shapeT) return [];
  const direction = String(dims.shapeT_direction || 'T1').toUpperCase();
  const offsetHX = toFiniteNumber(dims.shapeT_offsetHX, 0);
  const offsetHY = toFiniteNumber(dims.shapeT_offsetHY, 0);
  const offsetT = toFiniteNumber(dims.shapeT_offsetT, 0);
  const hDims = resolveHDimensions(shapeH, steelSections);
  const tDims = resolveSteelDimsByName(shapeT, steelSections);
  const halfT = toFiniteNumber(tDims.overall_depth ?? tDims.H ?? tDims.height ?? tDims.A, 350) / 2;
  const directions = {
    T1: { hAngle: Math.PI / 2, tAngle: 0, x: offsetHX + offsetT, y: offsetHY - halfT },
    T3: { hAngle: Math.PI / 2, tAngle: Math.PI, x: offsetHX + offsetT, y: offsetHY + halfT },
    T2: { hAngle: 0, tAngle: -Math.PI / 2, x: offsetHX - halfT, y: offsetHY + offsetT },
    T4: { hAngle: 0, tAngle: Math.PI / 2, x: offsetHX + halfT, y: offsetHY + offsetT },
  };
  const cfg = directions[direction] || directions.T1;
  return [
    { arm: 'H', shapeName: shapeH, dimensions: hDims, profileType: 'H', angle: cfg.hAngle, x: offsetHX, y: offsetHY },
    { arm: 'T', shapeName: shapeT, dimensions: tDims, profileType: 'T', angle: cfg.tAngle, x: cfg.x, y: cfg.y },
  ];
}
