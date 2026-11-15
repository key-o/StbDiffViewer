/**
 * @fileoverview 断面リストの図形（モデルmm）をReferenceDrawingへ変換する。
 *
 * 柱・梁リストのDXF図形生成（build*SectionListEntities）の結果を、シート配置で共通の
 * DrawingRenderPlan（SVG/DXF/ベクタPDF）へ流すための橋渡し。STB部材IDは付与せず、
 * 保存データではなく再生成可能な派生物として扱う。
 */
import {
  REFERENCE_DRAWING_SCHEMA_VERSION,
  REFERENCE_SOURCE_KIND_SECTION_LIST,
  assertReferenceDrawing,
  createReferenceDrawingSource,
} from '../../../data/drawing/referenceDrawing.js';

const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
export const SECTION_LIST_REFERENCE_PROFILE_ID = 'sdv-section-list-v1';

function point(value) {
  return Object.freeze([value.x, value.y]);
}

/**
 * @param {Object} params
 * @param {{lines2D:Array,circles2D:Array,texts2D:Array}} params.entities
 * @param {string} params.documentId 例: リストシートID+領域ID
 * @param {string} params.revision 出典STB改訂ID
 * @returns {Object} ReferenceDrawing v1 (mm)
 */
export function createSectionListReferenceDrawing({ entities, documentId, revision }) {
  const source = createReferenceDrawingSource({
    kind: REFERENCE_SOURCE_KIND_SECTION_LIST,
    documentId,
    revision,
    profileId: SECTION_LIST_REFERENCE_PROFILE_ID,
  });
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const extend = (x, y) => {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  };
  const layerIds = new Set();
  const primitives = [];
  const entityResults = [];
  const add = (kind, entityType, layer, fields) => {
    const id = kind + ':' + primitives.length;
    const sourceRef = Object.freeze({
      kind: 'section-list-entity',
      documentId,
      revision,
      entityType,
      entityId: id,
      layer,
      blockOccurrence: Object.freeze([]),
      blockName: null,
    });
    layerIds.add(layer);
    primitives.push(Object.freeze({ id, kind, layerId: layer, sourceRef, ...fields }));
    entityResults.push(
      Object.freeze({ sourceRef, status: 'supported', primitiveIds: Object.freeze([id]) }),
    );
  };
  for (const line of entities.lines2D || []) {
    add('line', 'LINE', line.layer, {
      points: Object.freeze([point(line.start), point(line.end)]),
    });
    extend(line.start.x, line.start.y);
    extend(line.end.x, line.end.y);
  }
  for (const circle of entities.circles2D || []) {
    if (!(circle.radius > 0)) continue;
    add('circle', 'CIRCLE', circle.layer, {
      center: point(circle.center),
      radius: circle.radius,
    });
    extend(circle.center.x - circle.radius, circle.center.y - circle.radius);
    extend(circle.center.x + circle.radius, circle.center.y + circle.radius);
  }
  for (const text of entities.texts2D || []) {
    if (!text.text) continue;
    add('text', 'TEXT', text.layer, {
      point: point(text.position),
      text: text.text,
      heightMm: text.height,
      widthFactor: text.widthFactor ?? 1,
      anchor: Object.freeze({
        horizontal: text.anchor || 'left',
        vertical: text.verticalAlign || 'baseline',
      }),
    });
    extend(text.position.x, text.position.y);
    // 見出しの文字幅が表より広い場合も配置枠超過を確実に検出する。
    if (Number.isFinite(text.boundsWidthMm) && text.boundsWidthMm > 0)
      extend(text.position.x + text.boundsWidthMm, text.position.y);
  }
  const finite = Object.values(bounds).every(Number.isFinite);
  return assertReferenceDrawing(
    Object.freeze({
      schemaVersion: REFERENCE_DRAWING_SCHEMA_VERSION,
      kind: 'ReferenceDrawing',
      units: 'mm',
      source,
      transform: Object.freeze({ sourceToModel: IDENTITY }),
      layers: Object.freeze(
        [...layerIds].sort().map((id) =>
          Object.freeze({
            id,
            sourceName: id,
            visible: true,
            frozen: false,
            locked: false,
            colorRgb: null,
            lineType: 'CONTINUOUS',
          }),
        ),
      ),
      primitives: Object.freeze(primitives),
      entityResults: Object.freeze(entityResults),
      diagnostics: Object.freeze([]),
      stats: Object.freeze({ primitives: primitives.length }),
      bounds: finite ? Object.freeze(bounds) : null,
    }),
  );
}
