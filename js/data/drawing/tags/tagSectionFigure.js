/**
 * @fileoverview タグ用断面図(豆図)の値契約と紙面mm展開。XML/DOMを読まない。
 *
 * 断面図は1つ以上のパネル(柱は1断面、梁は端部/中央など断面リストの位置列)で構成する。
 * 各パネルの図形はモデルmmで、断面中心を原点、X右向き・Y下向き(断面リストSVGと同じ見え方)。
 */

import { estimateTagTextWidth } from './tagPlacementLayout.js';

export const SECTION_FIGURE_ROLES = Object.freeze([
  'concrete',
  'hoop',
  'tie',
  'main-bar',
  'core-bar',
  'web-bar',
]);
const SHAPE_TYPES = Object.freeze(['rect', 'circle', 'line']);
const MAX_PANELS = 6;
const MAX_SHAPES = 2000;
const PANEL_KEY = /^[A-Z0-9_]{1,32}$/;
/** パネル間の紙面上の間隔(mm)と、位置ラベルを図の下に置く距離(文字高に対する比)。 */
export const SECTION_FIGURE_PANEL_GAP_MM = 3;
const LABEL_OFFSET_RATIO = 1.1;
/** 位置ラベル・配筋文字の行送り(文字高に対する比)。 */
const LINE_HEIGHT_RATIO = 1.35;
const MAX_CAPTIONS = 8;

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`断面図${name}が不正です。`);
  return value;
}

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`断面図${name}が不正です。`);
  return value;
}

function normalizeShape(shape, index) {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape))
    throw new TypeError(`断面図shapes[${index}]が不正です。`);
  if (!SHAPE_TYPES.includes(shape.type) || !SECTION_FIGURE_ROLES.includes(shape.role))
    throw new TypeError(`断面図shapes[${index}]の種別または役割が不正です。`);
  const name = `shapes[${index}]`;
  if (shape.type === 'rect')
    return Object.freeze({
      type: 'rect',
      role: shape.role,
      x: finite(shape.x, `${name}.x`),
      y: finite(shape.y, `${name}.y`),
      width: positive(shape.width, `${name}.width`),
      height: positive(shape.height, `${name}.height`),
    });
  if (shape.type === 'circle')
    return Object.freeze({
      type: 'circle',
      role: shape.role,
      cx: finite(shape.cx, `${name}.cx`),
      cy: finite(shape.cy, `${name}.cy`),
      r: positive(shape.r, `${name}.r`),
      filled: shape.filled === true,
    });
  return Object.freeze({
    type: 'line',
    role: shape.role,
    x1: finite(shape.x1, `${name}.x1`),
    y1: finite(shape.y1, `${name}.y1`),
    x2: finite(shape.x2, `${name}.x2`),
    y2: finite(shape.y2, `${name}.y2`),
  });
}

function normalizePanel(input, index) {
  const name = `panels[${index}]`;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError(`断面図${name}が不正です。`);
  if (typeof input.key !== 'string' || !PANEL_KEY.test(input.key))
    throw new TypeError(`断面図${name}.keyが不正です。`);
  const label = input.label ?? null;
  if (label !== null && (typeof label !== 'string' || !label.trim() || label.length > 20))
    throw new TypeError(`断面図${name}.labelが不正です。`);
  if (!Array.isArray(input.shapes) || input.shapes.length === 0 || input.shapes.length > MAX_SHAPES)
    throw new TypeError(`断面図${name}.shapesが不正です。`);
  const captions = input.captions ?? [];
  if (
    !Array.isArray(captions) ||
    captions.length > MAX_CAPTIONS ||
    captions.some(
      (caption) => typeof caption !== 'string' || !caption.trim() || caption.length > 60,
    )
  )
    throw new TypeError(`断面図${name}.captionsが不正です。`);
  const shapes = input.shapes.map(normalizeShape);
  if (!shapes.some((shape) => shape.role === 'concrete'))
    throw new TypeError(`断面図${name}にはコンクリート外形が必要です。`);
  return Object.freeze({
    key: input.key,
    label,
    width: positive(input.width, `${name}.width`),
    height: positive(input.height, `${name}.height`),
    shapes: Object.freeze(shapes),
    captions: Object.freeze([...captions]),
  });
}

