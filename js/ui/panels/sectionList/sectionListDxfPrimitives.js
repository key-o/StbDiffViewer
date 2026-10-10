/**
 * @fileoverview 断面リストDXF出力の共通プリミティブ
 *
 * 柱・梁の断面リストDXF出力で共有するレイヤー定義、作図プロファイル、
 * 鉄筋記号、可変幅/可変高の表枠、DXF紙面投影を提供する。
 */

import {
  generateDxfContent,
  downloadDxf,
  DXF_OUTPUT_PROFILES,
} from '../../../export/dxf/stb-to-dxf/index.js';
import { createLogger } from '../../../utils/logger.js';
import {
  BASELINE_RC_SCHEDULE_PROFILE,
  getScheduleBarSymbolModelRadius,
  getScheduleFloorColumnModelWidth,
  getScheduleHeaderBandModelHeight,
  getScheduleHeaderModelHeight,
  getScheduleModelToPaperScale,
  getScheduleNormalTextModelHeight,
  getScheduleRowLabelColumnModelWidth,
  resolveRcScheduleProfile,
} from '../../../components/rcScheduleProfile.js';

export const log = createLogger('ui/SectionListDxfExporter');

export const LAYERS = {
  CONCRETE: 'CONCRETE',
  HOOP: 'HOOP',
  REBAR: 'REBAR',
  LABEL: 'LABEL',
  BORDER: 'BORDER',
};

/** 基準DXFの通常文字高さ。モデルmmで保持し最終投影時に紙面mmへ変換する。 */
export const LABEL_H = getScheduleNormalTextModelHeight(BASELINE_RC_SCHEDULE_PROFILE);

/** 基準DXFの「階10mm + 行見出し20mm」。 */
export const ROW_HEADER_W =
  getScheduleFloorColumnModelWidth(BASELINE_RC_SCHEDULE_PROFILE) +
  getScheduleRowLabelColumnModelWidth(BASELINE_RC_SCHEDULE_PROFILE);

export function addRebarSymbol(lines2D, circles2D, dia, cx, cy, layer, options = {}) {
  const profile = resolveRcScheduleProfile(options.profile || {});
  const configuredRadius = Number(options.radius);
  const r =
    Number.isFinite(configuredRadius) && configuredRadius > 0
      ? configuredRadius
      : getScheduleBarSymbolModelRadius(profile);
  const n = dia ? parseInt(String(dia).match(/\d+/)?.[0] || '0', 10) : 0;

  if (n <= 0 || n <= 12) {
    circles2D.push({ center: { x: cx, y: cy }, radius: r, layer });
  } else if (n === 13) {
    const s = r * 0.9;
    lines2D.push({ start: { x: cx - s, y: cy - s }, end: { x: cx + s, y: cy + s }, layer });
    lines2D.push({ start: { x: cx - s, y: cy + s }, end: { x: cx + s, y: cy - s }, layer });
  } else if (n <= 16) {
    circles2D.push({ center: { x: cx, y: cy }, radius: r, layer });
    const d = r * 0.707;
    lines2D.push({ start: { x: cx - d, y: cy - d }, end: { x: cx + d, y: cy + d }, layer });
  } else if (n <= 22) {
    circles2D.push({ center: { x: cx, y: cy }, radius: r, layer });
  } else if (n <= 25) {
    circles2D.push({ center: { x: cx, y: cy }, radius: r, layer });
    circles2D.push({ center: { x: cx, y: cy }, radius: r * 0.15, layer });
  } else if (n <= 29) {
    circles2D.push({ center: { x: cx, y: cy }, radius: r, layer });
    const d = r * 0.6;
    lines2D.push({ start: { x: cx - d, y: cy - d }, end: { x: cx + d, y: cy + d }, layer });
    lines2D.push({ start: { x: cx - d, y: cy + d }, end: { x: cx + d, y: cy - d }, layer });
  } else {
    circles2D.push({ center: { x: cx, y: cy }, radius: r, layer });
    circles2D.push({ center: { x: cx, y: cy }, radius: r * 0.65, layer });
  }
}

