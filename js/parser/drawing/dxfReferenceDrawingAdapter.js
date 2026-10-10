/**
 * @fileoverview DXFをSTB非依存のReferenceDrawingへ正規化するadapter。
 *
 * 対応対象は2D model space。単位をmmへ正規化し、DXF entityの出典を保持する。
 * INSERT/BLOCKはbase point・回転・鏡像を含めて展開するが、非一様変換で円弧性が失われる
 * 図形は無言で近似せずunsupported診断にする。
 */
import { multiplyAffine, transformPoint } from '../../data/drawing/affine2d.js';
import {
  REFERENCE_DRAWING_SCHEMA_VERSION,
  assertReferenceDrawing,
  createDxfEntitySourceRef,
  createReferenceDrawingSource,
  referenceSourceRefKey,
} from '../../data/drawing/referenceDrawing.js';
import { parseDxf } from '../dxfParser.js';
import { dxfUnsupportedEntityHandlers } from './dxfUnsupportedEntityHandlers.js';

export const DXF_REFERENCE_IMPORT_PROFILE_ID = 'sdv-dxf-reference-v1';
export const DXF_REFERENCE_IMPORT_ADAPTER_VERSION = 1;
export const DXF_REFERENCE_ASSET_SCHEMA_VERSION = 1;

const DEFAULT_LIMITS = Object.freeze({
  maxSourceEntities: 100000,
  maxExpandedEntities: 200000,
  maxBlockDepth: 16,
});

const UNIT_BY_CODE = Object.freeze({
  1: Object.freeze({ name: 'inch', scaleToMm: 25.4 }),
  2: Object.freeze({ name: 'foot', scaleToMm: 304.8 }),
  3: Object.freeze({ name: 'mile', scaleToMm: 1609344 }),
  4: Object.freeze({ name: 'mm', scaleToMm: 1 }),
  5: Object.freeze({ name: 'cm', scaleToMm: 10 }),
  6: Object.freeze({ name: 'm', scaleToMm: 1000 }),
  7: Object.freeze({ name: 'km', scaleToMm: 1000000 }),
  8: Object.freeze({ name: 'microinch', scaleToMm: 0.0000254 }),
  9: Object.freeze({ name: 'mil', scaleToMm: 0.0254 }),
  10: Object.freeze({ name: 'yard', scaleToMm: 914.4 }),
  11: Object.freeze({ name: 'angstrom', scaleToMm: 1e-7 }),
  12: Object.freeze({ name: 'nanometer', scaleToMm: 1e-6 }),
  13: Object.freeze({ name: 'micron', scaleToMm: 0.001 }),
  14: Object.freeze({ name: 'dm', scaleToMm: 100 }),
  15: Object.freeze({ name: 'dam', scaleToMm: 10000 }),
  16: Object.freeze({ name: 'hm', scaleToMm: 100000 }),
  17: Object.freeze({ name: 'gigameter', scaleToMm: 1e12 }),
  18: Object.freeze({ name: 'astronomical-unit', scaleToMm: 149597870700000 }),
  19: Object.freeze({ name: 'light-year', scaleToMm: 9.4607304725808e18 }),
  20: Object.freeze({ name: 'parsec', scaleToMm: 3.08567758149137e19 }),
  21: Object.freeze({ name: 'us-survey-foot', scaleToMm: (1200 / 3937) * 1000 }),
  22: Object.freeze({ name: 'us-survey-inch', scaleToMm: (100 / 3937) * 1000 }),
  23: Object.freeze({ name: 'us-survey-yard', scaleToMm: (3600 / 3937) * 1000 }),
  24: Object.freeze({ name: 'us-survey-mile', scaleToMm: (6336000 / 3937) * 1000 }),
});

