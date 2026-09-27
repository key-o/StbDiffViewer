/** @fileoverview PDFページの選択領域とSTB平面図対応をPDF user-spaceで管理する。 */
import { transformPoint } from '../../data/drawing/affine2d.js';

const REGION_SCHEMA_VERSION = 1;
const COORDINATE_TOLERANCE = 1e-6;

function finitePair(value, label) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite))
    throw new TypeError(`${label}は有限な2次元座標にしてください。`);
  return value;
}

function normalizeViewBox(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every(Number.isFinite) ||
    value[0] >= value[2] ||
    value[1] >= value[3]
  ) {
    throw new TypeError('PDFページのviewBoxが不正です。');
  }
  return [...value];
}

function freezeJson(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeJson(item)])),
    );
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function cleanCoordinate(value) {
  return Number(value.toPrecision(14));
}

function normalizePdfRegion(region, viewBox) {
  const { xMin, yMin, xMax, yMax } = region || {};
  if (![xMin, yMin, xMax, yMax].every(Number.isFinite) || xMin >= xMax || yMin >= yMax)
    throw new TypeError('PDF領域は正の面積を持つ有限な矩形にしてください。');
  if (
    xMin < viewBox[0] - COORDINATE_TOLERANCE ||
    yMin < viewBox[1] - COORDINATE_TOLERANCE ||
    xMax > viewBox[2] + COORDINATE_TOLERANCE ||
    yMax > viewBox[3] + COORDINATE_TOLERANCE
  ) {
    throw new RangeError('PDF領域がページの表示範囲外です。');
  }
  const normalized = {
    xMin: cleanCoordinate(Math.min(viewBox[2], Math.max(xMin, viewBox[0]))),
    yMin: cleanCoordinate(Math.min(viewBox[3], Math.max(yMin, viewBox[1]))),
    xMax: cleanCoordinate(Math.min(viewBox[2], Math.max(xMax, viewBox[0]))),
    yMax: cleanCoordinate(Math.min(viewBox[3], Math.max(yMax, viewBox[1]))),
    units: 'pdf-user-space',
  };
  if (normalized.xMin >= normalized.xMax || normalized.yMin >= normalized.yMax)
    throw new RangeError('PDF領域がページ範囲内にありません。');
  return normalized;
}

/** Stage CSS pixelsで指定した矩形を、回転に依存しないPDF user-space矩形に変換する。 */
export function mapCssSelectionToPdfRegion({
  start,
  end,
  cssToPdf,
  viewBox: rawViewBox,
  minCssSize = 4,
} = {}) {
  finitePair(start, '選択開始点');
  finitePair(end, '選択終了点');
  const viewBox = normalizeViewBox(rawViewBox);
  if (!Number.isFinite(minCssSize) || minCssSize < 0)
    throw new TypeError('最小選択寸法は0以上の有限値にしてください。');
  if (Math.abs(end[0] - start[0]) < minCssSize || Math.abs(end[1] - start[1]) < minCssSize)
    throw new RangeError('図面領域を選ぶには幅と高さが必要です。');
  if (!Array.isArray(cssToPdf) || cssToPdf.length !== 6 || !cssToPdf.every(Number.isFinite)) {
    throw new TypeError('PDF画面変換が不正です。');
  }
  const left = Math.min(start[0], end[0]);
  const right = Math.max(start[0], end[0]);
  const top = Math.min(start[1], end[1]);
  const bottom = Math.max(start[1], end[1]);
  const corners = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ].map((point) => transformPoint(cssToPdf, point));
  const region = {
    xMin: Math.min(...corners.map(([x]) => x)),
    yMin: Math.min(...corners.map(([, y]) => y)),
    xMax: Math.max(...corners.map(([x]) => x)),
    yMax: Math.max(...corners.map(([, y]) => y)),
  };
  return freezeJson(normalizePdfRegion(region, viewBox));
}

/**
 * 現在のPDFページ領域を、読み込み済みSTBの明示的な平面図へ対応付ける。
 * 表示倍率・DPR・画面回転は保存座標へ含めない。
 */
