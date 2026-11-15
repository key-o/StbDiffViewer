/**
 * @fileoverview IFCプロファイル → STB断面パラメータの逆マッピング
 *
 * profileExtractor.js の mapToIFCProfileType の逆方向。
 * IFC標準プロファイル定義からSTB断面パラメータを復元する。
 *
 * @module IfcProfileToStbSection
 */

import * as WebIFC from 'web-ifc';

/** Unknown radii stay absent; explicit IFC fillet/edge radii retain their values. */
function readCornerRadii(profile) {
  return {
    ...(profile.FilletRadius == null ? {} : { r1: val(profile.FilletRadius) }),
    ...(profile.EdgeRadius == null ? {} : { r2: val(profile.EdgeRadius) }),
  };
}

/**
 * IFCプロファイルエンティティからSTB断面情報を抽出
 * @param {Object} api - web-ifc IfcAPI
 * @param {number} modelID
 * @param {Object} profileEntity - web-ifc GetLine で取得したプロファイルエンティティ
 * @param {Object} [context] - element metadata used as Revit fallback hints
 * @returns {{stbType: string, params: Object, name: string} | null}
 */
export function extractStbSectionFromProfile(api, modelID, profileEntity, context = {}) {
  if (!profileEntity) return null;

  const profileName = profileEntity.ProfileName?.value || '';
  const type = profileEntity.type;

  switch (type) {
    case WebIFC.IFCISHAPEPROFILEDEF:
      return {
        stbType: 'H',
        params: {
          A: val(profileEntity.OverallDepth),
          B: val(profileEntity.OverallWidth),
          t1: val(profileEntity.WebThickness),
          t2: val(profileEntity.FlangeThickness),
          r: val(profileEntity.FilletRadius, 0),
        },
        name:
          profileName ||
          formatName('H', [
            val(profileEntity.OverallDepth),
            val(profileEntity.OverallWidth),
            val(profileEntity.WebThickness),
            val(profileEntity.FlangeThickness),
          ]),
      };

    case WebIFC.IFCRECTANGLEHOLLOWPROFILEDEF:
      return {
        stbType: 'BOX',
        params: {
          A: val(profileEntity.YDim),
          B: val(profileEntity.XDim),
          t: val(profileEntity.WallThickness),
          r: val(profileEntity.OuterFilletRadius, 0),
        },
        name:
          profileName ||
          formatName('BOX', [
            val(profileEntity.YDim),
            val(profileEntity.XDim),
            val(profileEntity.WallThickness),
          ]),
      };

    case WebIFC.IFCCIRCLEHOLLOWPROFILEDEF:
      return {
        stbType: 'PIPE',
        params: {
          D: val(profileEntity.Radius) * 2,
          t: val(profileEntity.WallThickness),
        },
        name:
          profileName ||
          formatName('PIPE', [val(profileEntity.Radius) * 2, val(profileEntity.WallThickness)]),
      };

    case WebIFC.IFCLSHAPEPROFILEDEF:
      return {
        stbType: 'L',
        params: {
          A: val(profileEntity.Depth),
          B: val(profileEntity.Width),
          t1: val(profileEntity.Thickness),
          t2: val(profileEntity.Thickness),
          ...readCornerRadii(profileEntity),
        },
        name:
          profileName ||
          formatName('L', [
            val(profileEntity.Depth),
            val(profileEntity.Width),
            val(profileEntity.Thickness),
          ]),
      };

    case WebIFC.IFCTSHAPEPROFILEDEF:
      return {
        stbType: 'T',
        params: {
          A: val(profileEntity.Depth),
          B: val(profileEntity.FlangeWidth),
          t1: val(profileEntity.WebThickness),
          t2: val(profileEntity.FlangeThickness),
          ...(profileEntity.FilletRadius == null ? {} : { r: val(profileEntity.FilletRadius) }),
        },
        name:
          profileName ||
          formatName('T', [
            val(profileEntity.Depth),
            val(profileEntity.FlangeWidth),
            val(profileEntity.WebThickness),
            val(profileEntity.FlangeThickness),
          ]),
      };

    case WebIFC.IFCUSHAPEPROFILEDEF:
      return {
        stbType: 'C',
        params: {
          A: val(profileEntity.Depth),
          B: val(profileEntity.FlangeWidth),
          t1: val(profileEntity.WebThickness),
          t2: val(profileEntity.FlangeThickness),
          ...readCornerRadii(profileEntity),
        },
        name:
          profileName ||
          formatName('C', [
            val(profileEntity.Depth),
            val(profileEntity.FlangeWidth),
            val(profileEntity.WebThickness),
            val(profileEntity.FlangeThickness),
          ]),
      };

    case WebIFC.IFCRECTANGLEPROFILEDEF:
      return {
        stbType: 'RECTANGLE',
        params: {
          width_X: val(profileEntity.XDim),
          width_Y: val(profileEntity.YDim),
        },
        name: profileName || formatName('RECT', [val(profileEntity.XDim), val(profileEntity.YDim)]),
      };

    case WebIFC.IFCCIRCLEPROFILEDEF:
      return {
        stbType: 'CIRCLE',
        params: {
          D: val(profileEntity.Radius) * 2,
        },
        name: profileName || formatName('CIRCLE', [val(profileEntity.Radius) * 2]),
      };

    case WebIFC.IFCARBITRARYPROFILEDEFWITHVOIDS:
      return extractArbitraryProfile(api, modelID, profileEntity, context, true);

    case WebIFC.IFCARBITRARYCLOSEDPROFILEDEF:
    case WebIFC.IFCARBITRARYOPENPROFILEDEF:
      return extractArbitraryProfile(api, modelID, profileEntity, context, false);

    default:
      return null;
  }
}

