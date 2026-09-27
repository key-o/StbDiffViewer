/** @fileoverview PDF/STB照合ビューの表示倍率とviewport選択。 */

export const PDF_OVERLAY_VIEW_ZOOM_MIN = 0.25;
export const PDF_OVERLAY_VIEW_ZOOM_MAX = 6;
export const STB_SHEET_PREVIEW_PX_PER_MM = 2.5;

const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 800;
const WHEEL_ZOOM_RATE = 0.0015;

function positiveFinite(value, label) {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${label}は正の有限値にしてください。`);
  return value;
}

function wheelPixels(deltaY, deltaMode) {
  if (!Number.isFinite(deltaY)) throw new TypeError('ホイール移動量が不正です。');
  if (deltaMode === 1) return deltaY * WHEEL_LINE_PX;
  if (deltaMode === 2) return deltaY * WHEEL_PAGE_PX;
  return deltaY;
}

export function nextPdfOverlayViewZoom(currentZoom, deltaY, deltaMode = 0) {
  const current = positiveFinite(currentZoom, '現在の表示倍率');
  const pixels = wheelPixels(deltaY, deltaMode);
  const next = current * Math.exp(-pixels * WHEEL_ZOOM_RATE);
  return Math.min(PDF_OVERLAY_VIEW_ZOOM_MAX, Math.max(PDF_OVERLAY_VIEW_ZOOM_MIN, next));
}

export function formatPdfOverlayViewZoom(zoom) {
  return `${Math.round(positiveFinite(zoom, '表示倍率') * 100)}%`;
}

export function sheetPreviewPxPerMm(viewZoom) {
  return STB_SHEET_PREVIEW_PX_PER_MM * positiveFinite(viewZoom, '表示倍率');
}

/**
 * PDF照合を選んでいてもPDFページが未読込ならA3 sheetへフォールバックする。
 * STB単独表示も常にA3 sheetを使う。
 */
export function resolveOverlayViewportMode(
  displayMode,
  { hasPdfPage = false, hasDrawing = false } = {},
) {
  if (displayMode !== 'stb' && displayMode !== 'pdf')
    throw new RangeError('表示モードはstbまたはpdfを指定してください。');
  if (displayMode === 'pdf' && hasPdfPage) return 'pdf';
  if (hasDrawing) return 'sheet';
  return 'none';
}
