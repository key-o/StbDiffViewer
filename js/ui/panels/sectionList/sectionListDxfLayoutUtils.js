import { LABEL_H, LAYERS, centeredTextX } from './sectionListDxfPrimitives.js';

/**
 * 断面中心を基準に、上向きローカルY座標をDXFのモデル座標へ投影する。
 * 柱・梁とも schedule model は左上原点相当の座標を保持するため、Yだけ反転する。
 */
export function createCenteredSectionProjection(width, height, cx, cy) {
  const x0 = cx - width / 2;
  const y0 = cy - height / 2;
  return {
    x0,
    y0,
    dx: (x) => x0 + x,
    dy: (y) => y0 + height - y,
  };
}

/**
 * 1セルを等幅スロットへ分割したときの指定スロット中心Xを返す。
 */
export function getSectionListSlotCenter(cellLeftX, cellWidth, slotCount, slotIndex) {
  const count = Math.max(1, Number.parseInt(slotCount, 10) || 0);
  const slotW = cellWidth / count;
  return cellLeftX + slotW * (slotIndex + 0.5);
}

/**
 * 柱・梁断面リストの可変幅/可変高DXFに共通する最大寸法を集計する。
 * セルの取得、位置配列の解決、位置ごとの幅/高さだけを呼出側へ委譲する。
 */
export function collectSectionListAdaptiveMetrics({
  stories,
  symbols,
  getCell,
  getEntries,
  getEntryDimensions,
}) {
  const maxEntryWidthBySymbol = new Map(symbols.map((symbol) => [symbol, 0]));
  const maxEntryCountBySymbol = new Map(symbols.map((symbol) => [symbol, 1]));
  const headerEntriesBySymbol = new Map();
  const maxEntryHeightByStory = new Map(stories.map((story) => [story.id, 0]));

  stories.forEach((story) => {
    symbols.forEach((symbol) => {
      const cell = getCell(story, symbol);
      if (!cell) return;
      const entries = getEntries(cell, story, symbol) || [];
      if ((headerEntriesBySymbol.get(symbol)?.length || 0) < entries.length) {
        headerEntriesBySymbol.set(symbol, entries);
      }
      maxEntryCountBySymbol.set(
        symbol,
        Math.max(maxEntryCountBySymbol.get(symbol) || 1, entries.length || 1),
      );
      entries.forEach((entry) => {
        const dimensions = getEntryDimensions(entry, cell, story, symbol) || {};
        maxEntryWidthBySymbol.set(
          symbol,
          Math.max(maxEntryWidthBySymbol.get(symbol) || 0, Number(dimensions.width) || 0),
        );
        maxEntryHeightByStory.set(
          story.id,
          Math.max(maxEntryHeightByStory.get(story.id) || 0, Number(dimensions.height) || 0),
        );
      });
    });
  });

  return {
    maxEntryWidthBySymbol,
    maxEntryCountBySymbol,
    headerEntriesBySymbol,
    maxEntryHeightByStory,
  };
}

/**
 * 集計済み最大寸法から、符号列幅・階行高を共通形式で解決する。
 */
export function resolveSectionListAdaptiveLayout({
  stories,
  symbols,
  metrics,
  infoAreaH,
  getPositionWidth,
  getDiagramHeight,
}) {
  const positionWidthsBySymbol = new Map(
    symbols.map((symbol) => [
      symbol,
      getPositionWidth(metrics.maxEntryWidthBySymbol.get(symbol) || 0, symbol),
    ]),
  );
  const columnWidths = symbols.map(
    (symbol) =>
      positionWidthsBySymbol.get(symbol) *
      Math.max(1, metrics.maxEntryCountBySymbol.get(symbol) || 1),
  );
  const diagramHeightsByStory = new Map(
    stories.map((story) => [
      story.id,
      getDiagramHeight(metrics.maxEntryHeightByStory.get(story.id) || 0, story),
    ]),
  );
  const rowHeights = stories.map(
    (story) => diagramHeightsByStory.get(story.id) + infoAreaH,
  );

  return {
    positionWidthsBySymbol,
    columnWidths,
    diagramHeightsByStory,
    rowHeights,
  };
}

/**
 * 符号列ごとの位置/断面名ヘッダーを等幅スロットへ配置する。
 * ラベルの意味付けは構造種別側に残し、DXF上の配置だけを共通化する。
 */
export function drawSectionListSlotHeaders({
  texts2D,
  frame,
  symbols,
  entriesBySymbol,
  getLabels = (entries) => entries.map((entry) => entry?.label || ''),
}) {
  symbols.forEach((symbol, columnIndex) => {
    const entries = entriesBySymbol.get(symbol) || [];
    const labels = getLabels(entries, symbol);
    const cellLeftX = frame.columnLefts[columnIndex];
    const cellWidth = frame.resolvedColumnWidths[columnIndex];

    labels.forEach((label, entryIndex) => {
      const cx = getSectionListSlotCenter(cellLeftX, cellWidth, entries.length, entryIndex);
      texts2D.push({
        position: { x: centeredTextX(cx, label), y: frame.headerSecondRowY },
        text: label,
        layer: LAYERS.LABEL,
        height: LABEL_H,
      });
    });
  });
}

/**
 * 断面スロット下部の情報行値を、行中心へ揃えて配置する。
 */
export function drawSectionListInfoValues({
  texts2D,
  rows,
  centerX,
  diagramBottomY,
  infoRowH,
  getValue,
}) {
  rows.forEach((row, infoIndex) => {
    const value = getValue(row, infoIndex) ?? '';
    const y = diagramBottomY - infoRowH * (infoIndex + 0.5);
    texts2D.push({
      position: { x: centeredTextX(centerX, value), y },
      text: value,
      layer: LAYERS.LABEL,
      height: LABEL_H,
    });
  });
}
