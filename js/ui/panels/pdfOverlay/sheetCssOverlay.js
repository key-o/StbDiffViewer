/** @fileoverview A3シートSVG（viewBox=用紙mm）上にCSS px座標で描くための入れ子SVG。 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * シートSVGのviewBoxはプレビューmm単位のため、modelToPreviewCss等のCSS px座標を
 * そのまま描くと倍率が二重に掛かる。プレビュー全面を覆うCSS px単位の入れ子SVGを返す。
 * レイアウト未確定時は元のsvgを返す。
 */
export function resolveSheetCssOverlay(svg, sheetLayout, className) {
  const existing = svg.querySelector?.(`.${className}`) || null;
  if (existing) return existing;

  const width = Number(sheetLayout?.previewWidthPx);
  const height = Number(sheetLayout?.previewHeightPx);
  if (!(width > 0) || !(height > 0)) return svg;

  const viewBox = sheetLayout?.previewViewBox;
  const attributes = {
    x: Number.isFinite(viewBox?.minX) ? viewBox.minX : 0,
    y: Number.isFinite(viewBox?.minY) ? viewBox.minY : 0,
    width: Number.isFinite(viewBox?.widthMm) ? viewBox.widthMm : '100%',
    height: Number.isFinite(viewBox?.heightMm) ? viewBox.heightMm : '100%',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    class: className,
  };
  const overlay = (svg.ownerDocument || document).createElementNS(SVG_NS, 'svg');
  for (const [name, value] of Object.entries(attributes)) overlay.setAttribute(name, String(value));
  svg.append(overlay);
  return overlay;
}
