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
 * 部材本体の中心をclient座標へ写像する。タグや引出線のbboxは含めない。
 * getScreenCTMにより、A3の入れ子SVG・PDF配置・図面回転・表示倍率を一度だけ適用する。
 */
export function getPdfOverlayMemberClientCenter(member) {
  const rawX = member?.getAttribute?.('data-member-center-x');
  const rawY = member?.getAttribute?.('data-member-center-y');
  if (rawX == null || rawY == null || rawX === '' || rawY === '') return null;
  const x = Number(rawX);
  const y = Number(rawY);
  const matrix = member.getScreenCTM?.();
  if (
    !matrix ||
    ![x, y, matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite) ||
    Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) < 1e-12
  )
    return null;
  const point = [matrix.a * x + matrix.c * y + matrix.e, matrix.b * x + matrix.d * y + matrix.f];
  return point.every(Number.isFinite) ? point : null;
}

function finiteRect(rect, label) {
  if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite))
    throw new TypeError(`${label}が不正です。`);
  if (!(rect.width > 0) || !(rect.height > 0))
    throw new RangeError(`${label}の幅と高さは正の値にしてください。`);
  return rect;
}

function finitePoint(value, label) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite))
    throw new TypeError(`${label}が不正です。`);
  return value;
}

/**
 * zoom前のカーソル位置をstage内の正規化座標として保存する。
 * content originもzoom前の値を固定し、再描画時のscroll anchoringや一時的なlayout変化に依存しない。
 */
export function capturePdfOverlayZoomAnchor({
  clientX,
  clientY,
  scrollLeft = 0,
  scrollTop = 0,
  scrollRect,
  stageRect,
} = {}) {
  if (![clientX, clientY, scrollLeft, scrollTop].every(Number.isFinite))
    throw new TypeError('ズーム基準位置が不正です。');
  const viewport = finiteRect(scrollRect, 'スクロール領域');
  const stage = finiteRect(stageRect, '図面領域');
  return Object.freeze({
    stageFraction: Object.freeze([
      (clientX - stage.left) / stage.width,
      (clientY - stage.top) / stage.height,
    ]),
    viewportPoint: Object.freeze([clientX - viewport.left, clientY - viewport.top]),
    stageContentOrigin: Object.freeze([
      stage.left - viewport.left + scrollLeft,
      stage.top - viewport.top + scrollTop,
    ]),
  });
}

/**
 * zoom後のstage寸法から、zoom前と同じstage点を同じviewport位置へ戻すscroll量を求める。
 */
export function resolvePdfOverlayZoomScroll(anchor, stageRect) {
  if (!anchor || typeof anchor !== 'object') throw new TypeError('ズーム基準が不正です。');
  const stageFraction = finitePoint(anchor.stageFraction, '図面内ズーム位置');
  const viewportPoint = finitePoint(anchor.viewportPoint, 'viewport内ズーム位置');
  const stageContentOrigin = finitePoint(anchor.stageContentOrigin, '図面content原点');
  const stage = finiteRect(stageRect, '図面領域');
  return Object.freeze({
    left: stageContentOrigin[0] + stage.width * stageFraction[0] - viewportPoint[0],
    top: stageContentOrigin[1] + stage.height * stageFraction[1] - viewportPoint[1],
  });
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
