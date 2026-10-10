/**
 * @fileoverview DOM/sceneに依存しないDrawingRenderPlan契約。
 * SVG rendererとDXF writerが同じ派生図面を参照するための共通compile境界。
 */
import { assertMatrix, assertPoint, isDirectSimilarity, transformPoint } from './affine2d.js';
import { elementRefKey } from './drawingModel.js';
import { assertReferenceDrawing } from './referenceDrawing.js';
import { compileDrawingRenderTags } from './drawingRenderPlanTags.js';
import { compileDrawingRenderDimensions } from './drawingRenderPlanDimensions.js';

export const DRAWING_RENDER_PLAN_SCHEMA_VERSION = 1;
export const DEFAULT_DRAWING_RENDER_PROFILE_ID = 'sdv-shared-svg-dxf-v1';

const SCREEN_ONLY_PROFILE_KEYS = Object.freeze([
  'devicePixelRatio',
  'dpr',
  'screenScale',
  'cssScale',
  'zoom',
  'pan',
  'viewport',
]);

const DEFAULT_STYLE = Object.freeze({
  strokeColor: '#087f8c',
  strokeWidthMm: 0.25,
  fillColor: null,
  fillOpacity: 0,
  lineType: 'CONTINUOUS',
});

const DEFAULT_TEXT_STYLE = Object.freeze({
  fontFamily: 'sans-serif',
  textHeightMm: 2.5,
  color: '#424242',
});