export function createPdfRegionMapping({ pdfInfo, pageRender, region, drawing } = {}) {
  if (typeof pdfInfo?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pdfInfo.sha256))
    throw new TypeError('PDFのSHA-256識別子が必要です。');
  if (!Number.isSafeInteger(pdfInfo.byteLength) || pdfInfo.byteLength <= 0)
    throw new TypeError('PDFの実バイト数が必要です。');
  if (!Number.isSafeInteger(pdfInfo.numPages) || pdfInfo.numPages <= 0)
    throw new TypeError('PDFの総ページ数が必要です。');
  if (
    !Number.isSafeInteger(pageRender?.pageNumber) ||
    pageRender.pageNumber < 1 ||
    pageRender.pageNumber > pdfInfo.numPages
  )
    throw new TypeError('現在のPDFページ番号が不正です。');
  const viewBox = normalizeViewBox(pageRender.viewBox);
  if (!Number.isFinite(pageRender.userUnit) || pageRender.userUnit <= 0)
    throw new TypeError('PDF UserUnitが必要です。');
  if (!Number.isInteger(pageRender.intrinsicRotation) || pageRender.intrinsicRotation % 90 !== 0)
    throw new TypeError('PDF固有回転が不正です。');
  if (
    typeof drawing?.source?.modelKey !== 'string' ||
    !drawing.source.modelKey.trim() ||
    typeof drawing.source.modelRevision !== 'string' ||
    !drawing.source.modelRevision.trim() ||
    !drawing.view ||
    drawing.view.type !== 'plan' ||
    typeof drawing.view.storyId !== 'string' ||
    !drawing.view.storyId.trim()
  ) {
    throw new TypeError('STBモデル・改訂・階の平面図情報が必要です。');
  }
  const normalizedRegion = normalizePdfRegion(region, viewBox);
  const mapping = {
    schemaVersion: REGION_SCHEMA_VERSION,
    pdf: {
      sha256: pdfInfo.sha256,
      byteLength: pdfInfo.byteLength,
      numPages: pdfInfo.numPages,
      pageNumber: pageRender.pageNumber,
      viewBox,
      userUnit: pageRender.userUnit,
      intrinsicRotation: pageRender.intrinsicRotation,
    },
    region: normalizedRegion,
    stb: {
      modelKey: drawing.source.modelKey,
      modelRevision: drawing.source.modelRevision,
      view: JSON.parse(JSON.stringify(drawing.view)),
    },
  };
  mapping.key = JSON.stringify([
    mapping.pdf.sha256,
    mapping.pdf.pageNumber,
    normalizedRegion.xMin,
    normalizedRegion.yMin,
    normalizedRegion.xMax,
    normalizedRegion.yMax,
    mapping.stb.modelKey,
    mapping.stb.modelRevision,
    canonicalJson(mapping.stb.view),
  ]);
  return freezeJson(mapping);
}

/** ページ表示が変わった後の一時mappingを適用できるか、決定論的な理由付きで判定する。 */
export function inspectPdfRegionMapping(mapping, { pdfInfo, pageRender, drawing } = {}) {
  const stale = (code) => Object.freeze({ current: false, code });
  if (mapping?.schemaVersion !== REGION_SCHEMA_VERSION) return stale('SCHEMA_MISMATCH');
  if (mapping.pdf?.sha256 !== pdfInfo?.sha256) return stale('PDF_CHANGED');
  if (mapping.pdf?.byteLength !== pdfInfo?.byteLength) return stale('PDF_BYTES_CHANGED');
  if (mapping.pdf?.numPages !== pdfInfo?.numPages) return stale('PDF_PAGE_COUNT_CHANGED');
  if (mapping.pdf?.pageNumber !== pageRender?.pageNumber) return stale('PAGE_CHANGED');
  if (!Array.isArray(pageRender?.viewBox) || !sameJson(mapping.pdf.viewBox, pageRender.viewBox))
    return stale('PAGE_VIEW_CHANGED');
  if (mapping.pdf?.userUnit !== pageRender?.userUnit) return stale('USER_UNIT_CHANGED');
  if (mapping.pdf?.intrinsicRotation !== pageRender?.intrinsicRotation)
    return stale('PDF_ROTATION_CHANGED');
  if (mapping.stb?.modelKey !== drawing?.source?.modelKey) return stale('MODEL_CHANGED');
  if (mapping.stb?.modelRevision !== drawing?.source?.modelRevision) return stale('STB_CHANGED');
  if (!sameJson(mapping.stb?.view, drawing?.view)) return stale('STB_VIEW_CHANGED');
  try {
    const region = normalizePdfRegion(mapping.region, normalizeViewBox(pageRender.viewBox));
    if (!sameJson(region, mapping.region)) return stale('REGION_INVALID');
  } catch {
    return stale('REGION_INVALID');
  }
  return Object.freeze({ current: true, code: 'CURRENT' });
}

/** PDF user-space矩形を現在のviewport CSS座標上の4点へ変換する。 */
export function mapPdfRegionToCssPolygon(region, pdfToCss) {
  const normalized = normalizePdfRegion(region, [
    region.xMin,
    region.yMin,
    region.xMax,
    region.yMax,
  ]);
  if (!Array.isArray(pdfToCss) || pdfToCss.length !== 6 || !pdfToCss.every(Number.isFinite))
    throw new TypeError('PDF viewport変換が不正です。');
  return Object.freeze(
    [
      [normalized.xMin, normalized.yMin],
      [normalized.xMax, normalized.yMin],
      [normalized.xMax, normalized.yMax],
      [normalized.xMin, normalized.yMax],
    ].map((point) => Object.freeze(transformPoint(pdfToCss, point))),
  );
}
