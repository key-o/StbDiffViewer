/**
 * @fileoverview STBに依存しない参照図面（DXF等）の正規化契約。
 *
 * ReferenceDrawingはread-only参照原本から再生成可能な派生geometryを表す。
 * STB部材IDを付与せず、documentId/revision/source entityで出典を保持する。
 */
import { assertMatrix, assertPoint } from './affine2d.js';

export const REFERENCE_DRAWING_SCHEMA_VERSION = 1;
export const REFERENCE_SOURCE_KIND_DXF = 'dxf';

const RESULT_STATUSES = new Set(['supported', 'approximated', 'unsupported', 'failed']);

function requiredString(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new TypeError(`${label}が必要です。`);
  return normalized;
}

export function createReferenceDrawingSource({
  kind = REFERENCE_SOURCE_KIND_DXF,
  documentId,
  revision,
  filename = null,
  profileId,
} = {}) {
  return Object.freeze({
    kind: requiredString(kind, '参照図面source kind'),
    documentId: requiredString(documentId, '参照図面documentId'),
    revision: requiredString(revision, '参照図面revision'),
    filename: filename == null ? null : String(filename),
    profileId: requiredString(profileId, '参照図面profileId'),
  });
}

export function createDxfEntitySourceRef(
  source,
  { entityType, entityId, handle = null, layer = '0', blockOccurrence = [], blockName = null } = {},
) {
  if (source?.kind !== REFERENCE_SOURCE_KIND_DXF)
    throw new TypeError('DXF sourceRefにはDXF参照図面sourceが必要です。');
  if (!Array.isArray(blockOccurrence)) throw new TypeError('blockOccurrenceは配列が必要です。');
  return Object.freeze({
    kind: 'dxf-entity',
    documentId: requiredString(source.documentId, 'DXF documentId'),
    revision: requiredString(source.revision, 'DXF revision'),
    entityType: requiredString(entityType, 'DXF entityType'),
    entityId: requiredString(entityId, 'DXF entityId'),
    handle: handle == null ? null : String(handle),
    layer: requiredString(String(layer || '0'), 'DXF layer'),
    blockOccurrence: Object.freeze(blockOccurrence.map((value) => String(value))),
    blockName: blockName == null ? null : String(blockName),
  });
}

export function referenceSourceRefKey(ref) {
  if (ref?.kind !== 'dxf-entity') throw new TypeError('DXF sourceRefが必要です。');
  return JSON.stringify([
    ref.kind,
    requiredString(ref.documentId, 'DXF documentId'),
    requiredString(ref.revision, 'DXF revision'),
    ...(Array.isArray(ref.blockOccurrence) ? ref.blockOccurrence.map(String) : []),
    requiredString(ref.entityType, 'DXF entityType'),
    requiredString(ref.entityId, 'DXF entityId'),
  ]);
}

export function assertReferenceDrawing(referenceDrawing) {
  if (
    referenceDrawing?.kind !== 'ReferenceDrawing' ||
    referenceDrawing.schemaVersion !== REFERENCE_DRAWING_SCHEMA_VERSION ||
    referenceDrawing.units !== 'mm'
  ) {
    throw new TypeError('ReferenceDrawing v1 (mm)が必要です。');
  }
  createReferenceDrawingSource(referenceDrawing.source);
  assertMatrix(referenceDrawing.transform?.sourceToModel);
  if (!Array.isArray(referenceDrawing.layers))
    throw new TypeError('ReferenceDrawing layersが不正です。');
  if (!Array.isArray(referenceDrawing.primitives))
    throw new TypeError('ReferenceDrawing primitivesが不正です。');
  if (!Array.isArray(referenceDrawing.entityResults))
    throw new TypeError('ReferenceDrawing entityResultsが不正です。');

  const ids = new Set();
  for (const primitive of referenceDrawing.primitives) {
    const id = requiredString(primitive?.id, 'ReferenceDrawing primitive id');
    if (ids.has(id)) throw new Error(`ReferenceDrawing primitive IDが重複しています: ${id}`);
    ids.add(id);
    referenceSourceRefKey(primitive.sourceRef);
    if (primitive.kind === 'line') {
      if (!Array.isArray(primitive.points) || primitive.points.length !== 2)
        throw new TypeError('ReferenceDrawing lineには2点が必要です。');
      primitive.points.forEach(assertPoint);
    } else if (primitive.kind === 'polyline') {
      if (!Array.isArray(primitive.points) || primitive.points.length < 2)
        throw new TypeError('ReferenceDrawing polylineには2点以上が必要です。');
      primitive.points.forEach(assertPoint);
    } else if (primitive.kind === 'circle') {
      assertPoint(primitive.center);
      if (!Number.isFinite(primitive.radius) || primitive.radius <= 0)
        throw new TypeError('ReferenceDrawing circle半径が不正です。');
    } else if (primitive.kind === 'arc') {
      assertPoint(primitive.center);
      assertPoint(primitive.startPoint);
      assertPoint(primitive.endPoint);
      if (!Number.isFinite(primitive.radius) || primitive.radius <= 0)
        throw new TypeError('ReferenceDrawing arc半径が不正です。');
    } else if (primitive.kind === 'text') {
      assertPoint(primitive.point);
      if (!Number.isFinite(primitive.heightMm) || primitive.heightMm <= 0)
        throw new TypeError('ReferenceDrawing text高さが不正です。');
      if (
        primitive.widthFactor != null &&
        (!Number.isFinite(primitive.widthFactor) || primitive.widthFactor <= 0)
      )
        throw new TypeError('ReferenceDrawing text幅係数が不正です。');
      if (primitive.mirrorX != null && typeof primitive.mirrorX !== 'boolean')
        throw new TypeError('ReferenceDrawing text mirrorXが不正です。');
      if (primitive.mirrorY != null && typeof primitive.mirrorY !== 'boolean')
        throw new TypeError('ReferenceDrawing text mirrorYが不正です。');
      if (primitive.obliqueDeg != null && !Number.isFinite(primitive.obliqueDeg))
        throw new TypeError('ReferenceDrawing text斜体角が不正です。');
    } else {
      throw new TypeError(`ReferenceDrawing未対応primitiveです: ${primitive.kind}`);
    }
  }

  for (const result of referenceDrawing.entityResults) {
    if (!RESULT_STATUSES.has(result?.status))
      throw new TypeError(`ReferenceDrawing entity result statusが不正です: ${result?.status}`);
    referenceSourceRefKey(result.sourceRef);
  }
  return referenceDrawing;
}