function assertFiniteNumber(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name}には有限の数値が必要です。`);
  return value;
}

function normalizePositiveNumber(value, name, fallback) {
  const normalized = value == null ? fallback : Number(value);
  assertFiniteNumber(normalized, name);
  if (normalized <= 0) throw new RangeError(`${name}には0より大きい値が必要です。`);
  return normalized;
}

function normalizeString(value, fallback, name) {
  const normalized = value == null ? fallback : String(value).trim();
  if (!normalized) throw new TypeError(`${name}が必要です。`);
  return normalized;
}

function normalizeColor(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function freezePoint(point) {
  return Object.freeze([...assertPoint(point)]);
}

function freezePoints(points) {
  return Object.freeze(points.map((point) => freezePoint(point)));
}

function extendBounds(bounds, points) {
  for (const [x, y] of points) {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  }
}

function finalizeBounds(bounds) {
  if (
    ![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite) ||
    bounds.minX > bounds.maxX ||
    bounds.minY > bounds.maxY
  ) {
    return null;
  }
  return Object.freeze({ ...bounds });
}

function sanitizeLayerId(value, fallback) {
  const normalized = String(value || fallback || '')
    .trim()
    .replace(/\s+/g, '_');
  if (!normalized) throw new TypeError('レイヤIDが必要です。');
  return normalized;
}

function memberLayerId(record) {
  return sanitizeLayerId(record?.renderType || record?.ref?.elementType, 'Member');
}

function annotationLayerId(annotation) {
  const role = String(annotation?.role || '');
  // 現行SVG互換: 通り芯だけをAxisレイヤ、寸法はAnnotationレイヤに置く。
  // 寸法専用レイヤをUIへ公開するときは別PRで表示設定と同時に移行する。
  if (role === 'grid' || role === 'grid-label' || role === 'grid-bubble') return 'Axis';
  return 'Annotation';
}

function annotationVisibilitySource(annotation) {
  const role = String(annotation?.role || '');
  if (
    role === 'grid' ||
    role === 'grid-label' ||
    role === 'grid-bubble' ||
    role.startsWith('dimension')
  )
    return 'Axis';
  return annotationLayerId(annotation);
}

function normalizeAnnotationStyle(annotation, displaySettings, textStyle) {
  const role = String(annotation?.role || '');
  const axisColor = normalizeColor(displaySettings?.colors?.Axis, null);
  const style = {
    strokeColor: null,
    strokeWidthMm: null,
    dashPatternMm: null,
    textColor: null,
    textHeightMm: null,
  };

  if (role === 'grid') {
    style.strokeColor = axisColor || '#607d8b';
    style.strokeWidthMm = 0.8;
    style.dashPatternMm = Object.freeze([6, 4]);
  } else if (role === 'grid-label') {
    style.textColor = axisColor || '#455a64';
    style.textHeightMm = textStyle.textHeightMm;
  } else if (role === 'grid-bubble') {
    style.strokeColor = axisColor || '#607d8b';
    style.strokeWidthMm = 0.8;
    style.fillColor = '#ffffff';
  } else if (role === 'dimension-text') {
    style.textColor = '#424242';
    style.textHeightMm = Math.max(2.5, textStyle.textHeightMm * 0.85);
  } else if (role === 'dimension-overall') {
    style.strokeColor = '#424242';
    style.strokeWidthMm = 1.2;
  } else if (role === 'dimension' || role === 'dimension-extension' || role === 'dimension-tick') {
    style.strokeColor = '#616161';
    style.strokeWidthMm = 0.9;
  } else if (annotation.kind === 'text') {
    style.textColor = '#424242';
    style.textHeightMm = textStyle.textHeightMm;
  } else {
    style.strokeColor = '#616161';
    style.strokeWidthMm = 0.9;
  }

  return Object.freeze(style);
}

function normalizeLayerStyle(layerId, displaySettings, sourceElementType = null) {
  const color = normalizeColor(displaySettings?.colors?.[layerId], DEFAULT_STYLE.strokeColor);
  const requestedFillOpacity = Number(displaySettings?.cutSurfaceFillOpacity);
  const fillOpacity =
    Number.isFinite(requestedFillOpacity) && requestedFillOpacity >= 0 && requestedFillOpacity <= 1
      ? requestedFillOpacity
      : 0.18;
  const cutSurfaceLayer = ['Column', 'Post', 'Wall'].includes(sourceElementType || layerId);
  return Object.freeze({
    ...DEFAULT_STYLE,
    strokeColor: color,
    fillColor: displaySettings?.cutSurfaceFill === false ? null : color,
    fillOpacity: cutSurfaceLayer ? fillOpacity : 0,
  });
}

function normalizeTextStyle(profile) {
  return Object.freeze({
    ...DEFAULT_TEXT_STYLE,
    fontFamily: normalizeString(
      profile.textStyle?.fontFamily,
      DEFAULT_TEXT_STYLE.fontFamily,
      '文字フォント',
    ),
    textHeightMm: normalizePositiveNumber(
      profile.textStyle?.textHeightMm,
      '文字高さ',
      DEFAULT_TEXT_STYLE.textHeightMm,
    ),
    color: normalizeColor(profile.textStyle?.color, DEFAULT_TEXT_STYLE.color),
  });
}

function registerLayer(layers, layerId, role, displaySettings, extra = {}) {
  if (!layers.has(layerId)) {
    layers.set(
      layerId,
      Object.freeze({
        id: layerId,
        role,
        visible: displaySettings?.visibility?.[layerId] !== false,
        style: normalizeLayerStyle(layerId, displaySettings, extra.sourceElementType),
        ...extra,
      }),
    );
  }
  return layers.get(layerId);
}

/**
 * model XY(mm)からpaper mmへの変換を作る。
 * rotationDegは図面座標上の時計回りを正とし、modelOriginをpaperOriginMmへ写像する。
 */
export function createModelToPaperMatrix({
  modelOrigin = [0, 0],
  paperOriginMm = [0, 0],
  modelToPaperScale = 1,
  rotationDeg = 0,
} = {}) {
  const sourceOrigin = assertPoint(modelOrigin);
  const targetOrigin = assertPoint(paperOriginMm);
  const scale = normalizePositiveNumber(modelToPaperScale, 'modelToPaperScale', 1);
  const rotation = Number(rotationDeg ?? 0);
  assertFiniteNumber(rotation, 'rotationDeg');
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const a = scale * cos;
  const b = -scale * sin;
  const c = scale * sin;
  const d = scale * cos;
  return assertMatrix([
    a,
    b,
    c,
    d,
    targetOrigin[0] - a * sourceOrigin[0] - c * sourceOrigin[1],
    targetOrigin[1] - b * sourceOrigin[0] - d * sourceOrigin[1],
  ]);
}

export function normalizeDrawingRenderProfile(profile = {}) {
  for (const key of SCREEN_ONLY_PROFILE_KEYS) {
    if (Object.hasOwn(profile, key)) {
      throw new TypeError(`画面専用値 ${key} はDrawingRenderPlanに混入できません。`);
    }
  }
  const id = normalizeString(profile.id, DEFAULT_DRAWING_RENDER_PROFILE_ID, '出力profile ID');
  const modelToPaper = profile.modelToPaper
    ? assertMatrix([...profile.modelToPaper])
    : createModelToPaperMatrix(profile);
  if (!isDirectSimilarity(modelToPaper))
    throw new TypeError('model→paper変換には反転・せん断のない相似変換が必要です。');
  return Object.freeze({
    id,
    schemaVersion: DRAWING_RENDER_PLAN_SCHEMA_VERSION,
    modelUnits: 'mm',
    paperUnits: 'mm',
    angleUnits: 'degree',
    modelToPaper: Object.freeze([...modelToPaper]),
    textStyle: normalizeTextStyle(profile),
    output: Object.freeze({
      preferredSpace: (() => {
        const value = profile.output?.preferredSpace || 'model';
        if (value !== 'model' && value !== 'paper')
          throw new RangeError('出力座標系はmodelまたはpaperを指定してください。');
        return value;
      })(),
      editableText: profile.output?.editableText !== false,
      dimensionRepresentation: (() => {
        const value = profile.output?.dimensionRepresentation || 'exploded-line-text';
        if (!['exploded-line-text', 'native-dimension'].includes(value))
          throw new RangeError(
            '寸法表現はexploded-line-textまたはnative-dimensionを指定してください。',
          );
        return value;
      })(),
      editableDimensions:
        (profile.output?.dimensionRepresentation || 'exploded-line-text') === 'native-dimension',
      unsupportedPrimitivePolicy: profile.output?.unsupportedPrimitivePolicy || 'diagnostic-error',
    }),
  });
}

export function assertDrawingRenderPlan(renderPlan) {
  if (
    renderPlan?.kind !== 'DrawingRenderPlan' ||
    renderPlan.schemaVersion !== DRAWING_RENDER_PLAN_SCHEMA_VERSION ||
    renderPlan.units?.model !== 'mm' ||
    renderPlan.units?.paper !== 'mm' ||
    !Array.isArray(renderPlan.profile?.modelToPaper)
  ) {
    throw new TypeError('DrawingRenderPlan v1 (model mm / paper mm)が必要です。');
  }
  assertMatrix(renderPlan.profile.modelToPaper);
  if (!isDirectSimilarity(renderPlan.profile.modelToPaper))
    throw new TypeError('DrawingRenderPlanのmodel→paper変換が不正です。');
  if (renderPlan.tags !== null && !Array.isArray(renderPlan.tags))
    throw new TypeError('DrawingRenderPlanのtagsが不正です。');
  if (renderPlan.dimensions != null && !Array.isArray(renderPlan.dimensions))
    throw new TypeError('DrawingRenderPlanのdimensionsが不正です。');
  if (renderPlan.referencePrimitives != null && !Array.isArray(renderPlan.referencePrimitives))
    throw new TypeError('DrawingRenderPlanのreferencePrimitivesが不正です。');
  if (renderPlan.references != null && !Array.isArray(renderPlan.references))
    throw new TypeError('DrawingRenderPlanのreferencesが不正です。');
  return renderPlan;
}

function normalizeDrawingModel(drawing) {
  if (drawing?.schemaVersion !== 1 || drawing.units !== 'mm') {
    throw new TypeError('DrawingModel v1 (mm)が必要です。');
  }
  return drawing;
}

function normalizeSourceRef(ref) {
  const key = elementRefKey(ref);
  return Object.freeze({
    modelKey: ref.modelKey,
    elementType: ref.elementType,
    elementId: String(ref.elementId),
    guid: ref.guid == null ? null : String(ref.guid),
    key,
  });
}

function normalizeMemberAxisModel(axis) {
  if (axis == null) return null;
  if (axis.units !== 'mm') throw new TypeError('DrawingModelのmemberAxisModelが不正です。');

  if (axis.kind === 'straight-member-axis') {
    if (!Array.isArray(axis.start) || !Array.isArray(axis.end)) {
      throw new TypeError('DrawingModelのmemberAxisModelが不正です。');
    }
    const start = freezePoint(axis.start);
    const end = freezePoint(axis.end);
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) <= 1e-9)
      throw new RangeError('DrawingModelのmemberAxisModel長さが0です。');
    return Object.freeze({
      kind: 'straight-member-axis',
      start,
      end,
      units: 'mm',
    });
  }

  if (axis.kind === 'polyline-member-axis') {
    if (
      !Array.isArray(axis.points) ||
      axis.points.length < 3 ||
      !Array.isArray(axis.distances) ||
      axis.distances.length !== axis.points.length
    ) {
      throw new TypeError('DrawingModelのpolyline memberAxisModelが不正です。');
    }
    const points = freezePoints(axis.points);
    const distances = axis.distances.map(Number);
    if (
      !distances.every(Number.isFinite) ||
      distances[0] !== 0 ||
      distances.some((distance, index) => index > 0 && distance <= distances[index - 1])
    ) {
      throw new TypeError('DrawingModelのpolyline memberAxisModel stationが不正です。');
    }
    const totalLength = Number(axis.totalLength);
    if (
      !(totalLength > 0) ||
      !Number.isFinite(totalLength) ||
      Math.abs(distances[distances.length - 1] - totalLength) > 1e-6
    ) {
      throw new TypeError('DrawingModelのpolyline memberAxisModel経路長が不正です。');
    }
    const [originX, originY] = points[0];
    if (!points.some(([x, y]) => Math.hypot(x - originX, y - originY) > 1e-9)) {
      throw new RangeError('DrawingModelのpolyline memberAxisModel平面長さが0です。');
    }
    return Object.freeze({
      kind: 'polyline-member-axis',
      points,
      distances: Object.freeze(distances),
      totalLength,
      units: 'mm',
    });
  }

  throw new TypeError('DrawingModelのmemberAxisModelが不正です。');
}

function indexElementRecords(drawing) {
  const records = new Map();
  for (const record of drawing.elements || []) {
    if (typeof record?.key !== 'string' || !record.key)
      throw new TypeError('部材record keyが必要です。');
    if (records.has(record.key)) throw new Error(`部材record keyが重複しています: ${record.key}`);
    if (elementRefKey(record.ref) !== record.key) {
      throw new Error(`部材record keyとsourceRefが一致しません: ${record.key}`);
    }
    records.set(record.key, record);
  }
  return records;
}

function createEmptyElementPlan(record, layerId, displaySettings) {
  const renderType = record.renderType || record.ref.elementType;
  const visibilitySource = record.visibilitySource || renderType;
  return {
    key: record.key,
    layerId,
    sourceRef: normalizeSourceRef(record.ref),
    renderType,
    visibilitySource,
    visible:
      displaySettings?.visibility?.[visibilitySource] !== false &&
      displaySettings?.visibility?.[renderType] !== false,
    mark: record.mark || '',
    sectionId: record.sectionId == null ? null : String(record.sectionId),
    state: record.state || 'unknown',
    taggable: record.taggable !== false,
    parentElementKey: record.parentElementKey || null,
    memberAxisModel: normalizeMemberAxisModel(record.memberAxisModel),
    primitiveIds: [],
    boundsModel: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  };
}

function finalizeElementPlan(element, modelToPaper) {
  const boundsModel = finalizeBounds(element.boundsModel);
  const anchorModel = boundsModel
    ? [(boundsModel.minX + boundsModel.maxX) / 2, (boundsModel.minY + boundsModel.maxY) / 2]
    : null;
  return Object.freeze({
    ...element,
    boundsModel,
    anchor: anchorModel
      ? Object.freeze({
          kind: 'member-bounds-center',
          model: freezePoint(anchorModel),
          paper: freezePoint(transformPoint(modelToPaper, anchorModel)),
        })
      : null,
  });
}

function compileMemberPrimitive({ primitive, primitiveIndex, record, layerId, modelToPaper }) {
  if (primitive.kind !== 'polyline') throw new TypeError(`未対応の図形です: ${primitive.kind}`);
  if (!Array.isArray(primitive.points) || primitive.points.length < 2) {
    throw new TypeError('polylineには2点以上の点列が必要です。');
  }
  if (record.state !== 'drawn') {
    throw new Error(`描画対象外recordにprimitiveが接続されています: ${record.key}`);
  }
  if (elementRefKey(primitive.ref) !== record.key) {
    throw new Error(
      `primitiveのsourceRefがrecordと一致しません: ${primitive.id || primitiveIndex}`,
    );
  }
  const pointsModel = primitive.points.map((point) => assertPoint(point));
  const pointsPaper = pointsModel.map((point) => transformPoint(modelToPaper, point));
  const id = String(primitive.id || `primitive:${primitiveIndex}`);
  return Object.freeze({
    id,
    sourcePrimitiveId: primitive.id == null ? null : String(primitive.id),
    kind: 'polyline',
    role: primitive.role || 'member-outline',
    layerId,
    elementKey: record.key,
    sourceRef: normalizeSourceRef(primitive.ref),
    closed: primitive.closed === true,
    points: Object.freeze({
      model: freezePoints(pointsModel),
      paper: freezePoints(pointsPaper),
    }),
    sectionPart: Number.isInteger(primitive.sectionPart) ? primitive.sectionPart : null,
    cutZ: Number.isFinite(primitive.cutZ) ? primitive.cutZ : null,
    parentElementKey: primitive.parentElementKey || null,
  });
}

function compileAnnotation({
  annotation,
  annotationIndex,
  layerId,
  visibilitySource,
  visible,
  style,
  modelToPaper,
}) {
  const id = String(annotation.id || `annotation:${annotationIndex}`);
  if (annotation.kind === 'line') {
    if (!Array.isArray(annotation.points) || annotation.points.length !== 2) {
      throw new TypeError('注記lineには2点の点列が必要です。');
    }
    const pointsModel = annotation.points.map((point) => assertPoint(point));
    return Object.freeze({
      id,
      ...(annotation.measurementId ? { measurementId: String(annotation.measurementId) } : {}),
      kind: 'line',
      role: annotation.role || 'annotation',
      layerId,
      visibilitySource,
      visible,
      style,
      points: Object.freeze({
        model: freezePoints(pointsModel),
        paper: freezePoints(pointsModel.map((point) => transformPoint(modelToPaper, point))),
      }),
    });
  }
  if (annotation.kind === 'circle') {
    const centerModel = assertPoint(annotation.center);
    const radiusModel = normalizePositiveNumber(annotation.radius, '注記circle半径', null);
    const modelToPaperScale = Math.hypot(modelToPaper[0], modelToPaper[1]);
    if (!Number.isFinite(modelToPaperScale) || modelToPaperScale <= 0)
      throw new TypeError('注記circleのmodel→paper縮尺が不正です。');
    return Object.freeze({
      id,
      kind: 'circle',
      role: annotation.role || 'annotation-circle',
      layerId,
      visibilitySource,
      visible,
      style,
      center: Object.freeze({
        model: freezePoint(centerModel),
        paper: freezePoint(transformPoint(modelToPaper, centerModel)),
      }),
      radius: Object.freeze({
        model: radiusModel,
        paper: radiusModel * modelToPaperScale,
      }),
    });
  }
  if (annotation.kind === 'text') {
    const pointModel = assertPoint(annotation.point);
    const rotationPaper = Number.isFinite(annotation.rotationDeg) ? -annotation.rotationDeg : 0;
    return Object.freeze({
      id,
      ...(annotation.measurementId ? { measurementId: String(annotation.measurementId) } : {}),
      kind: 'text',
      role: annotation.role || 'annotation-text',
      layerId,
      visibilitySource,
      visible,
      style,
      text: String(annotation.text || ''),
      anchor: annotation.anchor || 'middle',
      rotationDeg: Object.freeze({
        model: Number.isFinite(annotation.rotationDegModel)
          ? annotation.rotationDegModel
          : rotationPaper,
        paper: rotationPaper,
      }),
      point: Object.freeze({
        model: freezePoint(pointModel),
        paper: freezePoint(transformPoint(modelToPaper, pointModel)),
      }),
    });
  }
  throw new TypeError(`未対応の注記図形です: ${annotation.kind}`);
}

function normalizeReferenceDrawings(referenceDrawings) {
  if (!Array.isArray(referenceDrawings))
    throw new TypeError('referenceDrawingsは配列で指定してください。');
  return referenceDrawings.map((referenceDrawing) => assertReferenceDrawing(referenceDrawing));
}

function rgbToHex(value, fallback = '#6c757d') {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 0xffffff) return fallback;
  // dxf-parserのlayer.color / entity.colorはACIをRGBへ解決した24bit値。
  // 青(0x0000ff=255)のような小さいRGB値をACI番号と再解釈してはならない。
  return `#${number.toString(16).padStart(6, '0')}`;
}

