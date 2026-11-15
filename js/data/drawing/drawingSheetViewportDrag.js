/**
 * Sheet viewport frame manipulation in paper millimetres (SVG X-right / Y-down).
 * This is placement metadata only: never mutate the registered DrawingDocument.
 */
const HANDLES = new Set(['move', 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
const MIN_SIZE_MM = 10;
const roundMm = (number) => Math.round(number * 1000) / 1000;

export function computeSheetViewportDrag(placement, handle, dxMm, dyMm) {
  if (!HANDLES.has(handle)) throw new Error('未対応のビューポート操作です。');
  if (
    ![dxMm, dyMm, placement?.xMm, placement?.yMm, placement?.widthMm, placement?.heightMm].every(
      Number.isFinite,
    ) ||
    placement.widthMm <= 0 ||
    placement.heightMm <= 0
  )
    throw new Error('ビューポートの移動量または配置が不正です。');

  let { xMm, yMm, widthMm, heightMm } = placement;
  if (handle === 'move') {
    xMm += dxMm;
    yMm += dyMm;
  } else {
    if (handle.includes('w')) {
      widthMm = Math.max(MIN_SIZE_MM, widthMm - dxMm);
      xMm = placement.xMm + placement.widthMm - widthMm;
    } else if (handle.includes('e')) {
      widthMm = Math.max(MIN_SIZE_MM, widthMm + dxMm);
    }
    if (handle.includes('n')) {
      heightMm = Math.max(MIN_SIZE_MM, heightMm - dyMm);
      yMm = placement.yMm + placement.heightMm - heightMm;
    } else if (handle.includes('s')) {
      heightMm = Math.max(MIN_SIZE_MM, heightMm + dyMm);
    }
  }
  return {
    xMm: roundMm(xMm),
    yMm: roundMm(yMm),
    widthMm: roundMm(widthMm),
    heightMm: roundMm(heightMm),
  };
}

/** Delta in SVG paper-mm, independent of browser zoom, CSS and SVG viewBox scaling. */
export function screenDeltaToSheetMm(matrix, clientDx, clientDy) {
  const { a, b, c, d } = matrix || {};
  const det = a * d - b * c;
  if (![a, b, c, d, clientDx, clientDy, det].every(Number.isFinite) || Math.abs(det) < 1e-12)
    throw new Error('シートの画面座標変換が不正です。');
  return [(d * clientDx - c * clientDy) / det, (-b * clientDx + a * clientDy) / det];
}

/**
 * Resizing changes the clipping rectangle, not the view's paper-space position.
 * The offset is measured from the frame centre (SVG Y-down) and is persisted
 * with the placement so SVG, DXF, PDF, and ZIP restoration share one origin.
 * Translation-only edits keep their existing offset and move the view with the frame.
 */
export function preserveSheetViewportContentCenter(original, changes) {
  const resized =
    (changes.widthMm !== undefined && changes.widthMm !== original.widthMm) ||
    (changes.heightMm !== undefined && changes.heightMm !== original.heightMm);
  if (!resized) return changes;
  const oldX = original.xMm + original.widthMm / 2;
  const oldY = original.yMm + original.heightMm / 2;
  const nextX = (changes.xMm ?? original.xMm) + (changes.widthMm ?? original.widthMm) / 2;
  const nextY = (changes.yMm ?? original.yMm) + (changes.heightMm ?? original.heightMm) / 2;
  return {
    ...changes,
    viewOffsetXMm: roundMm((original.viewOffsetXMm ?? 0) + oldX - nextX),
    viewOffsetYMm: roundMm((original.viewOffsetYMm ?? 0) + oldY - nextY),
  };
}
