/** @fileoverview TagRenderPlan→SVG。値取得/計算/配置保存/選択状態を所有しない。 */
import { assertPoint } from '../../data/drawing/affine2d.js';
import { assertTagFamilyRenderPlan } from '../../data/drawing/tags/tagFamilyRenderPlan.js';
import { assertTagRenderPlan } from '../../data/drawing/tags/tagRenderPlan.js';
const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_TAG_COLOR = '#075963';

function createSvgNode(document, tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

function assertRenderPlan(plan) {
  if (plan?.schemaVersion === 2) return assertTagFamilyRenderPlan(plan);
  return assertTagRenderPlan(plan);
}

function paperScale(plan, paperMmToCss) {
  if (plan.units === 'css-px') return 1;
  if (plan.units !== 'paper-mm') throw new TypeError(`未対応のタグ単位です: ${plan.units}`);
  if (!Number.isFinite(paperMmToCss) || paperMmToCss <= 0)
    throw new RangeError('紙面mm→CSS座標の倍率を明示してください。');
  const familyScale = plan.schemaVersion === 2 ? plan.paperScale : 1;
  const scale = paperMmToCss * familyScale;
  if (!Number.isFinite(scale) || scale <= 0)
    throw new RangeError('タグ倍率を適用した紙面mm→CSS座標の倍率が不正です。');
  return scale;
}

function scaledPoint(origin, point, scale) {
  const scaled = [origin[0] + point[0] * scale, origin[1] + point[1] * scale];
  if (!scaled.every(Number.isFinite)) throw new TypeError('タグ座標の変換結果が不正です。');
  return assertPoint(scaled);
}

function scaledMagnitude(value, scale, name, { allowZero = false } = {}) {
  const scaled = value * scale;
  if (!Number.isFinite(scaled) || (allowZero ? scaled < 0 : scaled <= 0))
    throw new RangeError(`${name}の紙面mm→CSS座標変換結果が不正です。`);
  return scaled;
}

function renderPaperText(item, origin, scale, document, fontFamily, color) {
  const [x, y] = scaledPoint(origin, item.point, scale);
  const fontSize = scaledMagnitude(item.fontSize ?? 2.8, scale, 'タグ文字サイズ');
  const haloWidth = scaledMagnitude(item.strokeWidth ?? 0.55, scale, 'タグ線幅', {
    allowZero: true,
  });
  const node = createSvgNode(document, 'text', {
    x,
    y,
    'text-anchor': item.textAnchor ?? 'middle',
    'dominant-baseline': 'central',
    'font-size': fontSize,
    'font-family': fontFamily,
    fill: color,
    'paint-order': 'stroke',
    stroke: 'white',
    'stroke-width': haloWidth,
    'stroke-linejoin': 'round',
    'pointer-events': 'none',
  });
  node.textContent = item.text;
  return node;
}

/**
 * T1のcss-pxタグは既存ラベル寸法を保持する。
 * paper-mmタグでは、呼出し側がPDF viewport/UserUnit/zoomを反映して求めた
 * 単一の paperMmToCss 倍率だけを適用する。registration/DPRをここで再適用しない。
 * custom TagFamily v2のpaperScaleはこのpaper-mm倍率へ一度だけ乗算する。
 *
 * @returns {SVGElement[]} 元部材の選択groupへappendするノード。
 */
export function renderTagSvg({
  plan,
  originCss,
  document: domDocument = globalThis.document,
  fontSize = 12,
  strokeWidth = 3,
  paperMmToCss = null,
  color = DEFAULT_TAG_COLOR,
} = {}) {
  assertRenderPlan(plan);
  const origin = [...assertPoint(originCss)];
  if (
    !Number.isFinite(fontSize) ||
    fontSize <= 0 ||
    !Number.isFinite(strokeWidth) ||
    strokeWidth < 0
  )
    throw new RangeError('タグ文字サイズ/線幅が不正です。');
  if (typeof domDocument?.createElementNS !== 'function')
    throw new TypeError('タグSVG生成用Documentが必要です。');

  const resolvedColor =
    typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color.trim())
      ? color.trim()
      : DEFAULT_TAG_COLOR;
  const scale = paperScale(plan, paperMmToCss);

  if (plan.units === 'css-px') {
    return plan.items.map((item) => {
      const [textX, textY] = scaledPoint(origin, item.point, 1);
      const node = createSvgNode(domDocument, 'text', {
        x: textX,
        y: textY,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        'font-size': fontSize,
        'font-family': plan.fontFamily,
        fill: resolvedColor,
        'paint-order': 'stroke',
        stroke: 'white',
        'stroke-width': strokeWidth,
        'stroke-linejoin': 'round',
        'pointer-events': 'none',
      });
      node.textContent = item.text;
      return node;
    });
  }

  return plan.items.map((item) => {
    if (item.kind === 'frame') {
      const [x, y, width, height] = item.rect;
      const [left, top] = scaledPoint(origin, [x, y], scale);
      const attrs = {
        x: left,
        y: top,
        width: scaledMagnitude(width, scale, 'frame幅'),
        height: scaledMagnitude(height, scale, 'frame高さ'),
        fill: 'none',
        stroke: resolvedColor,
        'stroke-width': scaledMagnitude(item.strokeWidth, scale, 'frame線幅'),
        'pointer-events': 'none',
      };
      if (item.shape === 'rounded-rect') {
        attrs.rx = scaledMagnitude(item.radius, scale, 'frame半径');
        attrs.ry = attrs.rx;
      }
      return createSvgNode(domDocument, 'rect', attrs);
    }

    if (item.kind === 'line') {
      const a = scaledPoint(origin, item.points[0], scale);
      const b = scaledPoint(origin, item.points[1], scale);
      return createSvgNode(domDocument, 'line', {
        x1: a[0],
        y1: a[1],
        x2: b[0],
        y2: b[1],
        stroke: resolvedColor,
        'stroke-width': scaledMagnitude(item.strokeWidth, scale, 'line線幅'),
        'pointer-events': 'none',
      });
    }

    if (item.kind === 'text')
      return renderPaperText(item, origin, scale, domDocument, plan.fontFamily, resolvedColor);

    if (item.kind === 'circle') {
      const [x, y] = scaledPoint(origin, item.point, scale);
      return createSvgNode(domDocument, 'circle', {
        cx: x,
        cy: y,
        r: scaledMagnitude(item.radius, scale, '円半径'),
        fill: item.filled === true ? resolvedColor : 'none',
        stroke: resolvedColor,
        'stroke-width': scaledMagnitude(item.strokeWidth, scale, '円線幅', {
          allowZero: true,
        }),
        'pointer-events': 'none',
      });
    }

    if (item.kind === 'circled-value') {
      const [x, y] = scaledPoint(origin, item.point, scale);
      const group = createSvgNode(domDocument, 'g', { 'pointer-events': 'none' });
      group.append(
        createSvgNode(domDocument, 'circle', {
          cx: x,
          cy: y,
          r: scaledMagnitude(item.radius, scale, '円半径'),
          fill: 'none',
          stroke: resolvedColor,
          'stroke-width': scaledMagnitude(
            item.circleStrokeWidth ?? item.strokeWidth ?? 0.35,
            scale,
            '円線幅',
            { allowZero: true },
          ),
          'pointer-events': 'none',
        }),
        renderPaperText(item, origin, scale, domDocument, plan.fontFamily, resolvedColor),
      );
      return group;
    }

    if (item.kind === 'leader-anchor') {
      const [x, y] = scaledPoint(origin, item.point, scale);
      return createSvgNode(domDocument, 'g', {
        'data-tag-leader-anchor': 'true',
        'data-anchor-x': x,
        'data-anchor-y': y,
        'pointer-events': 'none',
      });
    }

    throw new TypeError(`未対応のタグSVG primitiveです: ${item.kind}`);
  });
}