/**
 * STB断面パラメータから正規化キーを生成（重複排除用）
 * @param {string} stbType
 * @param {Object} params
 * @returns {string} 例: "H_400_200_8_13"
 */
export function buildSectionKey(stbType, params) {
  const values = Object.values(params)
    .map((v) => Math.round(v * 10) / 10)
    .join('_');
  return `${stbType}_${values}`;
}

/**
 * STB断面タイプに対応するXML要素名を返す
 * @param {string} stbType - H, BOX, PIPE, etc.
 * @returns {string} XML要素名 (例: "StbSecRoll-H")
 */
export function getStbSecSteelTagName(stbType) {
  const map = {
    H: 'StbSecRoll-H',
    BOX: 'StbSecRoll-BOX',
    PIPE: 'StbSecRoll-PIPE',
    L: 'StbSecRoll-L',
    T: 'StbSecRoll-T',
    C: 'StbSecRoll-C',
    FB: 'StbSecRoll-FB',
    CIRCLE: 'StbSecRoll-Bar',
  };
  return map[stbType] || `StbSecRoll-${stbType}`;
}

/** web-ifcの値オブジェクトから数値を取得 */
function val(ref, fallback = 0) {
  if (ref === null || ref === undefined) return fallback;
  if (typeof ref === 'number') return ref;
  return ref.value ?? fallback;
}

/** 断面名をフォーマット */
function formatName(prefix, dims) {
  return `${prefix}-${dims.join('x')}`;
}

function extractArbitraryProfile(api, modelID, profileEntity, context, hasVoids) {
  const profileName = profileEntity.ProfileName?.value || '';
  const hint = inferSectionHint(profileName, context);
  const outerPoints = getCurvePoints2D(api, modelID, profileEntity.OuterCurve);
  const outerBox = getBoundingBox2D(outerPoints);
  if (!outerBox) return null;

  const width = outerBox.width;
  const height = outerBox.height;
  const name = profileName || formatName(hint || 'ARBITRARY', [width, height]);

  if (hasVoids) {
    const innerBoxes = (profileEntity.InnerCurves || [])
      .map((curveRef) => getBoundingBox2D(getCurvePoints2D(api, modelID, curveRef)))
      .filter(Boolean);
    const largestInner = innerBoxes.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const thickness = largestInner
      ? Math.max(0, Math.min((width - largestInner.width) / 2, (height - largestInner.height) / 2))
      : 0;

    if (hint === 'PIPE') {
      return {
        stbType: 'PIPE',
        params: { D: Math.max(width, height), t: thickness },
        name,
      };
    }

    return {
      stbType: 'BOX',
      params: {
        A: height,
        B: width,
        t: thickness,
        r: 0,
      },
      name,
    };
  }

  if (hint === 'BOX') {
    const thickness = estimateProfileThickness(outerPoints, outerBox);
    return {
      stbType: 'BOX',
      params: { A: height, B: width, t: thickness, r: 0 },
      name,
    };
  }

  if (hint === 'C') {
    const thickness = estimateProfileThickness(outerPoints, outerBox);
    return {
      stbType: 'C',
      params: { A: height, B: width, t1: thickness, t2: thickness },
      name,
    };
  }

  if (hint === 'L') {
    const thickness = estimateProfileThickness(outerPoints, outerBox);
    return {
      stbType: 'L',
      params: { A: height, B: width, t1: thickness, t2: thickness },
      name,
    };
  }

  if (hint === 'T') {
    const thickness = estimateProfileThickness(outerPoints, outerBox);
    return {
      stbType: 'T',
      params: { A: height, B: width, t1: thickness, t2: thickness },
      name,
    };
  }

  if (hint === 'FB') {
    return {
      stbType: 'FB',
      params: { B: Math.max(width, height), t: Math.min(width, height) },
      name,
    };
  }

  if (hint === 'CIRCLE') {
    return {
      stbType: 'CIRCLE',
      params: { D: Math.max(width, height) },
      name,
    };
  }

  return {
    stbType: 'RECTANGLE',
    params: {
      width_X: width,
      width_Y: height,
    },
    name,
  };
}