export function rectLines(x, y, w, h, layer) {
  return [
    { start: { x, y }, end: { x: x + w, y }, layer },
    { start: { x: x + w, y }, end: { x: x + w, y: y + h }, layer },
    { start: { x: x + w, y: y + h }, end: { x, y: y + h }, layer },
    { start: { x, y: y + h }, end: { x, y }, layer },
  ];
}

export function updateBounds(bounds, x, y) {
  bounds.min.x = Math.min(bounds.min.x, x);
  bounds.min.y = Math.min(bounds.min.y, y);
  bounds.max.x = Math.max(bounds.max.x, x);
  bounds.max.y = Math.max(bounds.max.y, y);
}

export function createSectionListColumnLayout(
  symbols,
  cellW,
  columnWidths = null,
  dataLeft = ROW_HEADER_W,
) {
  const fallback = Number(cellW) > 0 ? Number(cellW) : 1;
  const widths = symbols.map((_, index) => {
    const value = Number(columnWidths?.[index]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  });
  const lefts = [];
  let cursor = dataLeft;
  widths.forEach((width) => {
    lefts.push(cursor);
    cursor += width;
  });
  return { widths, lefts, tableRight: cursor };
}

/** 可変階高の上端/下端を共通化する。dataTop=0、下向きを負座標とする。 */
export function createSectionListRowLayout(stories, cellH, rowHeights = null) {
  const fallback = Number(cellH) > 0 ? Number(cellH) : 1;
  const heights = stories.map((_, index) => {
    const value = Number(rowHeights?.[index]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  });
  const tops = [];
  const bottoms = [];
  let cursor = 0;
  heights.forEach((height) => {
    tops.push(cursor);
    cursor -= height;
    bottoms.push(cursor);
  });
  return { heights, tops, bottoms, tableBottom: cursor };
}

function getTextHalfWidthUnits(value) {
  return Array.from(value).reduce((sum, char) => {
    const code = char.codePointAt(0);
    return sum + (code < 128 || (code >= 0xff61 && code <= 0xff9f) ? 1 : 2);
  }, 0);
}

/** Jw_cadはTEXTの中央揃えを使わないため、半角幅=高さ/2で挿入点へ変換する。 */
export function prepareSectionListDxfText(text, dxfProfile) {
  if (dxfProfile !== DXF_OUTPUT_PROFILES.JWCAD_R12 || text.anchor !== 'center') return text;
  return {
    ...text,
    position: {
      x: text.position.x - (getTextHalfWidthUnits(text.text) * text.height * text.widthFactor) / 4,
      y: text.position.y - text.height / 2,
    },
    anchor: 'left',
    verticalAlign: 'baseline',
  };
}

/** txt/extfont2の字幅に余裕を含め、長い文字列だけ幅を縮める。 */
export function createCenteredSectionListText(centerX, y, text, cellWidth) {
  // SHX/JISで表示できる横棒を欠損値にも使用する。
  const value = String(text ?? '').replace(/\u2014/g, '\u2015');
  const units = getTextHalfWidthUnits(value);
  const estimatedWidth = units * LABEL_H * 1.05;
  const availableWidth = Math.max(0, cellWidth - LABEL_H);
  return {
    position: { x: centerX, y },
    text: value,
    layer: LAYERS.LABEL,
    height: LABEL_H,
    anchor: 'center',
    verticalAlign: 'middle',
    widthFactor:
      estimatedWidth > 0 && availableWidth > 0 ? Math.min(1, availableWidth / estimatedWidth) : 1,
  };
}

export function createSectionListDxfEntityState() {
  return {
    lines2D: [],
    circles2D: [],
    texts2D: [],
    bounds: { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } },
  };
}

export function updateSectionListCellBounds(bounds, cellLeftX, cellWidth, cellBottomY, cellTopY) {
  updateBounds(bounds, cellLeftX, cellBottomY);
  updateBounds(bounds, cellLeftX + cellWidth, cellTopY);
}

export function drawSectionListStoryRowScaffold({
  lines2D,
  texts2D,
  frame,
  storyLabel,
  storyCenterY,
  sectionCenterY,
  diagramBottomY,
  infoRowH,
  infoRows,
  cellTopY = null,
  slotHeaderRows = [],
}) {
  texts2D.push(
    createCenteredSectionListText(
      frame.floorColumnW / 2,
      storyCenterY,
      storyLabel,
      frame.floorColumnW,
    ),
  );
  if (slotHeaderRows.length > 0 && Number.isFinite(cellTopY)) {
    slotHeaderRows.forEach((label, index) => {
      const y = cellTopY - infoRowH * (index + 0.5);
      texts2D.push(
        createCenteredSectionListText(
          frame.floorColumnW + frame.rowLabelColumnW / 2,
          y,
          label,
          frame.rowLabelColumnW,
        ),
      );
      const boundaryY = cellTopY - infoRowH * (index + 1);
      lines2D.push({
        start: { x: frame.floorColumnW, y: boundaryY },
        end: { x: frame.tableRight, y: boundaryY },
        layer: LAYERS.BORDER,
      });
    });
  }

  texts2D.push(
    createCenteredSectionListText(
      frame.floorColumnW + frame.rowLabelColumnW / 2,
      sectionCenterY,
      '断面',
      frame.rowLabelColumnW,
    ),
  );

  for (let boundaryIndex = 0; boundaryIndex < infoRows.length; boundaryIndex += 1) {
    const y = diagramBottomY - infoRowH * boundaryIndex;
    lines2D.push({
      start: { x: frame.floorColumnW, y },
      end: { x: frame.tableRight, y },
      layer: LAYERS.BORDER,
    });
  }

  infoRows.forEach((row, infoIndex) => {
    const y = diagramBottomY - infoRowH * (infoIndex + 0.5);
    texts2D.push(
      createCenteredSectionListText(
        frame.floorColumnW + frame.rowLabelColumnW / 2,
        y,
        row.label,
        frame.rowLabelColumnW,
      ),
    );
  });
}

/**
 * 基準DXFと同じ二段ヘッダー、階列、行見出し列、可変列幅/階高の表枠を描画する。
 */
export function drawTableFrame({
  lines2D,
  texts2D,
  bounds,
  stories,
  symbols,
  cellW,
  columnWidths = null,
  cellH,
  rowHeights = null,
  stbName,
  cornerLabel = '符号',
  secondCornerLabel = '',
  scheduleProfile = null,
}) {
  const profile = resolveRcScheduleProfile(scheduleProfile || {});
  const tableLeft = 0;
  const floorColumnW = getScheduleFloorColumnModelWidth(profile);
  const rowLabelColumnW = getScheduleRowLabelColumnModelWidth(profile);
  const dataLeft = floorColumnW + rowLabelColumnW;
  const headerH = getScheduleHeaderModelHeight(profile);
  const headerBandH = getScheduleHeaderBandModelHeight(profile);
  const layout = createSectionListColumnLayout(symbols, cellW, columnWidths, dataLeft);
  const rowLayout = createSectionListRowLayout(stories, cellH, rowHeights);
  const tableRight = layout.tableRight;
  const tableTop = headerH;
  const tableBottom = rowLayout.tableBottom;

  if (stbName) {
    texts2D.push({
      position: { x: tableLeft, y: tableTop + LABEL_H * 1.5 },
      text: stbName,
      layer: LAYERS.LABEL,
      height: LABEL_H,
    });
    updateBounds(bounds, tableLeft, tableTop + LABEL_H * 3);
  }

  lines2D.push(
    ...rectLines(
      tableLeft,
      tableBottom,
      tableRight - tableLeft,
      tableTop - tableBottom,
      LAYERS.BORDER,
    ),
  );

  lines2D.push({
    start: { x: tableLeft, y: 0 },
    end: { x: tableRight, y: 0 },
    layer: LAYERS.BORDER,
  });
  lines2D.push({
    start: { x: floorColumnW, y: headerBandH },
    end: { x: tableRight, y: headerBandH },
    layer: LAYERS.BORDER,
  });

  lines2D.push({
    start: { x: floorColumnW, y: tableBottom },
    end: { x: floorColumnW, y: tableTop },
    layer: LAYERS.BORDER,
  });
  lines2D.push({
    start: { x: dataLeft, y: tableBottom },
    end: { x: dataLeft, y: tableTop },
    layer: LAYERS.BORDER,
  });

  layout.lefts.forEach((left, index) => {
    if (index === 0) return;
    lines2D.push({
      start: { x: left, y: tableBottom },
      end: { x: left, y: tableTop },
      layer: LAYERS.BORDER,
    });
  });

  rowLayout.bottoms.forEach((bottom, index) => {
    if (index === rowLayout.bottoms.length - 1) return;
    lines2D.push({
      start: { x: tableLeft, y: bottom },
      end: { x: tableRight, y: bottom },
      layer: LAYERS.BORDER,
    });
  });

  const headerTopRowY = headerBandH + (headerH - headerBandH) / 2;
  const headerSecondRowY = headerBandH / 2;
  texts2D.push(createCenteredSectionListText(floorColumnW / 2, headerBandH, '階', floorColumnW));
  texts2D.push(
    createCenteredSectionListText(
      floorColumnW + rowLabelColumnW / 2,
      headerTopRowY,
      cornerLabel,
      rowLabelColumnW,
    ),
  );
  if (secondCornerLabel) {
    texts2D.push(
      createCenteredSectionListText(
        floorColumnW + rowLabelColumnW / 2,
        headerSecondRowY,
        secondCornerLabel,
        rowLabelColumnW,
      ),
    );
  }

  symbols.forEach((symbol, ci) => {
    const cx = layout.lefts[ci] + layout.widths[ci] / 2;
    texts2D.push(createCenteredSectionListText(cx, headerTopRowY, symbol, layout.widths[ci]));
    updateBounds(bounds, cx, tableTop);
  });

  return {
    tableLeft,
    tableRight,
    tableTop,
    tableBottom,
    dataLeft,
    floorColumnW,
    rowLabelColumnW,
    headerTopRowY,
    headerSecondRowY,
    columnLefts: layout.lefts,
    resolvedColumnWidths: layout.widths,
    rowTops: rowLayout.tops,
    rowBottoms: rowLayout.bottoms,
    resolvedRowHeights: rowLayout.heights,
  };
}

export function scaleSectionListDxfEntities({ bounds, lines2D, circles2D, texts2D }, scale) {
  const s = Number(scale);
  const factor = Number.isFinite(s) && s > 0 ? s : 1;
  const point = (value) => ({ x: value.x * factor, y: value.y * factor });
  return {
    bounds: {
      min: point(bounds.min),
      max: point(bounds.max),
    },
    lines2D: lines2D.map((line) => ({
      ...line,
      start: point(line.start),
      end: point(line.end),
    })),
    circles2D: circles2D.map((circle) => ({
      ...circle,
      center: point(circle.center),
      radius: circle.radius * factor,
    })),
    texts2D: texts2D.map((text) => ({
      ...text,
      position: point(text.position),
      height: Number(text.height) * factor,
    })),
  };
}

export async function finalizeSectionListDxf({
  bounds,
  lines2D,
  circles2D,
  texts2D,
  filename,
  logLabel,
  stories,
  symbols,
  stbName,
  scheduleProfile = null,
  dxfProfile = null,
}) {
  if (!isFinite(bounds.min.x)) {
    bounds.min = { x: 0, y: -10000 };
    bounds.max = { x: 10000, y: 0 };
  }

  const profile = scheduleProfile
    ? resolveRcScheduleProfile(scheduleProfile)
    : BASELINE_RC_SCHEDULE_PROFILE;
  const projected = scaleSectionListDxfEntities(
    { bounds, lines2D, circles2D, texts2D },
    getScheduleModelToPaperScale(profile),
  );
  const layerNames = Object.values(LAYERS);

  log.info(logLabel, {
    stories: stories.length,
    symbols: symbols.length,
    lines: lines2D.length,
    circles: circles2D.length,
    texts: texts2D.length,
    stbName,
    scaleDenominator: profile.scaleDenominator,
  });

  const dxfContent = generateDxfContent(
    projected.bounds,
    layerNames,
    projected.lines2D,
    projected.texts2D.map((text) => prepareSectionListDxfText(text, dxfProfile)),
    projected.circles2D,
    {
      textStyle: {
        fontFile: 'txt',
        bigFontFile: dxfProfile === DXF_OUTPUT_PROFILES.JWCAD_R12 ? '' : 'extfont2.shx',
      },
    },
  );
  await downloadDxf(dxfContent, filename, null, { profile: dxfProfile });
}
