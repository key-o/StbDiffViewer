/**
 * @fileoverview RC断面レンダラー共通のSVG初期化・鉄筋記号配置ヘルパー
 */

import {
  addBarSymbolDefs,
  createSvgElement,
  placeBarSymbol,
  REBAR_SYMBOLS,
} from './rcColumnVisual/rebarSymbolDefs.js';
import { schedulePaperMmToPx } from './rcScheduleProfile.js';

/**
 * RC断面の表示領域を計算し、記号定義と背景を持つSVGを生成する。
 * 梁・柱固有のpaddingや最大寸法は呼び出し側から渡す。
 */
export function createRcSectionSvg({
  sectionWidth,
  sectionHeight,
  maxWidth,
  maxHeight,
  padding,
  fixedScale,
  symbolPrefix,
}) {
  const scale =
    Number.isFinite(fixedScale) && fixedScale > 0
      ? fixedScale
      : Math.min(
          (maxWidth - padding * 2) / sectionWidth,
          (maxHeight - padding * 2) / sectionHeight,
        );
  const width = sectionWidth * scale + padding * 2;
  const height = sectionHeight * scale + padding * 2;
  const svg = createSvgElement('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    xmlns: 'http://www.w3.org/2000/svg',
  });

  addBarSymbolDefs(svg, symbolPrefix);
  svg.appendChild(
    createSvgElement('rect', {
      x: 0,
      y: 0,
      width,
      height,
      fill: 'white',
    }),
  );

  return { svg, scale, width, height };
}

/**
 * schedule model のローカルmm座標をSVG座標へ投影する。
 * 矩形外形の配置寸法も同時に返し、柱・梁Rendererで同じ計算を繰り返さない。
 */
export function createRcSectionProjection({ sectionWidth, sectionHeight, padding, scale }) {
  const rectX = padding;
  const rectY = padding;
  const rectWidth = sectionWidth * scale;
  const rectHeight = sectionHeight * scale;
  return {
    rectX,
    rectY,
    rectWidth,
    rectHeight,
    sx: (x) => padding + x * scale,
    sy: (y) => padding + y * scale,
  };
}

/**
 * RC矩形断面のコンクリート外形を追加する。
 */
export function appendRcRectangularConcrete(svg, { x, y, width, height }) {
  const element = createSvgElement('rect', {
    x,
    y,
    width,
    height,
    fill: '#f8f8f8',
    stroke: 'black',
    'stroke-width': 2,
  });
  svg.appendChild(element);
  return element;
}

/**
 * RC矩形断面の幅・せい寸法文字を追加する。
 * 柱/梁で紙面余白だけが異なるためoffsetを呼び出し側から指定する。
 */
export function appendRcRectangularDimensions(
  svg,
  {
    sectionWidth,
    sectionHeight,
    rectX,
    rectY,
    rectWidth,
    rectHeight,
    topOffset = 6,
    leftOffset = 6,
  },
) {
  const style = {
    'font-size': '10px',
    'font-family': 'sans-serif',
    fill: '#666',
  };
  const widthText = createSvgElement('text', {
    x: rectX + rectWidth / 2,
    y: rectY - topOffset,
    'text-anchor': 'middle',
    ...style,
  });
  widthText.textContent = `${sectionWidth}`;
  svg.appendChild(widthText);

  const heightText = createSvgElement('text', {
    x: rectX - leftOffset,
    y: rectY + rectHeight / 2,
    'text-anchor': 'middle',
    'writing-mode': 'tb',
    ...style,
  });
  heightText.textContent = `${sectionHeight}`;
  svg.appendChild(heightText);

  return { widthText, heightText };
}

/**
 * SVG要素を文字列化する。描画不能をnullで表すレンダラーでは空文字を返す。
 */
export function serializeRcSvg(svg) {
  return svg?.outerHTML || '';
}

/**
 * 鉄筋記号を配置し、レンダラー共通のメタデータを付与する。
 * paperDiameterMm指定時は実径・断面縮尺ではなく紙面上の作図記号径を優先する。
 */
export function placeRcBarSymbol(
  svg,
  dia,
  cx,
  cy,
  {
    scale = 1,
    prefix = 'bar',
    className,
    role = null,
    layer = null,
    paperDiameterMm = null,
    scheduleProfile = null,
  } = {},
) {
  const config = REBAR_SYMBOLS[dia] || REBAR_SYMBOLS[`D${String(dia).replace(/^T/, '')}`];
  const baseRadius = config?.outerRadius || config?.radius || config?.size || 5;
  const requestedPaperDiameter = Number(paperDiameterMm);
  const renderScale =
    Number.isFinite(requestedPaperDiameter) && requestedPaperDiameter > 0
      ? schedulePaperMmToPx(requestedPaperDiameter / 2, scheduleProfile || undefined) / baseRadius
      : scale;

  const use = placeBarSymbol(svg, dia, cx, cy, renderScale, prefix);
  if (className) use.setAttribute('class', className);
  if (role !== null) use.setAttribute('data-rebar-role', String(role));
  if (layer !== null) use.setAttribute('data-rebar-layer', String(layer));
  use.setAttribute('data-render-radius', String(baseRadius * renderScale));
  if (Number.isFinite(requestedPaperDiameter) && requestedPaperDiameter > 0) {
    use.setAttribute('data-paper-diameter-mm', String(requestedPaperDiameter));
  }
  return use;
}