function inferSectionHint(profileName, context = {}) {
  const texts = [
    profileName,
    context.sectionHint,
    context.typeName,
    context.typeSignature,
    context.objectType,
    context.name,
  ]
    .filter(Boolean)
    .map((value) => String(value).toUpperCase());

  for (const text of texts) {
    if (text === 'BOX' || /BOX|角形|□/.test(text)) return 'BOX';
    if (text === 'PIPE' || /PIPE|鋼管/.test(text)) return 'PIPE';
    if (text === 'FB' || tokenMatch(text, 'FB')) return 'FB';
    if (text === 'RECTANGLE' || tokenMatch(text, 'B') || tokenMatch(text, 'RECT'))
      return 'RECTANGLE';
    if (text === 'CIRCLE' || tokenMatch(text, 'RB') || tokenMatch(text, 'CIRCLE')) return 'CIRCLE';
    if (text === 'C' || tokenMatch(text, 'C') || tokenMatch(text, 'U')) return 'C';
    if (text === 'L' || tokenMatch(text, 'L')) return 'L';
    if (text === 'T' || tokenMatch(text, 'T')) return 'T';
  }

  return null;
}

function tokenMatch(text, token) {
  const tokens = text.split(/[:_\-\s]+/).filter(Boolean);
  const firstToken = tokens[0];
  const isRevitType = ['S', 'RC', 'SRC', 'CFT'].includes(firstToken) && tokens.length >= 3;
  if (isRevitType) return tokens[2] === token;
  return tokens.includes(token);
}

function getCurvePoints2D(api, modelID, curveRef) {
  const curveId = curveRef?.value ?? curveRef;
  if (!curveId) return [];

  const curve = api.GetLine(modelID, curveId);
  if (!curve) return [];

  if (curve.type === WebIFC.IFCPOLYLINE) {
    return (curve.Points || [])
      .map((pointRef) => getCartesianPoint2D(api, modelID, pointRef))
      .filter(Boolean);
  }

  if (curve.type === WebIFC.IFCINDEXEDPOLYCURVE) {
    const pointListId = curve.Points?.value ?? curve.Points;
    const pointList = pointListId ? api.GetLine(modelID, pointListId) : null;
    return (pointList?.CoordList || [])
      .map((coords) => ({
        x: coords[0]?.value ?? coords[0] ?? 0,
        y: coords[1]?.value ?? coords[1] ?? 0,
      }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  }

  if (curve.type === WebIFC.IFCCOMPOSITECURVE) {
    const points = [];
    for (const segmentRef of curve.Segments || []) {
      const segmentId = segmentRef?.value ?? segmentRef;
      const segment = segmentId ? api.GetLine(modelID, segmentId) : null;
      points.push(...getCurvePoints2D(api, modelID, segment?.ParentCurve));
    }
    return points;
  }

  return [];
}

function getCartesianPoint2D(api, modelID, pointRef) {
  const pointId = pointRef?.value ?? pointRef;
  if (!pointId) return null;
  const point = api.GetLine(modelID, pointId);
  const coords = point?.Coordinates;
  if (!coords) return null;
  return {
    x: coords[0]?.value ?? coords[0] ?? 0,
    y: coords[1]?.value ?? coords[1] ?? 0,
  };
}

function getBoundingBox2D(points) {
  if (!points || points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function estimateProfileThickness(points, box) {
  const candidateSteps = [
    ...positiveSteps(points.map((point) => point.x)),
    ...positiveSteps(points.map((point) => point.y)),
  ].filter((step) => step <= Math.max(box.width, box.height) * 0.5);

  if (candidateSteps.length > 0) return Math.min(...candidateSteps);
  return Math.min(box.width, box.height) * 0.1;
}

function positiveSteps(values) {
  const sorted = [...new Set(values.map((value) => Math.round(value * 1e9) / 1e9))]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const steps = [];
  for (let i = 1; i < sorted.length; i++) {
    const step = sorted[i] - sorted[i - 1];
    if (step > 1e-9) steps.push(step);
  }
  return steps;
}