/** JSON化可能な断面図値を検証し、凍結snapshotを返す。 */
export function normalizeSectionFigure(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('断面図の値が必要です。');
  if (!Array.isArray(input.panels) || input.panels.length === 0 || input.panels.length > MAX_PANELS)
    throw new TypeError('断面図panelsが不正です。');
  const panels = input.panels.map(normalizePanel);
  if (new Set(panels.map((panel) => panel.key)).size !== panels.length)
    throw new TypeError('断面図panelsのkeyが重複しています。');
  return Object.freeze({ panels: Object.freeze(panels) });
}

function shapeItem(shape, id, source, strokeWidth, px, py, scale) {
  if (shape.type === 'rect')
    return Object.freeze({
      id,
      kind: 'frame',
      shape: 'rect',
      rect: Object.freeze([px(shape.x), py(shape.y), shape.width * scale, shape.height * scale]),
      radius: null,
      strokeWidth,
      ...source,
    });
  if (shape.type === 'circle')
    return Object.freeze({
      id,
      kind: 'circle',
      point: Object.freeze([px(shape.cx), py(shape.cy)]),
      radius: shape.r * scale,
      strokeWidth,
      ...(shape.filled ? { filled: true } : {}),
      ...source,
    });
  return Object.freeze({
    id,
    kind: 'line',
    points: Object.freeze([
      Object.freeze([px(shape.x1), py(shape.y1)]),
      Object.freeze([px(shape.x2), py(shape.y2)]),
    ]),
    strokeWidth,
    ...source,
  });
}

function textItem(id, text, point, primitive) {
  return Object.freeze({
    id,
    kind: 'text',
    point: Object.freeze(point),
    text,
    fontSize: primitive.fontSize,
    strokeWidth: 0,
    textAnchor: 'middle',
    sourcePrimitiveId: primitive.id,
  });
}

/**
 * 断面図をTagRenderPlan v2の紙面mm item(frame/circle/line/text)へ展開する。
 * primitiveの(x, y)はパネル群の上辺中央。パネルは上端をそろえて左から並べ、
 * 位置ラベルと配筋文字(captions)を最も高いパネルの下にそろえて置く。
 * 列幅は図と文字の広い方とし、隣のパネルの文字と重ならないようにする。
 * 縮尺は 1/scaleDenominator で紙面上に固定する。
 * @param {object} figure normalizeSectionFigure済みの値
 * @param {{id:string,x:number,y:number,scaleDenominator:number,strokeWidth:number,fontSize:number}} primitive
 */
export function sectionFigurePlanItems(figure, primitive) {
  const scale = 1 / primitive.scaleDenominator;
  const detailStroke = primitive.strokeWidth / 2;
  const columnWidths = figure.panels.map((panel) =>
    Math.max(
      panel.width * scale,
      ...[panel.label, ...panel.captions]
        .filter(Boolean)
        .map((text) => estimateTagTextWidth(text, primitive.fontSize)),
    ),
  );
  const totalWidth =
    columnWidths.reduce((sum, width) => sum + width, 0) +
    SECTION_FIGURE_PANEL_GAP_MM * (figure.panels.length - 1);
  const maxHeight = Math.max(...figure.panels.map((panel) => panel.height * scale));
  const firstLineY = primitive.y + maxHeight + primitive.fontSize * LABEL_OFFSET_RATIO;
  const lineHeight = primitive.fontSize * LINE_HEIGHT_RATIO;
  const items = [];
  let left = primitive.x - totalWidth / 2;
  figure.panels.forEach((panel, panelIndex) => {
    const centerX = left + columnWidths[panelIndex] / 2;
    const px = (x) => centerX + x * scale;
    const py = (y) => primitive.y + (y + panel.height / 2) * scale;
    panel.shapes.forEach((shape, index) => {
      const strokeWidth = shape.role === 'concrete' ? primitive.strokeWidth : detailStroke;
      const source = { sourcePrimitiveId: primitive.id, figureRole: shape.role };
      items.push(
        shapeItem(
          shape,
          `${primitive.id}:${panel.key}:${index}:${shape.role}`,
          source,
          strokeWidth,
          px,
          py,
          scale,
        ),
      );
    });
    let lineY = firstLineY;
    if (panel.label) {
      items.push(
        textItem(`${primitive.id}:${panel.key}:label`, panel.label, [centerX, lineY], primitive),
      );
      lineY += lineHeight;
    }
    panel.captions.forEach((caption, index) => {
      items.push(
        textItem(
          `${primitive.id}:${panel.key}:caption:${index}`,
          caption,
          [centerX, lineY],
          primitive,
        ),
      );
      lineY += lineHeight;
    });
    left += columnWidths[panelIndex] + SECTION_FIGURE_PANEL_GAP_MM;
  });
  return items;
}
