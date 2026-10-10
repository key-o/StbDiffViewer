/** @fileoverview 旧PDF座標の自由メモをSTB model-mmへ明示移行するpure helper。 */
import { planViewContextSnapshot } from '../../data/drawing/drawingModel.js';
import { invertAffine, transformPoint } from '../../data/drawing/affine2d.js';

function blocked(code, count, message, blockedCount = null) {
  return {
    ready: false,
    code,
    count,
    ...(blockedCount == null ? {} : { blockedCount }),
    message,
    drawingMemos: null,
    preview: [],
  };
}

function pdfIdentityFromInfo(info) {
  return info
    ? { sha256: info.sha256, byteLength: info.byteLength, numPages: info.numPages }
    : null;
}

function samePdfIdentity(left, right) {
  const normalizedRight = pdfIdentityFromInfo(right);
  return Boolean(
    left &&
    normalizedRight &&
    left.sha256 === normalizedRight.sha256 &&
    left.byteLength === normalizedRight.byteLength &&
    left.numPages === normalizedRight.numPages,
  );
}

function drawingSnapshot(drawing) {
  if (!drawing?.source?.modelKey || !drawing?.source?.modelRevision || !drawing?.view) return null;
  return {
    source: {
      modelKey: String(drawing.source.modelKey),
      modelRevision: String(drawing.source.modelRevision),
    },
    view: JSON.parse(JSON.stringify(planViewContextSnapshot(drawing.view))),
  };
}

function isLegacyPdfMemo(memo) {
  return Object.hasOwn(memo || {}, 'pageNumber') || Object.hasOwn(memo || {}, 'pdfPoint');
}

/**
 * 旧 pageNumber + pdfPoint 自由メモを現在のSTB model-mm座標へ移す計画を返す。
 * 入力配列は変更せず、全件を安全に変換できない場合は部分変換しない。
 */
export function planLegacyPdfDrawingMemoMigration({
  drawingMemos = [],
  drawing,
  legacyPdfIdentity,
  currentPdfInfo,
  currentPageNumber,
  registration,
} = {}) {
  if (!Array.isArray(drawingMemos)) throw new TypeError('drawingMemos must be an array.');

  const legacy = drawingMemos.filter(isLegacyPdfMemo);
  if (!legacy.length) return blocked('NO_LEGACY_PDF_MEMOS', 0, '旧PDF座標メモはありません。');

  const targetDrawing = drawingSnapshot(drawing);
  if (!targetDrawing)
    return blocked(
      'DRAWING_CONTEXT_MISSING',
      legacy.length,
      'SVG図面を生成してから旧PDFメモを移行してください。',
    );
  if (!legacyPdfIdentity || !currentPdfInfo)
    return blocked(
      'PDF_IDENTITY_MISSING',
      legacy.length,
      '旧メモの保存元PDFと現在のPDFを確認できません。',
    );
  if (!samePdfIdentity(legacyPdfIdentity, currentPdfInfo))
    return blocked('PDF_CHANGED', legacy.length, '旧メモの保存元PDFと現在のPDFが一致しません。');
  if (!Number.isSafeInteger(currentPageNumber) || currentPageNumber < 1)
    return blocked(
      'PAGE_CONTEXT_MISSING',
      legacy.length,
      'PDFページを表示してから旧PDFメモを移行してください。',
    );

  const unpositioned = legacy.filter(
    (memo) =>
      !Number.isSafeInteger(memo?.pageNumber) ||
      memo.pageNumber < 1 ||
      !Array.isArray(memo?.pdfPoint) ||
      memo.pdfPoint.length !== 2 ||
      !memo.pdfPoint.every(Number.isFinite),
  );
  if (unpositioned.length)
    return blocked(
      'LEGACY_PDF_MEMO_UNPOSITIONED',
      legacy.length,
      `位置を持たない旧PDFメモが${unpositioned.length}件あるため、一括移行できません。`,
      unpositioned.length,
    );

  const otherPage = legacy.filter((memo) => memo.pageNumber !== currentPageNumber);
  if (otherPage.length)
    return blocked(
      'PAGE_CHANGED',
      legacy.length,
      `現在のPDF ${currentPageNumber}頁と異なる旧メモが${otherPage.length}件あります。保存元ページを表示してから移行してください。`,
      otherPage.length,
    );

  if (!registration?.matrix)
    return blocked(
      'ALIGNMENT_MISSING',
      legacy.length,
      '詳細位置合わせの有効な登録行列を設定してから旧PDFメモを移行してください。',
    );

  let pdfToModel;
  try {
    pdfToModel = invertAffine(registration.matrix);
  } catch {
    return blocked(
      'ALIGNMENT_INVALID',
      legacy.length,
      '詳細位置合わせの登録行列を逆変換できないため、旧PDFメモを移行できません。',
    );
  }

  const preview = [];
  const migrated = drawingMemos.map((memo) => {
    if (!isLegacyPdfMemo(memo)) return { ...memo };
    const modelPoint = transformPoint(pdfToModel, memo.pdfPoint).map((value) =>
      Number(value.toFixed(3)),
    );
    preview.push({
      id: String(memo.id),
      pageNumber: memo.pageNumber,
      pdfPoint: [...memo.pdfPoint],
      modelPoint: [...modelPoint],
    });
    return {
      id: memo.id,
      drawing: JSON.parse(JSON.stringify(targetDrawing)),
      modelPoint,
      text: typeof memo.text === 'string' ? memo.text : '',
      active: true,
      invalidationCode: null,
    };
  });

  return {
    ready: true,
    code: 'READY',
    count: legacy.length,
    pageNumber: currentPageNumber,
    message: `旧PDF座標メモ${legacy.length}件をPDF ${currentPageNumber}頁から図面model-mmへ移行できます。`,
    drawingMemos: migrated,
    preview,
  };
}