function stableAsciiHash(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function referenceLayerId(referenceDrawing, sourceLayerId) {
  const documentId = String(referenceDrawing.source.documentId);
  const sourceName = String(sourceLayerId || '0');
  const readable =
    sourceName
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9_.-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 7) || 'LAYER';
  // R12のlayer name制約を避けるため内部IDはASCII 31文字以内とし、
  // document/layer双方のhashを含めて別ファイルの同名layerも衝突させない。
  return `DXF_${stableAsciiHash(documentId)}_${stableAsciiHash(sourceName)}_${readable}`;
}

function referenceSettingsFor(referenceDisplaySettings, documentId) {
  const settings = referenceDisplaySettings?.[documentId] || {};
  const opacity = Number(settings.opacity);
  return Object.freeze({
    visible: settings.visible !== false,
    opacity: Number.isFinite(opacity) && opacity >= 0 && opacity <= 1 ? opacity : 1,
    color:
      typeof settings.color === 'string' && settings.color.trim() ? settings.color.trim() : null,
    layers: settings.layers && typeof settings.layers === 'object' ? settings.layers : null,
  });
}

function modelToPaperScale(matrix) {
  const scale = Math.hypot(matrix[0], matrix[1]);
  if (!Number.isFinite(scale) || scale <= 0)
    throw new TypeError('reference geometryのmodel→paper縮尺が不正です。');
  return scale;
}

