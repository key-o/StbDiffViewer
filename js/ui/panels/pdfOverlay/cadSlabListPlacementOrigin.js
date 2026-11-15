/**
 * Place a freshly measured slab schedule fully on its ordinary CAD sheet.
 * A full-width A3 RC list can be wider than the 10 mm preferred inset, but
 * must never be silently persisted beyond the paper or through a title block.
 */
import { getSheetPaperSize } from '../../../data/drawing/drawingSheetPaper.js';
import { getSheetFrameLayout } from '../../../data/drawing/drawingSheetFrame.js';

export function findContainedSlabListOrigin(sheet, widthMm, heightMm) {
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 0 || heightMm <= 0)
    throw new RangeError('スラブリスト領域の寸法が不正です。');
  const { widthMm: paperW, heightMm: paperH } = getSheetPaperSize(sheet.paper, sheet.orientation);
  const frame = getSheetFrameLayout(sheet);
  const inset = frame?.inner ?? { minX: 10, minY: 10, maxX: paperW - 10, maxY: paperH - 10 };
  const areas = frame ? [inset] : [inset, { minX: 0, minY: 0, maxX: paperW, maxY: paperH }];
  const occupied = [
    ...(sheet.placements ?? []),
    ...(sheet.listPlacements ?? []),
    ...(frame
      ? [
          {
            xMm: frame.titleBlock.minX,
            yMm: frame.titleBlock.minY,
            widthMm: frame.titleBlock.maxX - frame.titleBlock.minX,
            heightMm: frame.titleBlock.maxY - frame.titleBlock.minY,
          },
        ]
      : []),
  ];
  // Rectangle packing only needs to consider paper/inset edges and the right
  // or bottom edges of existing rectangles. This avoids a pixel-grid search.
  for (const area of areas) {
    if (widthMm > area.maxX - area.minX || heightMm > area.maxY - area.minY) continue;
    const xs = [...new Set([area.minX, ...occupied.map((p) => p.xMm + p.widthMm)])].sort(
      (a, b) => a - b,
    );
    const ys = [...new Set([area.minY, ...occupied.map((p) => p.yMm + p.heightMm)])].sort(
      (a, b) => a - b,
    );
    for (const yMm of ys) {
      if (yMm < area.minY || yMm + heightMm > area.maxY) continue;
      for (const xMm of xs) {
        if (xMm < area.minX || xMm + widthMm > area.maxX) continue;
        if (
          occupied.every(
            (p) =>
              xMm + widthMm <= p.xMm ||
              p.xMm + p.widthMm <= xMm ||
              yMm + heightMm <= p.yMm ||
              p.yMm + p.heightMm <= yMm,
          )
        )
          return { xMm, yMm };
      }
    }
  }
  throw new Error(
    'スラブリストがシート用紙内の空き領域に収まりません。大きい用紙を選ぶか配置を調整してください。',
  );
}
