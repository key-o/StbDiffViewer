/**
 * @fileoverview 断面リストPDFのシート(ビュー)分割ロジック
 *
 * 断面リスト(階 × 符号のグリッド)を、簡易CADのビューのように
 * 「階の集合 × 符号の集合」=シートへ割り当てる。各シートは指定縮尺の実寸のまま
 * 1枚の用紙(A3等)に載せる。ここでは寸法計算とシート自動分割(タイル割り)、
 * クローン済みテーブルの絞り込みを扱う。
 *
 * @module ui/sectionList/sectionListPageSplit
 */

/** CSSピクセル(96dpi)→mm。断面図は previewDpi=96 で縮尺どおりの実寸になる */
export const MM_PER_PX = 25.4 / 96;

/** 用紙余白(mm) */
export const PAGE_MARGIN_MM = 10;

/** 用紙定義（横/縦はorientationで表現） */
export const PAPER_SIZES = {
  'a3-landscape': {
    label: 'A3 横',
    format: 'a3',
    orientation: 'landscape',
    width: 420,
    height: 297,
  },
  'a3-portrait': { label: 'A3 縦', format: 'a3', orientation: 'portrait', width: 297, height: 420 },
  'a4-landscape': {
    label: 'A4 横',
    format: 'a4',
    orientation: 'landscape',
    width: 297,
    height: 210,
  },
  'a4-portrait': { label: 'A4 縦', format: 'a4', orientation: 'portrait', width: 210, height: 297 },
};

export const DEFAULT_PAPER_KEY = 'a3-landscape';

/**
 * 用紙の描画可能領域(px換算)
 * @param {string} paperKey
 * @returns {{width: number, height: number}} CSS px
 */
export function getPrintableAreaPx(paperKey) {
  const paper = PAPER_SIZES[paperKey] || PAPER_SIZES[DEFAULT_PAPER_KEY];
  return {
    width: (paper.width - PAGE_MARGIN_MM * 2) / MM_PER_PX,
    height: (paper.height - PAGE_MARGIN_MM * 2) / MM_PER_PX,
  };
}

/**
 * 寸法列を先頭から貪欲に詰め、固定寸法 + 合計が上限に収まる範囲ごとに分ける。
 * 1要素だけで上限を超える場合も、その要素単独のグループとして必ず進める。
 * @param {Array<number>} sizes - 各要素の寸法(px)
 * @param {number} fixed - 常に必要な固定寸法(px)
 * @param {number} limit - 上限(px)
 * @returns {Array<Array<number>>} 要素インデックスのグループ
 */