function referenceTextRotationPaper(matrix, rotationDeg) {
  const radians = (Number(rotationDeg || 0) * Math.PI) / 180;
  const x = Math.cos(radians);
  const y = Math.sin(radians);
  const tx = matrix[0] * x + matrix[2] * y;
  const ty = matrix[1] * x + matrix[3] * y;
  // RenderPlanの文字角はSVG/CSSと同じく「画面上の時計回り」を正とする。
  return (-Math.atan2(ty, tx) * 180) / Math.PI;
}

function compileReferencePrimitive({
  primitive,
  referenceDrawing,
  layerId,
  modelToPaper,
  opacity,
  colorOverride = null,
}) {
  const sourceStyle = primitive.style || null;
  const sourceStrokeColor = rgbToHex(sourceStyle?.colorRgb, null);
  const sourceDashPatternMm = Array.isArray(sourceStyle?.dashPatternMm)
    ? sourceStyle.dashPatternMm
    : null;
  const paperDashPatternMm = sourceDashPatternMm
    ? Object.freeze(sourceDashPatternMm.map((value) => value * modelToPaperScale(modelToPaper)))
    : null;
  const common = {
    id: `reference:${referenceDrawing.source.documentId}:${primitive.id}`,
    sourcePrimitiveId: primitive.id,
    role: primitive.role || 'reference-geometry',
    layerId,
    referenceDocumentId: referenceDrawing.source.documentId,
    sourceRef: primitive.sourceRef,
    visible: true,
    opacity,
    style:
      sourceStyle || colorOverride || sourceStrokeColor
        ? Object.freeze({
            ...(sourceStyle || {}),
            strokeColor: colorOverride || sourceStrokeColor,
            dashPatternMm: paperDashPatternMm,
          })
        : null,
  };
  if (primitive.kind === 'line' || primitive.kind === 'polyline') {
    const model = primitive.points.map((point) => freezePoint(point));
    const paper = primitive.points.map((point) => freezePoint(transformPoint(modelToPaper, point)));
    return Object.freeze({
      ...common,
      kind: primitive.kind,
      closed: primitive.kind === 'polyline' ? primitive.closed === true : false,
      bulges:
        primitive.kind === 'polyline'
          ? Object.freeze([...(primitive.bulges || primitive.points.map(() => 0))])
          : null,
      points: Object.freeze({ model: Object.freeze(model), paper: Object.freeze(paper) }),
    });
  }
  if (primitive.kind === 'circle') {
    const scale = modelToPaperScale(modelToPaper);
    return Object.freeze({
      ...common,
      kind: 'circle',
      center: Object.freeze({
        model: freezePoint(primitive.center),
        paper: freezePoint(transformPoint(modelToPaper, primitive.center)),
      }),
      radius: Object.freeze({ model: primitive.radius, paper: primitive.radius * scale }),
    });
  }
  if (primitive.kind === 'arc') {
    const scale = modelToPaperScale(modelToPaper);
    return Object.freeze({
      ...common,
      kind: 'arc',
      center: Object.freeze({
        model: freezePoint(primitive.center),
        paper: freezePoint(transformPoint(modelToPaper, primitive.center)),
      }),
      startPoint: Object.freeze({
        model: freezePoint(primitive.startPoint),
        paper: freezePoint(transformPoint(modelToPaper, primitive.startPoint)),
      }),
      endPoint: Object.freeze({
        model: freezePoint(primitive.endPoint),
        paper: freezePoint(transformPoint(modelToPaper, primitive.endPoint)),
      }),
      radius: Object.freeze({ model: primitive.radius, paper: primitive.radius * scale }),
      clockwise: primitive.clockwise === true,
    });
  }
  if (primitive.kind === 'text') {
    const scale = modelToPaperScale(modelToPaper);
    return Object.freeze({
      ...common,
      kind: 'text',
      point: Object.freeze({
        model: freezePoint(primitive.point),
        paper: freezePoint(transformPoint(modelToPaper, primitive.point)),
      }),
      text: String(primitive.text || ''),
      rawText: primitive.rawText == null ? null : String(primitive.rawText),
      textHeight: Object.freeze({
        model: primitive.heightMm,
        paper: primitive.heightMm * scale,
      }),
      widthFactor:
        Number.isFinite(primitive.widthFactor) && primitive.widthFactor > 0
          ? primitive.widthFactor
          : 1,
      obliqueDeg: Number.isFinite(primitive.obliqueDeg) ? primitive.obliqueDeg : 0,
      rotationDeg: Object.freeze({
        model: -Number(primitive.rotationDeg || 0),
        paper: referenceTextRotationPaper(modelToPaper, primitive.rotationDeg),
      }),
      anchor: primitive.anchor || Object.freeze({ horizontal: 'left', vertical: 'baseline' }),
      mirrorX: primitive.mirrorX === true,
      mirrorY: primitive.mirrorY === true,
      mirrored:
        primitive.mirrored === true || primitive.mirrorX === true || primitive.mirrorY === true,
      mtext: primitive.mtext === true,
    });
  }
  throw new TypeError(`DrawingRenderPlan未対応のreference primitiveです: ${primitive.kind}`);
}