const UNIT_ALIASES = Object.freeze({
  mm: 4,
  millimeter: 4,
  millimeters: 4,
  cm: 5,
  centimeter: 5,
  centimeters: 5,
  m: 6,
  meter: 6,
  meters: 6,
  in: 1,
  inch: 1,
  inches: 1,
  ft: 2,
  foot: 2,
  feet: 2,
});

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label}が不正です。`);
  return number;
}

function positive(value, label, fallback) {
  const number = value == null ? fallback : finite(value, label);
  if (number <= 0) throw new RangeError(`${label}は0より大きい値が必要です。`);
  return number;
}

function requiredString(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new TypeError(`${label}が必要です。`);
  return normalized;
}

function translation(tx, ty) {
  return [1, 0, 0, 1, finite(tx, 'X移動量'), finite(ty, 'Y移動量')];
}

function rotation(degrees) {
  const radians = (finite(degrees, '回転角') * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos, sin, -sin, cos, 0, 0];
}

function scaling(sx, sy) {
  return [finite(sx, 'X倍率'), 0, 0, finite(sy, 'Y倍率'), 0, 0];
}

function sourceToModelMatrix(scaleToMm, placement = {}) {
  const origin = placement.originMm ?? [0, 0];
  if (!Array.isArray(origin) || origin.length !== 2 || !origin.every(Number.isFinite))
    throw new TypeError('DXF配置原点にはmmの有限座標2個が必要です。');
  const rotationDeg = finite(placement.rotationDeg ?? 0, 'DXF配置回転角');
  return multiplyAffine(
    translation(origin[0], origin[1]),
    multiplyAffine(rotation(rotationDeg), scaling(scaleToMm, scaleToMm)),
  );
}

function resolveUnits(dxf, unitOverride) {
  let code = null;
  let resolution = null;
  if (unitOverride != null && String(unitOverride).trim() !== '') {
    if (Number.isInteger(Number(unitOverride)) && UNIT_BY_CODE[Number(unitOverride)]) {
      code = Number(unitOverride);
    } else {
      code = UNIT_ALIASES[String(unitOverride).trim().toLowerCase()] ?? null;
    }
    if (!code || !UNIT_BY_CODE[code])
      throw new RangeError(`未対応のDXF単位指定です: ${unitOverride}`);
    resolution = 'override';
  } else {
    const headerCode = Number(dxf?.header?.['$INSUNITS']);
    if (Number.isInteger(headerCode) && headerCode > 0 && UNIT_BY_CODE[headerCode]) {
      code = headerCode;
      resolution = 'header';
    } else {
      const sdvUnit = String(dxf?.__sdvUnits || '')
        .trim()
        .toLowerCase();
      const sdvCode = UNIT_ALIASES[sdvUnit] ?? null;
      if (sdvCode && UNIT_BY_CODE[sdvCode]) {
        code = sdvCode;
        resolution = 'sdv-profile';
      }
    }
  }
  if (!code) {
    // 実務CADでは$INSUNITS未設定の2D DXFも多いため、参照図面取込ではmmを既定とする。
    // unitOverrideが明示された場合は常にそちらを優先し、既定採用はunitResolutionに残す。
    code = 4;
    resolution = 'default-mm';
  }
  return Object.freeze({ code, resolution, ...UNIT_BY_CODE[code] });
}

function normalizeLimits(limits = {}) {
  return Object.freeze({
    maxSourceEntities: Math.floor(
      positive(limits.maxSourceEntities, 'maxSourceEntities', DEFAULT_LIMITS.maxSourceEntities),
    ),
    maxExpandedEntities: Math.floor(
      positive(
        limits.maxExpandedEntities,
        'maxExpandedEntities',
        DEFAULT_LIMITS.maxExpandedEntities,
      ),
    ),
    maxBlockDepth: Math.floor(
      positive(limits.maxBlockDepth, 'maxBlockDepth', DEFAULT_LIMITS.maxBlockDepth),
    ),
  });
}

function decodeDxfUnicode(value) {
  return String(value ?? '').replace(/\\U\+([0-9a-fA-F]{4})/g, (_match, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function decodeMtext(value) {
  return decodeDxfUnicode(value).replace(/\\P/gi, '\n').replace(/\\~/g, ' ');
}

function entityHasNonPlanarZ(entity) {
  const points = [
    ...(entity?.vertices || []),
    entity?.center,
    entity?.position,
    entity?.startPoint,
    entity?.endPoint,
  ].filter(Boolean);
  if (points.some((point) => Number.isFinite(point.z) && Math.abs(point.z) > 1e-9)) return true;
  if (Number.isFinite(entity?.elevation) && Math.abs(entity.elevation) > 1e-9) return true;
  if (Number.isFinite(entity?.depth) && Math.abs(entity.depth) > 1e-9) return true;
  if (Number.isFinite(entity?.thickness) && Math.abs(entity.thickness) > 1e-9) return true;
  return Boolean(
    entity?.is3dPolyline ||
    entity?.is3dPolygonMesh ||
    entity?.isPolyfaceMesh ||
    entity?.is3dPolygonMeshClosed,
  );
}

function extrusionIsDefault(entity) {
  const extrusion = entity?.extrusionDirection;
  const hasSplitExtrusion =
    entity?.extrusionDirectionX != null ||
    entity?.extrusionDirectionY != null ||
    entity?.extrusionDirectionZ != null;
  if (!extrusion && !hasSplitExtrusion) return true;
  const x = Number(extrusion?.x ?? entity?.extrusionDirectionX ?? 0);
  const y = Number(extrusion?.y ?? entity?.extrusionDirectionY ?? 0);
  const z = Number(extrusion?.z ?? entity?.extrusionDirectionZ ?? 1);
  return Math.abs(x) <= 1e-12 && Math.abs(y) <= 1e-12 && Math.abs(z - 1) <= 1e-12;
}

function matrixInfo(matrix) {
  const [a, b, c, d] = matrix;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  const det = a * d - b * c;
  const dot = a * c + b * d;
  const tolerance = Math.max(sx, sy, 1) * 1e-10;
  return Object.freeze({
    sx,
    sy,
    det,
    orthogonal: Math.abs(dot) <= tolerance * Math.max(sx, sy, 1),
    uniform: Math.abs(sx - sy) <= tolerance,
    reflected: det < 0,
  });
}

function transformVector(matrix, vector) {
  return [
    matrix[0] * vector[0] + matrix[2] * vector[1],
    matrix[1] * vector[0] + matrix[3] * vector[1],
  ];
}

function angleDegFromVector(vector) {
  return (Math.atan2(vector[1], vector[0]) * 180) / Math.PI;
}

function entityIdentifier(entity, fallbackPath) {
  const handle = entity?.handle;
  if (handle != null && String(handle) !== '' && String(handle) !== '0') {
    return { entityId: `handle:${String(handle)}`, handle: String(handle) };
  }
  return { entityId: `path:${fallbackPath}`, handle: null };
}

function sourceRefFor(context, entity, entityPath, effectiveLayer) {
  const identity = entityIdentifier(entity, entityPath);
  return createDxfEntitySourceRef(context.source, {
    entityType: entity?.type || 'UNKNOWN',
    ...identity,
    layer: effectiveLayer,
    blockOccurrence: context.blockOccurrence,
    blockName: context.blockName,
  });
}

function effectiveLayerFor(entity, context) {
  const own = String(entity?.layer || '0');
  if (own === '0' && context.inheritedLayer) return context.inheritedLayer;
  return own;
}

function layerColor(dxf, layerName) {
  const layer = dxf?.tables?.layer?.layers?.[layerName];
  return Number.isFinite(layer?.color) ? layer.color : null;
}

function layerLineType(dxf, layerName) {
  const value = dxf?.__layerLineTypes?.[layerName];
  return typeof value === 'string' && value.trim() ? value.trim() : 'CONTINUOUS';
}

function effectiveLineType(entity, dxf, layerName, context) {
  const raw = typeof entity?.lineType === 'string' ? entity.lineType.trim() : '';
  const upper = raw.toUpperCase();
  if (upper === 'BYBLOCK') return context?.inheritedLineType || layerLineType(dxf, layerName);
  if (!raw || upper === 'BYLAYER') return layerLineType(dxf, layerName);
  return raw;
}

function entityLineTypePatternMm(entity, dxf, context, lineType) {
  if (!lineType || lineType.toUpperCase() === 'CONTINUOUS') return null;
  const definition = dxf?.tables?.lineType?.lineTypes?.[lineType];
  const sourcePattern = definition?.pattern;
  if (!Array.isArray(sourcePattern) || sourcePattern.length === 0) return null;

  const entityScaleRaw = Number(entity?.lineTypeScale);
  const entityScale = Number.isFinite(entityScaleRaw) && entityScaleRaw > 0 ? entityScaleRaw : 1;
  const globalScaleRaw = Number(dxf?.header?.['$LTSCALE']);
  const globalScale = Number.isFinite(globalScaleRaw) && globalScaleRaw > 0 ? globalScaleRaw : 1;
  const unitScale = Number(context?.sourceScaleToMm);
  if (!(unitScale > 0)) return null;

  const numericPattern = sourcePattern.map((value) => Number(value));
  if (!numericPattern.every((value) => Number.isFinite(value) && Math.abs(value) > 1e-12))
    return null;
  if (numericPattern.some((value, index) => (index % 2 === 0 ? value <= 0 : value >= 0)))
    return null;
  const scale = entityScale * globalScale * unitScale;
  return Object.freeze(numericPattern.map((value) => Math.abs(value) * scale));
}

function entityStyle(entity, dxf, layerName, context) {
  const colorIndex = Number(entity?.colorIndex);
  const lineType = effectiveLineType(entity, dxf, layerName, context);
  let color;
  if (Number.isFinite(colorIndex) && colorIndex === 0) {
    // DXF 0 = BYBLOCK。INSERT自身から継承できない場合は最終的にlayerへ戻す。
    color = Number.isFinite(context.inheritedColorRgb)
      ? context.inheritedColorRgb
      : layerColor(dxf, layerName);
  } else if (!Number.isFinite(colorIndex) || colorIndex === 256) {
    // DXF 256 / 未指定 = BYLAYER。
    color = layerColor(dxf, layerName);
  } else {
    // dxf-parserのentity.colorはACIを既にRGBへ変換した値。
    color = Number.isFinite(entity?.color) ? entity.color : layerColor(dxf, layerName);
  }
  return Object.freeze({
    colorRgb: Number.isFinite(color) ? color : null,
    colorSource:
      colorIndex === 0
        ? 'BYBLOCK'
        : !Number.isFinite(colorIndex) || colorIndex === 256
          ? 'BYLAYER'
          : 'ENTITY',
    lineType,
    dashPatternMm: entityLineTypePatternMm(entity, dxf, context, lineType),
  });
}

function layerRecord(dxf, name) {
  const raw = dxf?.tables?.layer?.layers?.[name];
  return Object.freeze({
    id: name,
    sourceName: name,
    visible: raw ? raw.visible !== false && raw.frozen !== true : true,
    frozen: raw?.frozen === true,
    locked: raw?.locked === true,
    colorRgb: Number.isFinite(raw?.color) ? raw.color : null,
    lineType: layerLineType(dxf, name),
  });
}

function makeResult(sourceRef, status, primitiveIds, reason, code = null) {
  return Object.freeze({
    sourceRef,
    status,
    primitiveIds: Object.freeze([...primitiveIds]),
    reason,
    code,
  });
}

function extendBounds(bounds, point) {
  bounds.minX = Math.min(bounds.minX, point[0]);
  bounds.minY = Math.min(bounds.minY, point[1]);
  bounds.maxX = Math.max(bounds.maxX, point[0]);
  bounds.maxY = Math.max(bounds.maxY, point[1]);
}

function primitiveBounds(bounds, primitive) {
  if (primitive.kind === 'line' || primitive.kind === 'polyline') {
    primitive.points.forEach((point) => extendBounds(bounds, point));
  } else if (primitive.kind === 'circle' || primitive.kind === 'arc') {
    extendBounds(bounds, [
      primitive.center[0] - primitive.radius,
      primitive.center[1] - primitive.radius,
    ]);
    extendBounds(bounds, [
      primitive.center[0] + primitive.radius,
      primitive.center[1] + primitive.radius,
    ]);
  } else if (primitive.kind === 'text') {
    extendBounds(bounds, primitive.point);
  }
}

function finalizeBounds(bounds) {
  return [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)
    ? Object.freeze({ ...bounds })
    : null;
}

function blockInsertMatrix(entity, block, arrayOffset = [0, 0]) {
  const position = entity?.position || { x: 0, y: 0 };
  const base = block?.position || { x: 0, y: 0 };
  const sx = finite(entity?.xScale ?? 1, 'INSERT xScale');
  const sy = finite(entity?.yScale ?? 1, 'INSERT yScale');
  if (Math.abs(sx) <= 1e-12 || Math.abs(sy) <= 1e-12)
    throw new RangeError('INSERT scaleに0は指定できません。');
  if (!Array.isArray(arrayOffset) || arrayOffset.length !== 2)
    throw new TypeError('INSERT array offsetには2成分が必要です。');
  const offsetX = finite(arrayOffset[0], 'INSERT column offset');
  const offsetY = finite(arrayOffset[1], 'INSERT row offset');
  const rotate = finite(entity?.rotation ?? 0, 'INSERT rotation');
  return multiplyAffine(
    translation(finite(position.x ?? 0, 'INSERT X'), finite(position.y ?? 0, 'INSERT Y')),
    multiplyAffine(
      rotation(rotate),
      multiplyAffine(
        translation(offsetX, offsetY),
        multiplyAffine(
          scaling(sx, sy),
          translation(-finite(base.x ?? 0, 'BLOCK base X'), -finite(base.y ?? 0, 'BLOCK base Y')),
        ),
      ),
    ),
  );
}

function insertArrayDefinition(entity, context) {
  const columnCount = Number(entity?.columnCount ?? 1);
  const rowCount = Number(entity?.rowCount ?? 1);
  if (!Number.isSafeInteger(columnCount) || columnCount < 1)
    throw new RangeError('INSERT columnCountは1以上の整数が必要です。');
  if (!Number.isSafeInteger(rowCount) || rowCount < 1)
    throw new RangeError('INSERT rowCountは1以上の整数が必要です。');
  const columnSpacing = finite(entity?.columnSpacing ?? 0, 'INSERT columnSpacing');
  const rowSpacing = finite(entity?.rowSpacing ?? 0, 'INSERT rowSpacing');

  // MINSERT spacingはINSERTのOCS上で回転の影響を受けるが、INSERT scaleの影響は受けない。
  // spacing=0の方向は同一位置が重なるため、一意な配置のみ展開する。
  const effectiveColumnCount = Math.abs(columnSpacing) <= 1e-12 ? 1 : columnCount;
  const effectiveRowCount = Math.abs(rowSpacing) <= 1e-12 ? 1 : rowCount;
  const instanceCount = effectiveColumnCount * effectiveRowCount;
  if (!Number.isSafeInteger(instanceCount) || instanceCount > context.limits.maxExpandedEntities) {
    const error = new Error(
      `INSERT配列の一意な配置数が上限${context.limits.maxExpandedEntities}を超えました。`,
    );
    error.code = 'DXF_INSERT_ARRAY_LIMIT_EXCEEDED';
    throw error;
  }
  const maxColumnOffset = (effectiveColumnCount - 1) * columnSpacing;
  const maxRowOffset = (effectiveRowCount - 1) * rowSpacing;
  if (!Number.isFinite(maxColumnOffset) || !Number.isFinite(maxRowOffset)) {
    const error = new RangeError('INSERT配列のspacingから有限な配置座標を生成できません。');
    error.code = 'DXF_INSERT_ARRAY_OFFSET_INVALID';
    throw error;
  }

  return Object.freeze({
    columnCount,
    rowCount,
    columnSpacing,
    rowSpacing,
    effectiveColumnCount,
    effectiveRowCount,
    instanceCount,
    isArray: columnCount > 1 || rowCount > 1,
  });
}

function checkEntity2d(entity, sourceRef, context) {
  if (entity?.inPaperSpace === true || entity?.paperSpace === true) {
    context.entityResults.push(
      makeResult(
        sourceRef,
        'unsupported',
        [],
        '用紙空間entityは初期profileの対象外です。',
        'DXF_PAPER_SPACE_UNSUPPORTED',
      ),
    );
    return false;
  }
  if (entityHasNonPlanarZ(entity) || !extrusionIsDefault(entity)) {
    context.entityResults.push(
      makeResult(
        sourceRef,
        'unsupported',
        [],
        '3D/OCS entityは初期2D profileの対象外です。',
        'DXF_NON_2D_ENTITY_UNSUPPORTED',
      ),
    );
    return false;
  }
  return true;
}

function pushPrimitive(context, primitive) {
  if (context.primitives.length >= context.limits.maxExpandedEntities) {
    const error = new Error(
      `DXF展開図形数が上限${context.limits.maxExpandedEntities}を超えました。`,
    );
    error.code = 'DXF_EXPANSION_LIMIT_EXCEEDED';
    throw error;
  }
  context.primitives.push(Object.freeze(primitive));
  primitiveBounds(context.bounds, primitive);
  return primitive.id;
}

function primitiveId(context, sourceRef, suffix = '0') {
  return `dxf:${context.primitives.length}:${referenceSourceRefKey(sourceRef)}:${suffix}`;
}

function transformEntityPoint(matrix, point, label) {
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y)))
    throw new TypeError(`${label}の座標が不正です。`);
  return Object.freeze(transformPoint(matrix, [Number(point.x), Number(point.y)]));
}

function processLine(entity, sourceRef, matrix, layerId, style, context) {
  if (!Array.isArray(entity.vertices) || entity.vertices.length < 2)
    throw new TypeError('LINEの端点が不足しています。');
  const points = [
    transformEntityPoint(matrix, entity.vertices[0], 'LINE始点'),
    transformEntityPoint(matrix, entity.vertices[1], 'LINE終点'),
  ];
  const id = primitiveId(context, sourceRef);
  pushPrimitive(context, {
    id,
    kind: 'line',
    role: 'reference-geometry',
    layerId,
    sourceRef,
    style,
    points: Object.freeze(points),
  });
  return makeResult(sourceRef, 'supported', [id], 'LINEを正規化しました。');
}

function processPolyline(entity, sourceRef, matrix, layerId, style, context) {
  if (!Array.isArray(entity.vertices) || entity.vertices.length < 2)
    throw new TypeError(`${entity.type}の頂点が不足しています。`);
  const info = matrixInfo(matrix);
  const rawBulges = entity.vertices.map((vertex) => Number(vertex.bulge || 0));
  const hasBulge = rawBulges.some((value) => Math.abs(value) > 1e-12);
  if (hasBulge && (!info.orthogonal || !info.uniform)) {
    return makeResult(
      sourceRef,
      'unsupported',
      [],
      'bulge付きpolylineへ非一様変換を適用すると円弧性を保持できません。',
      'DXF_BULGE_NONUNIFORM_TRANSFORM_UNSUPPORTED',
    );
  }
  const points = entity.vertices.map((vertex, index) =>
    transformEntityPoint(matrix, vertex, `${entity.type}頂点${index}`),
  );
  const bulges = rawBulges.map((value) => (info.reflected ? -value : value));
  const id = primitiveId(context, sourceRef);
  pushPrimitive(context, {
    id,
    kind: 'polyline',
    role: 'reference-geometry',
    layerId,
    sourceRef,
    style,
    points: Object.freeze(points),
    bulges: Object.freeze(bulges),
    closed: entity.shape === true,
  });
  return makeResult(sourceRef, 'supported', [id], `${entity.type}を正規化しました。`);
}

function processCircle(entity, sourceRef, matrix, layerId, style, context) {
  const info = matrixInfo(matrix);
  if (!info.orthogonal || !info.uniform) {
    return makeResult(
      sourceRef,
      'unsupported',
      [],
      'CIRCLEへの非一様変換はELLIPSEとなるため初期profileでは展開しません。',
      'DXF_CIRCLE_NONUNIFORM_TRANSFORM_UNSUPPORTED',
    );
  }
  const radius = positive(entity.radius, 'CIRCLE半径') * info.sx;
  const center = transformEntityPoint(matrix, entity.center, 'CIRCLE中心');
  const id = primitiveId(context, sourceRef);
  pushPrimitive(context, {
    id,
    kind: 'circle',
    role: 'reference-geometry',
    layerId,
    sourceRef,
    style,
    center,
    radius,
  });
  return makeResult(sourceRef, 'supported', [id], 'CIRCLEを正規化しました。');
}

function processArc(entity, sourceRef, matrix, layerId, style, context) {
  const info = matrixInfo(matrix);
  if (!info.orthogonal || !info.uniform) {
    return makeResult(
      sourceRef,
      'unsupported',
      [],
      'ARCへの非一様変換は楕円弧となるため初期profileでは展開しません。',
      'DXF_ARC_NONUNIFORM_TRANSFORM_UNSUPPORTED',
    );
  }
  const radiusSource = positive(entity.radius, 'ARC半径');
  const startAngle = finite(entity.startAngle, 'ARC開始角');
  const endAngle = finite(entity.endAngle, 'ARC終了角');
  const sourceCenter = entity.center;
  const start = {
    x: sourceCenter.x + Math.cos(startAngle) * radiusSource,
    y: sourceCenter.y + Math.sin(startAngle) * radiusSource,
  };
  const end = {
    x: sourceCenter.x + Math.cos(endAngle) * radiusSource,
    y: sourceCenter.y + Math.sin(endAngle) * radiusSource,
  };
  const center = transformEntityPoint(matrix, sourceCenter, 'ARC中心');
  const startPoint = transformEntityPoint(matrix, start, 'ARC始点');
  const endPoint = transformEntityPoint(matrix, end, 'ARC終点');
  const id = primitiveId(context, sourceRef);
  pushPrimitive(context, {
    id,
    kind: 'arc',
    role: 'reference-geometry',
    layerId,
    sourceRef,
    style,
    center,
    radius: radiusSource * info.sx,
    startPoint,
    endPoint,
    clockwise: info.reflected,
  });
  return makeResult(sourceRef, 'supported', [id], 'ARCを正規化しました。');
}

function textAnchor(entity) {
  const halign = Number(entity?.halign ?? 0);
  const valign = Number(entity?.valign ?? 0);
  if ([3, 5].includes(halign)) return null;
  const horizontal = { 0: 'left', 1: 'middle', 2: 'right', 4: 'middle' }[halign] || 'left';
  const vertical = { 0: 'baseline', 1: 'bottom', 2: 'middle', 3: 'top' }[valign] || 'baseline';
  return Object.freeze({ horizontal, vertical });
}

function processText(entity, sourceRef, matrix, layerId, style, context, mtext = false) {
  const info = matrixInfo(matrix);
  if (!info.orthogonal || !info.uniform) {
    return makeResult(
      sourceRef,
      'unsupported',
      [],
      'TEXT/MTEXTへの非一様・せん断変換は初期profileで正確に表現できません。',
      'DXF_TEXT_NONUNIFORM_TRANSFORM_UNSUPPORTED',
    );
  }
  const anchor = mtext
    ? Object.freeze({ horizontal: 'left', vertical: 'top' })
    : textAnchor(entity);
  if (!anchor) {
    return makeResult(
      sourceRef,
      'unsupported',
      [],
      'Aligned/Fit TEXTは初期profileで正確に表現できません。',
      'DXF_TEXT_ALIGNMENT_UNSUPPORTED',
    );
  }
  const useAlignmentPoint =
    !mtext && (Number(entity?.halign ?? 0) !== 0 || Number(entity?.valign ?? 0) !== 0);
  const rawPoint =
    useAlignmentPoint && entity.endPoint ? entity.endPoint : entity.startPoint || entity.position;
  const point = transformEntityPoint(matrix, rawPoint, `${entity.type}配置点`);
  const heightSource = positive(entity.textHeight ?? entity.height, `${entity.type}文字高さ`, 1);
  const sourceRotationDeg = finite(entity.rotation ?? 0, `${entity.type}回転角`);
  const sourceDirection = [
    Math.cos((sourceRotationDeg * Math.PI) / 180),
    Math.sin((sourceRotationDeg * Math.PI) / 180),
  ];
  const transformedDirection = transformVector(matrix, sourceDirection);

  const rawWidthFactor = mtext ? 1 : Number(entity?.xScale ?? 1);
  const widthFactor = Number.isFinite(rawWidthFactor) && rawWidthFactor > 0 ? rawWidthFactor : 1;
  const rawGenerationFlags = mtext
    ? 0
    : Number(entity?.__textGenerationFlags ?? entity?.textGenerationFlags ?? 0);
  const generationFlags =
    Number.isInteger(rawGenerationFlags) && rawGenerationFlags >= 0 ? rawGenerationFlags : 0;
  const sourceMirrorX = !mtext && (generationFlags & 2) !== 0;
  const sourceMirrorY = !mtext && (generationFlags & 4) !== 0;
  // uniformな親変換の反射は、基準X方向を維持した分解ではlocal Y mirrorとして表せる。
  const mirrorX = sourceMirrorX;
  const mirrorY = sourceMirrorY !== info.reflected;
  const rawObliqueDeg = mtext
    ? 0
    : Number(entity?.__textObliqueDeg ?? entity?.obliqueAngle ?? entity?.obliqueDeg ?? 0);
  const obliqueDeg = Number.isFinite(rawObliqueDeg) ? rawObliqueDeg : 0;
  const unknownGenerationFlags = generationFlags & ~6;
  const textStyleName = mtext ? null : String(entity?.__textStyleName || 'STANDARD');

  const id = primitiveId(context, sourceRef);
  pushPrimitive(context, {
    id,
    kind: 'text',
    role: 'reference-text',
    layerId,
    sourceRef,
    style,
    point,
    text: mtext ? decodeMtext(entity.text) : decodeDxfUnicode(entity.text),
    rawText: String(entity.text ?? ''),
    heightMm: heightSource * info.sy,
    widthFactor,
    obliqueDeg,
    rotationDeg: angleDegFromVector(transformedDirection),
    anchor,
    mirrorX,
    mirrorY,
    mirrored: mirrorX || mirrorY,
    textStyleName,
    mtext,
  });

  let status = 'supported';
  let reason = 'TEXTを正規化しました。';
  let code = null;
  if (mtext) {
    status = 'approximated';
    reason = 'MTEXTの基本文字・改行をTEXT相当へ近似しました。書式runは保持しません。';
    code = 'DXF_MTEXT_FORMATTING_APPROXIMATED';
  } else if (unknownGenerationFlags !== 0) {
    status = 'approximated';
    reason = `TEXT generation flagsに未対応bitがあります: ${generationFlags}`;
    code = 'DXF_TEXT_GENERATION_FLAGS_APPROXIMATED';
  } else if (!(rawWidthFactor > 0)) {
    status = 'approximated';
    reason = 'TEXTの幅係数(group 41)が不正なため1.0へ近似しました。';
    code = 'DXF_TEXT_WIDTH_FACTOR_APPROXIMATED';
  } else if (mirrorX || mirrorY || Math.abs(obliqueDeg) > 1e-12) {
    reason = 'TEXTの鏡像・幅係数・斜体角をlocal glyph transformとして正規化しました。';
  }

  return makeResult(sourceRef, status, [id], reason, code);
}

function aggregateInsertStatus(childResults) {
  if (childResults.some((result) => result.status === 'failed')) return 'failed';
  if (childResults.some((result) => result.status === 'unsupported')) return 'approximated';
  if (childResults.some((result) => result.status === 'approximated')) return 'approximated';
  return 'supported';
}

function processInsert(entity, sourceRef, matrix, layerId, style, context, entityPath) {
  const blockName = String(entity?.name || '');
  const block = context.dxf.blocks?.[blockName];
  if (!block || !Array.isArray(block.entities)) {
    return makeResult(
      sourceRef,
      'failed',
      [],
      `INSERT参照先BLOCKが見つかりません: ${blockName}`,
      'DXF_BLOCK_MISSING',
    );
  }
  if (context.blockStack.includes(blockName)) {
    return makeResult(
      sourceRef,
      'failed',
      [],
      `循環BLOCK参照を検出しました: ${[...context.blockStack, blockName].join(' -> ')}`,
      'DXF_BLOCK_CYCLE',
    );
  }
  if (context.blockStack.length >= context.limits.maxBlockDepth) {
    return makeResult(
      sourceRef,
      'failed',
      [],
      `BLOCK入れ子深さが上限${context.limits.maxBlockDepth}を超えました。`,
      'DXF_BLOCK_DEPTH_LIMIT',
    );
  }

  let array;
  try {
    array = insertArrayDefinition(entity, context);
  } catch (error) {
    return makeResult(
      sourceRef,
      'failed',
      [],
      error.message,
      error.code || 'DXF_INSERT_ARRAY_INVALID',
    );
  }

  const before = context.entityResults.length;
  const insertOccurrence = referenceSourceRefKey(sourceRef);
  try {
    for (let row = 0; row < array.effectiveRowCount; row++) {
      for (let column = 0; column < array.effectiveColumnCount; column++) {
        const arrayOffset = [column * array.columnSpacing, row * array.rowSpacing];
        const localMatrix = blockInsertMatrix(entity, block, arrayOffset);
        const childMatrix = multiplyAffine(matrix, localMatrix);
        const occurrence = array.isArray
          ? `${insertOccurrence}:row:${row}:column:${column}`
          : insertOccurrence;
        const childContext = {
          ...context,
          blockOccurrence: [...context.blockOccurrence, occurrence],
          blockName,
          blockStack: [...context.blockStack, blockName],
          inheritedLayer: layerId,
          inheritedColorRgb: style.colorRgb,
          inheritedLineType: style.lineType,
        };
        for (const [index, child] of block.entities.entries()) {
          processEntity(
            child,
            childMatrix,
            childContext,
            `${entityPath}/array:${row},${column}/block:${blockName}/${index}`,
          );
        }
      }
    }
  } catch (error) {
    if (error?.code === 'DXF_EXPANSION_LIMIT_EXCEEDED') throw error;
    return makeResult(sourceRef, 'failed', [], error.message, 'DXF_INSERT_TRANSFORM_INVALID');
  }

  const childResults = context.entityResults.slice(before);
  const primitiveIds = childResults.flatMap((result) => result.primitiveIds);
  const status = aggregateInsertStatus(childResults);
  const detail = array.isArray
    ? `INSERT配列 ${blockName} (${array.effectiveRowCount}x${array.effectiveColumnCount})`
    : `INSERT ${blockName}`;
  return makeResult(
    sourceRef,
    status,
    primitiveIds,
    status === 'supported'
      ? `${detail}を展開しました。`
      : `${detail}を展開しましたが、一部entityに診断があります。`,
    status === 'supported' ? null : 'DXF_INSERT_PARTIAL_EXPANSION',
  );
}

function processDimension(entity, sourceRef, matrix, layerId, style, context, entityPath) {
  const blockName = String(entity?.block || '');
  const block = context.dxf.blocks?.[blockName];
  if (!block || !Array.isArray(block.entities) || block.entities.length === 0) {
    return makeResult(
      sourceRef,
      'unsupported',
      [],
      'DIMENSIONの描画BLOCKがないため初期profileでは復元しません。',
      'DXF_DIMENSION_BLOCK_MISSING',
    );
  }
  if (context.blockStack.includes(blockName)) {
    return makeResult(
      sourceRef,
      'failed',
      [],
      'DIMENSION BLOCKの循環参照を検出しました。',
      'DXF_BLOCK_CYCLE',
    );
  }
  if (context.blockStack.length >= context.limits.maxBlockDepth) {
    return makeResult(
      sourceRef,
      'failed',
      [],
      `BLOCK入れ子深さが上限${context.limits.maxBlockDepth}を超えました。`,
      'DXF_BLOCK_DEPTH_LIMIT',
    );
  }
  const childContext = {
    ...context,
    blockOccurrence: [...context.blockOccurrence, referenceSourceRefKey(sourceRef)],
    blockName,
    blockStack: [...context.blockStack, blockName],
    inheritedLayer: layerId,
    inheritedColorRgb: style.colorRgb,
    inheritedLineType: style.lineType,
  };
  const before = context.entityResults.length;
  for (const [index, child] of block.entities.entries()) {
    processEntity(child, matrix, childContext, `${entityPath}/dimension:${blockName}/${index}`);
  }
  const childResults = context.entityResults.slice(before);
  return makeResult(
    sourceRef,
    'approximated',
    childResults.flatMap((result) => result.primitiveIds),
    'DIMENSIONを意味付き寸法へ復元せず、描画BLOCKを参照図形として展開しました。',
    'DXF_DIMENSION_VISUAL_EXPANSION',
  );
}

function processEntity(entity, matrix, context, entityPath) {
  context.expansion.count += 1;
  if (context.expansion.count > context.limits.maxExpandedEntities) {
    const error = new Error(
      `DXF展開entity数が上限${context.limits.maxExpandedEntities}を超えました。`,
    );
    error.code = 'DXF_EXPANSION_LIMIT_EXCEEDED';
    throw error;
  }
  const layerId = effectiveLayerFor(entity, context);
  if (!context.layerNames.has(layerId)) context.layerNames.add(layerId);
  const sourceRef = sourceRefFor(context, entity, entityPath, layerId);
  if (!checkEntity2d(entity, sourceRef, context)) return;
  const style = entityStyle(entity, context.dxf, layerId, context);
  let result;
  try {
    switch (entity?.type) {
      case 'LINE':
        result = processLine(entity, sourceRef, matrix, layerId, style, context);
        break;
      case 'POLYLINE':
      case 'LWPOLYLINE':
        result = processPolyline(entity, sourceRef, matrix, layerId, style, context);
        break;
      case 'CIRCLE':
        result = processCircle(entity, sourceRef, matrix, layerId, style, context);
        break;
      case 'ARC':
        result = processArc(entity, sourceRef, matrix, layerId, style, context);
        break;
      case 'TEXT':
        result = processText(entity, sourceRef, matrix, layerId, style, context, false);
        break;
      case 'MTEXT':
        result = processText(entity, sourceRef, matrix, layerId, style, context, true);
        break;
      case 'INSERT':
        result = processInsert(entity, sourceRef, matrix, layerId, style, context, entityPath);
        break;
      case 'DIMENSION':
        result = processDimension(entity, sourceRef, matrix, layerId, style, context, entityPath);
        break;
      default:
        result = makeResult(
          sourceRef,
          'unsupported',
          [],
          `初期DXF参照profileでは${entity?.type || 'UNKNOWN'}を描画しません。`,
          'DXF_ENTITY_TYPE_UNSUPPORTED',
        );
    }
  } catch (error) {
    if (error?.code === 'DXF_EXPANSION_LIMIT_EXCEEDED') throw error;
    result = makeResult(sourceRef, 'failed', [], error.message, error.code || 'DXF_ENTITY_FAILED');
  }

  const lineTypeGeometry = new Set(['LINE', 'POLYLINE', 'LWPOLYLINE', 'CIRCLE', 'ARC']);
  if (
    result?.status === 'supported' &&
    lineTypeGeometry.has(entity?.type) &&
    style.lineType &&
    style.lineType.toUpperCase() !== 'CONTINUOUS' &&
    !Array.isArray(style.dashPatternMm)
  ) {
    result = makeResult(
      sourceRef,
      'approximated',
      result.primitiveIds,
      `線種 ${style.lineType} の単純dash patternを解決できないためCONTINUOUS表示へ近似します。`,
      'DXF_LINETYPE_PATTERN_APPROXIMATED',
    );
  }
  context.entityResults.push(result);
}

function diagnosticsFromResults(results) {
  return Object.freeze(
    results
      .filter((result) => result.status !== 'supported')
      .map((result, index) =>
        Object.freeze({
          id: `dxf-import-diagnostic:${index}`,
          status: result.status,
          severity:
            result.status === 'failed'
              ? 'error'
              : result.status === 'unsupported'
                ? 'warning'
                : 'notice',
          code: result.code,
          reason: result.reason,
          sourceRef: result.sourceRef,
        }),
      ),
  );
}

function statsFromResults(results, primitiveCount, sourceEntityCount, expandedEntityCount) {
  const counts = { supported: 0, approximated: 0, unsupported: 0, failed: 0 };
  for (const result of results) counts[result.status] += 1;
  return Object.freeze({
    sourceEntities: sourceEntityCount,
    expandedEntities: expandedEntityCount,
    primitives: primitiveCount,
    ...counts,
  });
}

export function assertDxfReferenceAssetDescriptor(descriptor) {
  if (
    descriptor?.kind !== 'DxfReferenceAssetDescriptor' ||
    descriptor.schemaVersion !== DXF_REFERENCE_ASSET_SCHEMA_VERSION
  )
    throw new TypeError('DxfReferenceAssetDescriptor v1が必要です。');

  const source = descriptor.source;
  requiredString(source?.documentId, 'DXF asset documentId');
  const revision = requiredString(source?.revision, 'DXF asset revision');
  if (!/^[0-9a-f]{64}$/.test(revision))
    throw new TypeError('DXF asset revisionには小文字SHA-256が必要です。');
  if (source?.filename != null && typeof source.filename !== 'string')
    throw new TypeError('DXF asset filenameが不正です。');
  if (!Number.isSafeInteger(source?.byteLength) || source.byteLength < 0)
    throw new RangeError('DXF asset byteLengthが不正です。');

  const profile = descriptor.importProfile;
  if (profile?.id !== DXF_REFERENCE_IMPORT_PROFILE_ID)
    throw new RangeError(`未対応のDXF import profileです: ${profile?.id}`);
  if (profile?.adapterVersion !== DXF_REFERENCE_IMPORT_ADAPTER_VERSION)
    throw new RangeError(`未対応のDXF import adapter versionです: ${profile?.adapterVersion}`);
  if (
    profile?.unitOverride != null &&
    (typeof profile.unitOverride !== 'string' || !profile.unitOverride.trim())
  )
    throw new TypeError('DXF asset unitOverrideが不正です。');
  const origin = profile?.placement?.originMm;
  if (!Array.isArray(origin) || origin.length !== 2 || !origin.every(Number.isFinite))
    throw new TypeError('DXF asset placement originMmが不正です。');
  if (!Number.isFinite(profile?.placement?.rotationDeg))
    throw new TypeError('DXF asset placement rotationDegが不正です。');

  requiredString(descriptor.decoding?.encoding, 'DXF asset encoding');
  if (
    descriptor.decoding?.fallbackFrom != null &&
    typeof descriptor.decoding.fallbackFrom !== 'string'
  )
    throw new TypeError('DXF asset fallbackFromが不正です。');

  const resolved = descriptor.resolved;
  requiredString(resolved?.sourceUnits, 'DXF asset resolved sourceUnits');
  if (!Number.isInteger(resolved?.sourceUnitCode) || resolved.sourceUnitCode <= 0)
    throw new TypeError('DXF asset resolved sourceUnitCodeが不正です。');
  requiredString(resolved?.unitResolution, 'DXF asset resolved unitResolution');
  if (!Number.isFinite(resolved?.scaleToMm) || resolved.scaleToMm <= 0)
    throw new TypeError('DXF asset resolved scaleToMmが不正です。');

  return descriptor;
}

/**
 * #423 ZIP保存へ渡す、JSON serializableなDXF原本/import依存契約。
 * 原本bytes自体はruntime側で別保持し、このdescriptorとrevisionで対応付ける。
 */
export function createDxfReferenceAssetDescriptor({
  referenceDrawing,
  byteLength,
  encoding,
  fallbackFrom = null,
  unitOverride = null,
} = {}) {
  assertReferenceDrawing(referenceDrawing);
  if (referenceDrawing.source?.kind !== 'dxf')
    throw new TypeError('DXF ReferenceDrawingが必要です。');
  const length = Number(byteLength);
  if (!Number.isSafeInteger(length) || length < 0)
    throw new RangeError('DXF原本byteLengthが不正です。');
  const normalizedEncoding = requiredString(encoding, 'DXF文字encoding');
  const transform = referenceDrawing.transform;
  const originMm = transform?.originMm;
  if (!Array.isArray(originMm) || originMm.length !== 2 || !originMm.every(Number.isFinite))
    throw new TypeError('DXF配置原点が不正です。');

  return assertDxfReferenceAssetDescriptor(
    Object.freeze({
      schemaVersion: DXF_REFERENCE_ASSET_SCHEMA_VERSION,
      kind: 'DxfReferenceAssetDescriptor',
      source: Object.freeze({
        documentId: referenceDrawing.source.documentId,
        revision: referenceDrawing.source.revision,
        filename: referenceDrawing.source.filename,
        byteLength: length,
      }),
      importProfile: Object.freeze({
        id: referenceDrawing.source.profileId,
        adapterVersion: DXF_REFERENCE_IMPORT_ADAPTER_VERSION,
        unitOverride:
          unitOverride == null || String(unitOverride).trim() === ''
            ? null
            : String(unitOverride).trim(),
        placement: Object.freeze({
          originMm: Object.freeze([...originMm]),
          rotationDeg: Number(transform.rotationDeg || 0),
        }),
      }),
      decoding: Object.freeze({
        encoding: normalizedEncoding,
        fallbackFrom: fallbackFrom == null ? null : String(fallbackFrom),
      }),
      resolved: Object.freeze({
        sourceUnits: transform.sourceUnits,
        sourceUnitCode: transform.sourceUnitCode,
        unitResolution: transform.unitResolution,
        scaleToMm: transform.scaleToMm,
      }),
    }),
  );
}

/**
 * JSONへ保存したasset descriptorとDXF原本からReferenceDrawingを再生成する。
 * hash/byteLength照合は原本bytesを所有する上位層で行う。
 */
export function parseDxfReferenceDrawingFromAsset(dxfContent, descriptor) {
  const asset = assertDxfReferenceAssetDescriptor(descriptor);
  const drawing = parseDxfReferenceDrawing(dxfContent, {
    documentId: asset.source.documentId,
    revision: asset.source.revision,
    filename: asset.source.filename ?? null,
    unitOverride: asset.importProfile.unitOverride,
    placement: asset.importProfile.placement,
  });
  const transform = drawing.transform;
  const resolved = asset.resolved;
  if (
    transform.sourceUnits !== resolved.sourceUnits ||
    transform.sourceUnitCode !== resolved.sourceUnitCode ||
    transform.unitResolution !== resolved.unitResolution ||
    Math.abs(transform.scaleToMm - resolved.scaleToMm) > 1e-12
  ) {
    throw new Error('DXF再生成時の解決済み単位が保存descriptorと一致しません。');
  }
  return drawing;
}

/**
 * 解析済みDXFをReferenceDrawingへ変換する。
 */
export function createReferenceDrawingFromParsedDxf(
  dxf,
  { documentId, revision, filename = null, unitOverride = null, placement = {}, limits = {} } = {},
) {
  const source = createReferenceDrawingSource({
    kind: 'dxf',
    documentId,
    revision,
    filename,
    profileId: DXF_REFERENCE_IMPORT_PROFILE_ID,
  });
  if (!dxf || typeof dxf !== 'object') throw new TypeError('解析済みDXFデータが必要です。');
  const sourceEntities = Array.isArray(dxf.entities) ? dxf.entities : [];
  const normalizedLimits = normalizeLimits(limits);
  if (sourceEntities.length > normalizedLimits.maxSourceEntities) {
    const error = new Error(
      `DXF model space entity数${sourceEntities.length}が上限${normalizedLimits.maxSourceEntities}を超えました。`,
    );
    error.code = 'DXF_SOURCE_ENTITY_LIMIT_EXCEEDED';
    throw error;
  }
  const units = resolveUnits(dxf, unitOverride);
  const transform = Object.freeze({
    sourceToModel: Object.freeze(sourceToModelMatrix(units.scaleToMm, placement)),
    sourceUnits: units.name,
    sourceUnitCode: units.code,
    unitResolution: units.resolution,
    scaleToMm: units.scaleToMm,
    originMm: Object.freeze([...(placement.originMm ?? [0, 0])]),
    rotationDeg: Number(placement.rotationDeg ?? 0),
  });
  const context = {
    source,
    dxf,
    limits: normalizedLimits,
    primitives: [],
    entityResults: [],
    bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    layerNames: new Set(Object.keys(dxf.tables?.layer?.layers || {})),
    blockOccurrence: [],
    blockName: null,
    blockStack: [],
    inheritedLayer: null,
    inheritedColorRgb: null,
    inheritedLineType: null,
    sourceScaleToMm: units.scaleToMm,
    // Shared by every nested INSERT/DIMENSION context, including array cells.
    expansion: { count: 0 },
  };

  for (const [index, entity] of sourceEntities.entries()) {
    processEntity(entity, transform.sourceToModel, context, `entities/${index}`);
  }

  const result = Object.freeze({
    schemaVersion: REFERENCE_DRAWING_SCHEMA_VERSION,
    kind: 'ReferenceDrawing',
    units: 'mm',
    source,
    transform,
    layers: Object.freeze([...context.layerNames].sort().map((name) => layerRecord(dxf, name))),
    primitives: Object.freeze(context.primitives),
    entityResults: Object.freeze(context.entityResults),
    diagnostics: diagnosticsFromResults(context.entityResults),
    stats: statsFromResults(
      context.entityResults,
      context.primitives.length,
      sourceEntities.length,
      context.expansion.count,
    ),
    bounds: finalizeBounds(context.bounds),
  });
  return assertReferenceDrawing(result);
}

function extractLayerLineTypes(dxfContent) {
  const lines = String(dxfContent).split(/\r\n|\r|\n/g);
  const result = {};
  let inLayer = false;
  let name = null;
  let lineType = null;

  const flush = () => {
    if (inLayer && name) result[name] = lineType || 'CONTINUOUS';
  };

  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number.parseInt(lines[index].trim(), 10);
    const value = lines[index + 1].trim();
    if (code === 0) {
      flush();
      inLayer = value === 'LAYER';
      name = null;
      lineType = null;
      continue;
    }
    if (!inLayer) continue;
    if (code === 2) name = value;
    else if (code === 6) lineType = value;
  }
  flush();
  return Object.freeze(result);
}

function extractRawTextMetadata(dxfContent) {
  const lines = String(dxfContent).split(/\r\n|\r|\n/g);
  const topLevel = [];
  const blocks = {};
  let section = null;
  let expectSectionName = false;
  let inBlockHeader = false;
  let blockName = null;
  let current = null;

  const flush = () => {
    if (!current) return;
    if (current.type === 'TEXT') {
      const record = Object.freeze({
        handle: current.handle,
        styleName: current.styleName,
        generationFlags: current.generationFlags,
        obliqueDeg: current.obliqueDeg,
      });
      if (section === 'ENTITIES') topLevel.push(record);
      else if (section === 'BLOCKS' && blockName) {
        if (!blocks[blockName]) blocks[blockName] = [];
        blocks[blockName].push(record);
      }
    }
    current = null;
  };

  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number.parseInt(lines[index].trim(), 10);
    const value = lines[index + 1].trim();
    if (!Number.isInteger(code)) continue;

    if (code === 0 && value === 'SECTION') {
      flush();
      section = null;
      expectSectionName = true;
      inBlockHeader = false;
      blockName = null;
      continue;
    }
    if (expectSectionName && code === 2) {
      section = value;
      expectSectionName = false;
      continue;
    }
    if (code === 0 && value === 'ENDSEC') {
      flush();
      section = null;
      inBlockHeader = false;
      blockName = null;
      continue;
    }

    if (section === 'ENTITIES') {
      if (code === 0) {
        flush();
        current = {
          type: value,
          handle: null,
          styleName: null,
          generationFlags: null,
          obliqueDeg: null,
        };
      } else if (current) {
        if (code === 5) current.handle = value;
        else if (code === 7 && current.type === 'TEXT') current.styleName = value;
        else if (code === 71 && current.type === 'TEXT')
          current.generationFlags = Number.parseInt(value, 10);
        else if (code === 51 && current.type === 'TEXT') current.obliqueDeg = Number(value);
      }
      continue;
    }

    if (section !== 'BLOCKS') continue;
    if (code === 0) {
      flush();
      if (value === 'BLOCK') {
        inBlockHeader = true;
        blockName = null;
      } else if (value === 'ENDBLK') {
        inBlockHeader = false;
        blockName = null;
      } else if (blockName) {
        inBlockHeader = false;
        current = {
          type: value,
          handle: null,
          styleName: null,
          generationFlags: null,
          obliqueDeg: null,
        };
      }
      continue;
    }
    if (inBlockHeader) {
      if (code === 2 && !blockName) blockName = value;
      continue;
    }
    if (current) {
      if (code === 5) current.handle = value;
      else if (code === 7 && current.type === 'TEXT') current.styleName = value;
      else if (code === 71 && current.type === 'TEXT')
        current.generationFlags = Number.parseInt(value, 10);
      else if (code === 51 && current.type === 'TEXT') current.obliqueDeg = Number(value);
    }
  }
  flush();
  return Object.freeze({
    topLevel: Object.freeze(topLevel),
    blocks: Object.freeze(
      Object.fromEntries(
        Object.entries(blocks).map(([name, records]) => [name, Object.freeze(records)]),
      ),
    ),
  });
}

function applyRawTextMetadataToEntities(entities, rawRecords = []) {
  if (!Array.isArray(entities) || !Array.isArray(rawRecords) || rawRecords.length === 0) return;
  const used = new Set();
  const byHandle = new Map(
    rawRecords
      .map((record, index) => [record?.handle == null ? null : String(record.handle), index])
      .filter(([handle]) => handle),
  );

  const takeRecord = (entity) => {
    const handle = entity?.handle == null ? null : String(entity.handle);
    if (handle && byHandle.has(handle)) {
      const index = byHandle.get(handle);
      if (!used.has(index)) {
        used.add(index);
        return rawRecords[index];
      }
    }
    for (let index = 0; index < rawRecords.length; index++) {
      if (used.has(index)) continue;
      used.add(index);
      return rawRecords[index];
    }
    return null;
  };

  for (const entity of entities) {
    if (entity?.type !== 'TEXT') continue;
    const record = takeRecord(entity);
    if (!record) continue;
    if (record.styleName) {
      Object.defineProperty(entity, '__textStyleName', {
        value: String(record.styleName),
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
    if (Number.isInteger(record.generationFlags)) {
      Object.defineProperty(entity, '__textGenerationFlags', {
        value: record.generationFlags,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
    if (Number.isFinite(record.obliqueDeg)) {
      Object.defineProperty(entity, '__textObliqueDeg', {
        value: record.obliqueDeg,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
  }
}

function applyRawTextMetadata(parsed, metadata) {
  applyRawTextMetadataToEntities(parsed?.entities, metadata?.topLevel || []);
  for (const [name, block] of Object.entries(parsed?.blocks || {})) {
    applyRawTextMetadataToEntities(block?.entities, metadata?.blocks?.[name] || []);
  }
}

/**
 * DXFテキスト原本を解析し、ReferenceDrawingへ正規化する。
 */
export function parseDxfReferenceDrawing(dxfContent, options = {}) {
  requiredString(dxfContent, 'DXFテキスト');
  const parsed = parseDxf(dxfContent, { entityHandlers: dxfUnsupportedEntityHandlers(dxfContent) });
  applyRawTextMetadata(parsed, extractRawTextMetadata(dxfContent));
  Object.defineProperty(parsed, '__layerLineTypes', {
    value: extractLayerLineTypes(dxfContent),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  const sdvUnits = String(dxfContent).match(
    /(?:^|\r?\n)\s*999\s*\r?\n\s*SDV_UNITS=([^\r\n]+)(?:\r?\n|$)/i,
  )?.[1];
  if (sdvUnits) {
    Object.defineProperty(parsed, '__sdvUnits', {
      value: String(sdvUnits).trim(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return createReferenceDrawingFromParsedDxf(parsed, options);
}