export function groupIndexesByExtent(sizes, fixed, limit) {
  const groups = [];
  let current = [];
  let used = fixed;
  sizes.forEach((size, index) => {
    if (current.length > 0 && used + size > limit) {
      groups.push(current);
      current = [];
      used = fixed;
    }
    current.push(index);
    used += size;
  });
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * シートの推定寸法(px)。列幅は含める階の行の最大セル幅（`cellWidths`）を使い、
 * 無ければ `colWidths` にフォールバックする。
 * @param {{symbols: Array<string>, storyIds: Array<string>}} sheet
 * @param {Object} metrics - measureGridTable の結果
 * @returns {{width: number, height: number}}
 */
export function estimateSheetSize(sheet, metrics) {
  const columnWidth = (symbol) => {
    const perStory = sheet.storyIds
      .map((id) => metrics.cellWidths?.[id]?.[symbol])
      .filter((width) => Number.isFinite(width));
    return perStory.length > 0 ? Math.max(...perStory) : metrics.colWidths[symbol] || 0;
  };
  const width = metrics.fixedWidth + sheet.symbols.reduce((sum, s) => sum + columnWidth(s), 0);
  const height =
    metrics.headerHeight +
    sheet.storyIds.reduce((sum, id) => sum + (metrics.rowHeights[id] || 0), 0);
  return { width, height };
}

/**
 * シートが用紙の描画可能領域に実寸で収まるか
 * @param {{symbols: Array<string>, storyIds: Array<string>}} sheet
 * @param {Object} metrics
 * @param {string} paperKey
 * @returns {boolean}
 */
export function sheetFitsPaper(sheet, metrics, paperKey) {
  const size = estimateSheetSize(sheet, metrics);
  const area = getPrintableAreaPx(paperKey);
  return size.width <= area.width && size.height <= area.height;
}

/**
 * 区切り位置(各グループの最後の要素)から要素インデックスのグループを作る
 * @param {Array<string>} keys - 要素キー(表示順)
 * @param {Iterable<string>} breakAfter - 「この要素の直後で区切る」キー
 * @returns {Array<Array<number>>} インデックスのグループ
 */
export function groupsFromBreaks(keys, breakAfter) {
  const breaks = new Set(breakAfter);
  const groups = [];
  let current = [];
  keys.forEach((key, index) => {
    current.push(index);
    if (breaks.has(key) && index < keys.length - 1) {
      groups.push(current);
      current = [];
    }
  });
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * グループから区切り位置(各グループの最後のキー、最終グループを除く)を求める
 * @param {Array<string>} keys
 * @param {Array<Array<number>>} groups
 * @returns {Array<string>}
 */
export function breaksFromGroups(keys, groups) {
  return groups.slice(0, -1).map((group) => keys[group[group.length - 1]]);
}

/**
 * 列・行の区切りからシート(階グループ × 符号グループ)を組み立てる。
 * 階グループを外側、符号グループを内側として番号を振る。
 * 描画対象のセルが無いシートは `empty` とし、番号を持たず出力されない。
 * @param {Object} params
 * @param {Array<string>} params.symbols - 符号(表示順)
 * @param {Array<string>} params.storyIds - 階ID(表示順)
 * @param {Iterable<string>} params.colBreakAfter - この符号の直後で区切る
 * @param {Iterable<string>} params.rowBreakAfter - この階の直後で区切る
 * @param {(storyId: string, symbol: string) => boolean} [params.hasCell]
 * @returns {{
 *   colGroups: Array<Array<number>>,
 *   rowGroups: Array<Array<number>>,
 *   tiles: Array<{rowGroup: number, colGroup: number, number: number|null, symbols: Array<string>, storyIds: Array<string>}>,
 *   sheets: Array<{symbols: Array<string>, storyIds: Array<string>}>
 * }}
 */
export function buildSheetGrid({ symbols, storyIds, colBreakAfter, rowBreakAfter, hasCell }) {
  const colGroups = groupsFromBreaks(symbols, colBreakAfter);
  const rowGroups = groupsFromBreaks(storyIds, rowBreakAfter);

  const tiles = [];
  const sheets = [];
  rowGroups.forEach((rows, rowGroup) => {
    colGroups.forEach((cols, colGroup) => {
      const tile = {
        rowGroup,
        colGroup,
        number: null,
        symbols: cols.map((i) => symbols[i]),
        storyIds: rows.map((i) => storyIds[i]),
      };
      const hasAny =
        !hasCell || tile.storyIds.some((id) => tile.symbols.some((symbol) => hasCell(id, symbol)));
      if (hasAny) {
        sheets.push({ symbols: tile.symbols, storyIds: tile.storyIds });
        tile.number = sheets.length;
      }
      tiles.push(tile);
    });
  });
  return { colGroups, rowGroups, tiles, sheets };
}

/**
 * 用紙に実寸で収まるよう、階×符号の区切り位置を自動で決める。
 * まず階方向を行高で貪欲に詰めて階グループを決め、次に符号方向を、
 * すべての階グループで用紙幅に収まる範囲まで貪欲に詰める。
 * 列幅は階グループごとに「含める階の最大セル幅」で評価する（幅の広いセルを含まない
 * 階グループは列を多く詰められる）。
 * @param {Object} params
 * @param {Array<string>} params.symbols - 符号(表示順)
 * @param {Array<string>} params.storyIds - 階ID(表示順)
 * @param {Object} params.metrics - measureGridTable の結果
 * @param {string} params.paperKey - 用紙キー
 * @returns {{colBreakAfter: Array<string>, rowBreakAfter: Array<string>}}
 */
export function autoBreaks({ symbols, storyIds, metrics, paperKey }) {
  const area = getPrintableAreaPx(paperKey);
  const rowGroups = groupIndexesByExtent(
    storyIds.map((id) => metrics.rowHeights[id] || 0),
    metrics.headerHeight,
    area.height,
  );

  const widthIn = (symbol, rowGroup) => {
    const widths = rowGroup
      .map((index) => metrics.cellWidths?.[storyIds[index]]?.[symbol])
      .filter((width) => Number.isFinite(width));
    return widths.length > 0 ? Math.max(...widths) : metrics.colWidths[symbol] || 0;
  };

  const colGroups = [];
  let current = [];
  let used = rowGroups.map(() => metrics.fixedWidth);
  symbols.forEach((symbol, index) => {
    const widths = rowGroups.map((rowGroup) => widthIn(symbol, rowGroup));
    const overflow = widths.some((width, i) => used[i] + width > area.width);
    if (current.length > 0 && overflow) {
      colGroups.push(current);
      current = [];
      used = rowGroups.map(() => metrics.fixedWidth);
    }
    current.push(index);
    used = used.map((sum, i) => sum + widths[i]);
  });
  if (current.length > 0) colGroups.push(current);

  return {
    colBreakAfter: breaksFromGroups(symbols, colGroups),
    rowBreakAfter: breaksFromGroups(storyIds, rowGroups),
  };
}

/**
 * グリッドテーブルから、指定した符号の列・階の行だけを残す（クローン上で破壊的に変更）
 * 符号列はヘッダー行の `section-grid-header-symbol` で判別し、階・項目などの固定列と
 * ヘッダー行は常に残す。階行は tbody の行順を `allStoryIds` の順に対応付ける。
 * 残した符号列は `symbols` の並び順に並べ替える（固定列は先頭のまま）。
 * @param {HTMLTableElement} table - クローン済みテーブル
 * @param {Object} selection
 * @param {Array<string>} selection.symbols - 残す符号
 * @param {Array<string>} selection.storyIds - 残す階ID
 * @param {Array<string>} selection.allStoryIds - tbody行順に対応する全階ID
 */
export function keepOnlyGridCells(table, { symbols, storyIds, allStoryIds }) {
  const keepStories = new Set(storyIds);

  const headerRow = table.querySelector('thead tr');
  if (headerRow) {
    const fixedIndexes = [];
    const symbolIndex = new Map();
    [...headerRow.children].forEach((th, index) => {
      if (th.classList.contains('section-grid-header-symbol')) {
        symbolIndex.set(th.textContent.trim(), index);
      } else {
        fixedIndexes.push(index);
      }
    });
    const order = [
      ...fixedIndexes,
      ...symbols
        .filter((symbol) => symbolIndex.has(symbol))
        .map((symbol) => symbolIndex.get(symbol)),
    ];
    table.querySelectorAll('tr').forEach((tr) => {
      const cells = [...tr.children];
      cells.forEach((cell) => cell.remove());
      order.forEach((index) => {
        if (cells[index]) tr.appendChild(cells[index]);
      });
    });
  }

  [...table.querySelectorAll('tbody tr')].forEach((tr, index) => {
    if (!keepStories.has(allStoryIds[index])) tr.remove();
  });
}

/**
 * 画像を用紙の左上(余白位置)へ置いたときの配置(mm)を求める。
 * `mmPerPx` で換算した自然寸法のまま置き、描画可能領域を超える場合のみ縮小する
 * （拡大はしない）。
 * @param {{width: number, height: number}} size - 画像の自然寸法(CSS px)
 * @param {{width: number, height: number}} paper - 用紙(mm)
 * @param {number} mmPerPx - 1pxあたりのmm（実寸配置なら MM_PER_PX、従来フィットは1）
 * @returns {{x: number, y: number, width: number, height: number, ratio: number, shrunk: boolean}}
 */
export function computeSheetPlacement(size, paper, mmPerPx) {
  const naturalWidth = size.width * mmPerPx;
  const naturalHeight = size.height * mmPerPx;
  const ratio = Math.min(
    (paper.width - PAGE_MARGIN_MM * 2) / naturalWidth,
    (paper.height - PAGE_MARGIN_MM * 2) / naturalHeight,
    1,
  );
  return {
    x: PAGE_MARGIN_MM,
    y: PAGE_MARGIN_MM,
    width: naturalWidth * ratio,
    height: naturalHeight * ratio,
    ratio,
    shrunk: ratio < 1,
  };
}