function extendReferenceBounds(bounds, primitive, space) {
  if (primitive.kind === 'line' || primitive.kind === 'polyline') {
    extendBounds(bounds, primitive.points[space]);
    return;
  }
  if (primitive.kind === 'circle' || primitive.kind === 'arc') {
    const center = primitive.center[space];
    const radius = primitive.radius[space];
    extendBounds(bounds, [
      [center[0] - radius, center[1] - radius],
      [center[0] + radius, center[1] + radius],
    ]);
    return;
  }
  if (primitive.kind === 'text') extendBounds(bounds, [primitive.point[space]]);
}

function normalizeAdditionalDimensionGroup(dimension, index, displaySettings) {
  if (!dimension || typeof dimension !== 'object' || Array.isArray(dimension))
    throw new TypeError(`additionalDimensions[${index}]が不正です。`);
  if (typeof dimension.id !== 'string' || !dimension.id.trim())
    throw new TypeError(`additionalDimensions[${index}].idが必要です。`);
  if (!Array.isArray(dimension.primitives))
    throw new TypeError(`additionalDimensions[${index}].primitivesは配列が必要です。`);
  const layerId = sanitizeLayerId(dimension.layerId, 'Annotation');
  const visibilitySource = sanitizeLayerId(dimension.visibilitySource, layerId);
  return Object.freeze({
    ...dimension,
    id: dimension.id.trim(),
    layerId,
    visibilitySource,
    visible:
      dimension.visible !== false && displaySettings?.visibility?.[visibilitySource] !== false,
    primitives: Object.freeze([...dimension.primitives]),
  });
}

