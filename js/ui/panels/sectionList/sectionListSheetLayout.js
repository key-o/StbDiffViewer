/**
 * @fileoverview 断面リストPDFの用紙レイアウト(簡易CADビュー)ロジック
 *
 * 1枚の用紙(ページ)に複数の「領域」(階×符号の切り出し)を貼り付けるための
 * 純関数群。領域の自動詰め込み、はみ出し・重なり検出、吸着、未配置セルの集計を扱う。
 * 寸法はすべてmm。
 *
 * @module ui/sectionList/sectionListSheetLayout
 */

import { PAGE_MARGIN_MM } from './sectionListPageSplit.js';

/** 領域どうしの既定の間隔(mm) */
export const DEFAULT_REGION_GAP_MM = 5;

/** 吸着の距離しきい値(mm) */
export const SNAP_THRESHOLD_MM = 3;

const EPS = 1e-6;

/**
 * 領域を左上から棚(行)詰めで用紙へ割り付ける。
 * 行の幅が足りなければ次の行、高さが足りなければ次のページへ進む。
 * 1つで用紙に収まらない領域も、空きページの左上へ単独で置く（はみ出しは別途検出）。
 * @param {Array<{width: number, height: number}>} sizes - 領域の寸法(mm)
 * @param {{width: number, height: number}} paper - 用紙(mm)
 * @param {{margin?: number, gap?: number}} [options]
 * @returns {Array<{page: number, x: number, y: number}>}
 */
export function packRegions(
  sizes,
  paper,
  { margin = PAGE_MARGIN_MM, gap = DEFAULT_REGION_GAP_MM } = {},
) {
  const right = paper.width - margin;
  const bottom = paper.height - margin;
  const placements = [];

  let page = 0;
  let x = margin;
  let y = margin;
  let rowHeight = 0;

  sizes.forEach((size) => {
    if (x > margin + EPS && x + size.width > right + EPS) {
      x = margin;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    if (y > margin + EPS && y + size.height > bottom + EPS) {
      page += 1;
      x = margin;
      y = margin;
      rowHeight = 0;
    }
    placements.push({ page, x, y });
    x += size.width + gap;
    rowHeight = Math.max(rowHeight, size.height);
  });
  return placements;
}

/**
 * ページ内の各領域のはみ出し・重なりを検出する
 * @param {Array<{x: number, y: number, width: number, height: number}>} rects - 領域(mm)
 * @param {{width: number, height: number}} paper - 用紙(mm)
 * @param {number} [margin] - 余白(mm)
 * @returns {Array<{outOfBounds: boolean, overlaps: Array<number>}>}
 */
export function findLayoutIssues(rects, paper, margin = PAGE_MARGIN_MM) {
  return rects.map((rect, index) => {
    const outOfBounds =
      rect.x < margin - EPS ||
      rect.y < margin - EPS ||
      rect.x + rect.width > paper.width - margin + EPS ||
      rect.y + rect.height > paper.height - margin + EPS;
    const overlaps = [];
    rects.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      const overlapX = rect.x < other.x + other.width - EPS && other.x < rect.x + rect.width - EPS;
      const overlapY =
        rect.y < other.y + other.height - EPS && other.y < rect.y + rect.height - EPS;
      if (overlapX && overlapY) overlaps.push(otherIndex);
    });
    return { outOfBounds, overlaps };
  });
}

/**
 * 移動中の領域を、余白線・他領域の辺へ吸着させる
 * @param {{x: number, y: number, width: number, height: number}} rect - 移動後の領域(mm)
 * @param {Array<{x: number, y: number, width: number, height: number}>} others - 他の領域(mm)
 * @param {{width: number, height: number}} paper - 用紙(mm)
 * @param {Object} [options]
 * @param {number} [options.margin]
 * @param {number} [options.threshold]
 * @param {number} [options.gap] - 他領域に隣接するときの間隔
 * @returns {{x: number, y: number}}
 */
export function snapPosition(
  rect,
  others,
  paper,
  { margin = PAGE_MARGIN_MM, threshold = SNAP_THRESHOLD_MM, gap = DEFAULT_REGION_GAP_MM } = {},
) {
  const snapAxis = (position, size, lines) => {
    let best = position;
    let bestDistance = threshold + EPS;
    lines.forEach(({ at, edge }) => {
      // edge: 'start' は領域の始端を at へ、'end' は終端を at へ合わせる
      const candidate = edge === 'start' ? at : at - size;
      const distance = Math.abs(candidate - position);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    });
    return best;
  };

  const xLines = [
    { at: margin, edge: 'start' },
    { at: paper.width - margin, edge: 'end' },
  ];
  const yLines = [
    { at: margin, edge: 'start' },
    { at: paper.height - margin, edge: 'end' },
  ];
  others.forEach((other) => {
    xLines.push(
      { at: other.x, edge: 'start' },
      { at: other.x + other.width, edge: 'end' },
      { at: other.x + other.width + gap, edge: 'start' },
      { at: other.x - gap, edge: 'end' },
    );
    yLines.push(
      { at: other.y, edge: 'start' },
      { at: other.y + other.height, edge: 'end' },
      { at: other.y + other.height + gap, edge: 'start' },
      { at: other.y - gap, edge: 'end' },
    );
  });

  return {
    x: snapAxis(rect.x, rect.width, xLines),
    y: snapAxis(rect.y, rect.height, yLines),
  };
}

/**
 * どの領域にも含まれない（描画対象の）セル数を数える
 * @param {Array<{symbols: Array<string>, storyIds: Array<string>}>} regions
 * @param {Array<string>} storyIds - 全階ID
 * @param {Array<string>} symbols - 全符号
 * @param {(storyId: string, symbol: string) => boolean} [hasCell]
 * @returns {number}
 */
export function countUncoveredCells(regions, storyIds, symbols, hasCell) {
  const covered = new Set();
  regions.forEach((region) => {
    region.storyIds.forEach((id) => {
      region.symbols.forEach((symbol) => covered.add(`${id}\u0000${symbol}`));
    });
  });
  let count = 0;
  storyIds.forEach((id) => {
    symbols.forEach((symbol) => {
      if (hasCell && !hasCell(id, symbol)) return;
      if (!covered.has(`${id}\u0000${symbol}`)) count += 1;
    });
  });
  return count;
}

/**
 * 領域の既定見出し（例: 「30FL〜28FL / C1〜C3」）
 * @param {{symbols: Array<string>, storyIds: Array<string>}} region
 * @param {(storyId: string) => string} storyName - 階IDから階名
 * @returns {string}
 */
export function defaultRegionLabel(region, storyName) {
  const range = (items) =>
    items.length > 1 ? `${items[0]}〜${items[items.length - 1]}` : (items[0] ?? '');
  return `${range(region.storyIds.map(storyName))} / ${range(region.symbols)}`;
}