/**
 * DrawingModelから形式非依存のDrawingRenderPlanを作る。
 * ここではDOM/CSS/PDF viewport/Three.js sceneを入力に取らない。
 */
export function compileDrawingRenderPlan({
  drawing = null,
  additionalAnnotations = [],
  additionalDimensions = [],
  referenceDrawings = [],
  referenceDisplaySettings = {},
  profile = {},
  displaySettings = {},
  tagOptions = null,
} = {}) {
  const normalizedReferences = normalizeReferenceDrawings(referenceDrawings);
  if (drawing == null && normalizedReferences.length === 0)
    throw new TypeError('DrawingModelまたはReferenceDrawingが1つ以上必要です。');
  const sourceDrawing = drawing == null ? null : normalizeDrawingModel(drawing);
  const normalizedProfile = normalizeDrawingRenderProfile(profile);
  const modelToPaper = normalizedProfile.modelToPaper;
  const records = sourceDrawing ? indexElementRecords(sourceDrawing) : new Map();
  const layers = new Map();
  const elementPlans = new Map();
  const primitives = [];
  const primitiveIds = new Set();

  for (const [primitiveIndex, primitive] of (sourceDrawing?.primitives || []).entries()) {
    const record = records.get(primitive.elementKey);
    if (!record)
      throw new Error(`primitiveの参照先recordが見つかりません: ${primitive.elementKey}`);
    const layerId = memberLayerId(record);
    registerLayer(layers, layerId, 'member', displaySettings, {
      sourceElementType: record.ref.elementType,
    });
    const compiled = compileMemberPrimitive({
      primitive,
      primitiveIndex,
      record,
      layerId,
      modelToPaper,
    });
    if (primitiveIds.has(compiled.id))
      throw new Error(`primitive IDが重複しています: ${compiled.id}`);
    primitiveIds.add(compiled.id);
    primitives.push(compiled);
    let element = elementPlans.get(record.key);
    if (!element) {
      element = createEmptyElementPlan(record, layerId, displaySettings);
      elementPlans.set(record.key, element);
    }
    element.primitiveIds.push(compiled.id);
    extendBounds(element.boundsModel, compiled.points.model);
  }

  for (const record of records.values()) {
    const layerId = memberLayerId(record);
    registerLayer(layers, layerId, 'member', displaySettings, {
      sourceElementType: record.ref.elementType,
    });
    if (!elementPlans.has(record.key)) {
      elementPlans.set(record.key, createEmptyElementPlan(record, layerId, displaySettings));
    }
  }

  const annotations = [];
  const sourceAnnotations = [...(sourceDrawing?.annotations || []), ...additionalAnnotations];
  for (const [annotationIndex, annotation] of sourceAnnotations.entries()) {
    const layerId = annotationLayerId(annotation);
    const visibilitySource = annotationVisibilitySource(annotation);
    const visible = displaySettings?.visibility?.[visibilitySource] !== false;
    const style = normalizeAnnotationStyle(
      annotation,
      displaySettings,
      normalizedProfile.textStyle,
    );
    registerLayer(layers, layerId, layerId === 'Axis' ? 'axis' : 'annotation', displaySettings);
    annotations.push(
      compileAnnotation({
        annotation,
        annotationIndex,
        layerId,
        visibilitySource,
        visible,
        style,
        modelToPaper,
      }),
    );
  }

  if (!Array.isArray(additionalDimensions))
    throw new TypeError('additionalDimensionsは配列で指定してください。');
  const sourceDimensions =
    sourceDrawing == null
      ? Object.freeze([])
      : compileDrawingRenderDimensions({
          drawing: sourceDrawing,
          modelToPaper,
          displaySettings,
        });
  const dimensions = Object.freeze([
    ...sourceDimensions,
    ...additionalDimensions.map((dimension, index) =>
      normalizeAdditionalDimensionGroup(dimension, index, displaySettings),
    ),
  ]);
  const dimensionIds = new Set();
  for (const dimension of dimensions) {
    if (dimensionIds.has(dimension.id))
      throw new TypeError(`DrawingRenderPlan dimension idが重複しています: ${dimension.id}`);
    dimensionIds.add(dimension.id);
    registerLayer(layers, dimension.layerId, 'annotation', displaySettings);
  }

  const references = [];
  const referencePrimitives = [];
  for (const referenceDrawing of normalizedReferences) {
    const settings = referenceSettingsFor(
      referenceDisplaySettings,
      referenceDrawing.source.documentId,
    );
    references.push(
      Object.freeze({
        source: referenceDrawing.source,
        transform: referenceDrawing.transform,
        bounds: referenceDrawing.bounds,
        stats: referenceDrawing.stats,
        visible: settings.visible,
        opacity: settings.opacity,
      }),
    );
    const sourceLayerById = new Map(referenceDrawing.layers.map((layer) => [layer.id, layer]));
    for (const sourceLayer of referenceDrawing.layers) {
      const layerId = referenceLayerId(referenceDrawing, sourceLayer.id);
      const sourceLayerVisible =
        settings.layers?.[sourceLayer.id] !== false && sourceLayer.visible !== false;
      registerLayer(layers, layerId, 'reference', displaySettings, {
        visible: settings.visible && sourceLayerVisible,
        referenceDocumentId: referenceDrawing.source.documentId,
        sourceLayerId: sourceLayer.id,
        opacity: settings.opacity,
        style: Object.freeze({
          ...DEFAULT_STYLE,
          strokeColor: settings.color || rgbToHex(sourceLayer.colorRgb),
          fillColor: null,
          fillOpacity: 0,
        }),
      });
    }
    for (const primitive of referenceDrawing.primitives) {
      const sourceLayer = sourceLayerById.get(primitive.layerId);
      const layerId = referenceLayerId(referenceDrawing, primitive.layerId);
      if (!sourceLayerById.has(primitive.layerId)) {
        registerLayer(layers, layerId, 'reference', displaySettings, {
          visible: settings.visible && settings.layers?.[primitive.layerId] !== false,
          referenceDocumentId: referenceDrawing.source.documentId,
          sourceLayerId: primitive.layerId,
          opacity: settings.opacity,
          style: Object.freeze({
            ...DEFAULT_STYLE,
            strokeColor: settings.color || '#6c757d',
            fillColor: null,
            fillOpacity: 0,
          }),
        });
      }
      const compiled = compileReferencePrimitive({
        primitive,
        referenceDrawing,
        layerId,
        modelToPaper,
        opacity: settings.opacity,
        colorOverride: settings.color,
      });
      referencePrimitives.push(compiled);
      if (sourceLayer?.visible === false) continue;
    }
  }

  const boundsModelAccumulator = primitives.reduce(
    (bounds, primitive) => {
      extendBounds(bounds, primitive.points.model);
      return bounds;
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  for (const primitive of referencePrimitives)
    extendReferenceBounds(boundsModelAccumulator, primitive, 'model');
  const boundsModel = finalizeBounds(boundsModelAccumulator);
  const boundsPaperAccumulator = primitives.reduce(
    (bounds, primitive) => {
      extendBounds(bounds, primitive.points.paper);
      return bounds;
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  for (const primitive of referencePrimitives)
    extendReferenceBounds(boundsPaperAccumulator, primitive, 'paper');
  const boundsPaper = finalizeBounds(boundsPaperAccumulator);

  const geometry = {
    schemaVersion: DRAWING_RENDER_PLAN_SCHEMA_VERSION,
    kind: 'DrawingRenderPlan',
    units: Object.freeze({ model: 'mm', paper: 'mm', angle: 'degree' }),
    source: sourceDrawing
      ? Object.freeze({ ...sourceDrawing.source })
      : Object.freeze({
          kind: 'reference-only',
          referenceDocumentIds: Object.freeze(
            normalizedReferences.map((referenceDrawing) => referenceDrawing.source.documentId),
          ),
        }),
    view: sourceDrawing
      ? Object.freeze({ ...sourceDrawing.view })
      : Object.freeze({ type: 'reference', units: 'mm' }),
    profile: normalizedProfile,
    layers: Object.freeze([...layers.values()]),
    elements: Object.freeze(
      [...elementPlans.values()].map((element) => finalizeElementPlan(element, modelToPaper)),
    ),
    primitives: Object.freeze(primitives),
    referencePrimitives: Object.freeze(referencePrimitives),
    references: Object.freeze(references),
    annotations: Object.freeze(annotations),
    dimensions,
    diagnostics: Object.freeze([
      ...(sourceDrawing?.diagnostics || []).map((diagnostic, index) =>
        Object.freeze({ id: `drawing-diagnostic:${index}`, ...diagnostic }),
      ),
      ...normalizedReferences.flatMap((referenceDrawing) =>
        (referenceDrawing.diagnostics || []).map((diagnostic, index) =>
          Object.freeze({
            id: `reference-diagnostic:${referenceDrawing.source.documentId}:${index}`,
            referenceDocumentId: referenceDrawing.source.documentId,
            ...diagnostic,
          }),
        ),
      ),
    ]),
    bounds: Object.freeze({ model: boundsModel, paper: boundsPaper }),
  };
  const tags =
    sourceDrawing == null || tagOptions == null
      ? null
      : compileDrawingRenderTags({
          drawing: sourceDrawing,
          renderPlanGeometry: geometry,
          displaySettings,
          ...tagOptions,
        });
  return Object.freeze({
    ...geometry,
    tags,
  });
}
