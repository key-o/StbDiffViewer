/**
 * RC柱断面リストDXF出力。
 *
 * UIと同じ columnScheduleModel と共通作図プロファイルをDXFへ投影する。
 */

import { buildColumnScheduleGeometry } from '../../../components/rcColumnVisual/columnScheduleModel.js';
import {
  BASELINE_RC_SCHEDULE_PROFILE,
  getColumnScheduleDiagramModelHeight,
  getColumnSchedulePositionModelWidth,
  getScheduleInfoAreaModelHeight,
  getScheduleInfoRowModelHeight,
  resolveRcScheduleProfile,
} from '../../../components/rcScheduleProfile.js';
import { ConfiguredColumnSectionListRenderer } from './ConfiguredColumnSectionListRenderer.js';
import {
  BASELINE_COLUMN_COVER_FACES,
  normalizeColumnCoverFaces,
} from './columnSectionCover.js';
import {
  collectSectionListAdaptiveMetrics,
  createCenteredSectionProjection,
  drawSectionListInfoValues,
  drawSectionListSlotHeaders,
  getSectionListSlotCenter,
  resolveSectionListAdaptiveLayout,
} from './sectionListDxfLayoutUtils.js';
import {
  LAYERS,
  addRebarSymbol,
  createSectionListDxfEntityState,
  drawSectionListStoryRowScaffold,
  drawTableFrame,
  finalizeSectionListDxf,
  log,
  rectLines,
  updateSectionListCellBounds,
} from './sectionListDxfPrimitives.js';

const uiPresenter = new ConfiguredColumnSectionListRenderer({
  scaleDenominator: BASELINE_RC_SCHEDULE_PROFILE.scaleDenominator,
  coverFaces: BASELINE_COLUMN_COVER_FACES,
});

function stripHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

function formatDimensions(sectionData) {
  return stripHtml(uiPresenter.formatDimensions(sectionData)).replace(/×/g, 'x');
}

const COLUMN_INFO_ROWS = [
  {
    label: 'Dx × Dy',
    format: (sectionData) => formatDimensions(sectionData),
  },
  {
    label: '主筋',
    format: (sectionData, arrangement) =>
      stripHtml(uiPresenter.formatMainBar(sectionData, arrangement)),
  },
  {
    label: 'HOOP',
    format: (sectionData, arrangement) => stripHtml(uiPresenter.formatHoop(sectionData, arrangement)),
  },
  {
    // 添付基準DXFでは通常HOOPと同値。STBに独立値が無い場合は同値を表示する。
    label: '接合部HOOP',
    format: (sectionData, arrangement) => stripHtml(uiPresenter.formatHoop(sectionData, arrangement)),
  },
  {
    label: '備考',
    format: () => '',
  },
];

function drawColumnGeometry(lines2D, circles2D, geometry, cx, cy, scheduleProfile) {
  if (!geometry) return;
  const { x0, y0, dx, dy } = createCenteredSectionProjection(
    geometry.width,
    geometry.height,
    cx,
    cy,
  );

  if (geometry.kind === 'CIRCLE') {
    circles2D.push({
      center: { x: cx, y: cy },
      radius: geometry.diameter / 2,
      layer: LAYERS.CONCRETE,
    });
    if (geometry.hoop?.radius > 0) {
      circles2D.push({
        center: { x: cx, y: cy },
        radius: geometry.hoop.radius,
        layer: LAYERS.HOOP,
      });
    }
  } else {
    lines2D.push(...rectLines(x0, y0, geometry.width, geometry.height, LAYERS.CONCRETE));
    if (geometry.hoop) {
      lines2D.push(
        ...rectLines(
          dx(geometry.hoop.left),
          dy(geometry.hoop.bottom),
          geometry.hoop.right - geometry.hoop.left,
          geometry.hoop.bottom - geometry.hoop.top,
          LAYERS.HOOP,
        ),
      );
      geometry.hoop.innerLegs.forEach((leg) => {
        lines2D.push({
          start: { x: dx(leg.x1), y: dy(leg.y1) },
          end: { x: dx(leg.x2), y: dy(leg.y2) },
          layer: LAYERS.HOOP,
        });
      });
    }
  }

  [...geometry.mainBars, ...geometry.coreBars].forEach((bar) => {
    addRebarSymbol(
      lines2D,
      circles2D,
      bar.dia,
      dx(bar.x),
      dy(bar.y),
      LAYERS.REBAR,
      { profile: scheduleProfile },
    );
  });
}

function getCell(grid, storyId, symbol) {
  const raw = grid.get(storyId)?.get(symbol);
  return Array.isArray(raw) ? raw[0] : raw;
}

function getSectionDimension(sectionData) {
  return Math.max(
    Number(sectionData?.width) || 0,
    Number(sectionData?.height) || 0,
    Number(sectionData?.diameter) || 0,
  );
}

export async function exportConfiguredColumnSectionListToDxf(
  gridData,
  filename = 'rc-column-section-list',
  stbName = '',
  options = {},
) {
  const { stories, symbols, grid } = gridData;
  if (!stories?.length || !symbols?.length) {
    log.warn('断面データが空のためDXFを出力できません');
    return;
  }

  const scheduleProfile = resolveRcScheduleProfile(options.scheduleProfile || {});
  const coverFaces = normalizeColumnCoverFaces(
    options.coverFaces || scheduleProfile.column.hoopCenterFaces,
  );
  uiPresenter.setCoverFaces(coverFaces);
  uiPresenter.onBeforeGridRender(gridData);

  const infoRowH = getScheduleInfoRowModelHeight(scheduleProfile);
  const infoAreaH = getScheduleInfoAreaModelHeight(scheduleProfile);
  const metrics = collectSectionListAdaptiveMetrics({
    stories,
    symbols,
    getCell: (story, symbol) => getCell(grid, story.id, symbol),
    getEntries: (section) => uiPresenter.getArrangements(section),
    getEntryDimensions: (_arrangement, section) => {
      const dimension = getSectionDimension(section);
      return { width: dimension, height: dimension };
    },
  });
  const { columnWidths, diagramHeightsByStory, rowHeights } = resolveSectionListAdaptiveLayout({
    stories,
    symbols,
    metrics,
    infoAreaH,
    getPositionWidth: (dimension) =>
      getColumnSchedulePositionModelWidth(dimension, scheduleProfile),
    getDiagramHeight: (dimension) =>
      getColumnScheduleDiagramModelHeight(dimension, scheduleProfile),
  });

  const { lines2D, circles2D, texts2D, bounds } = createSectionListDxfEntityState();

  const frame = drawTableFrame({
    lines2D,
    texts2D,
    bounds,
    stories,
    symbols,
    cellW: columnWidths[0] || 1,
    columnWidths,
    cellH: rowHeights[0] || 1,
    rowHeights,
    stbName,
    cornerLabel: '符号',
    secondCornerLabel: '断面名',
    scheduleProfile,
  });

  drawSectionListSlotHeaders({
    texts2D,
    frame,
    symbols,
    entriesBySymbol: metrics.headerEntriesBySymbol,
    getLabels: (arrangements) => {
      const totals = arrangements.reduce((result, arrangement) => {
        result[arrangement.position] = (result[arrangement.position] || 0) + 1;
        return result;
      }, {});
      const indexes = {};
      return arrangements.map((arrangement) => {
        indexes[arrangement.position] = (indexes[arrangement.position] || 0) + 1;
        return uiPresenter.getPositionLabel(
          arrangement.position,
          indexes[arrangement.position],
          totals[arrangement.position],
        );
      });
    },
  });

  stories.forEach((story, rowIndex) => {
    const cellTopY = frame.rowTops[rowIndex];
    const cellBottomY = frame.rowBottoms[rowIndex];
    const diagramH = diagramHeightsByStory.get(story.id);
    const diagramBottomY = cellTopY - diagramH;
    const sectionCenterY = cellTopY - diagramH / 2;
    const storyCenterY = (cellTopY + cellBottomY) / 2;

    drawSectionListStoryRowScaffold({
      lines2D,
      texts2D,
      frame,
      storyLabel: story.name || story.id,
      storyCenterY,
      sectionCenterY,
      diagramBottomY,
      infoRowH,
      infoRows: COLUMN_INFO_ROWS,
    });

    symbols.forEach((symbol, columnIndex) => {
      const cellLeftX = frame.columnLefts[columnIndex];
      const cellWidth = frame.resolvedColumnWidths[columnIndex];
      const sectionData = getCell(grid, story.id, symbol);
      if (!sectionData) {
        updateSectionListCellBounds(bounds, cellLeftX, cellWidth, cellBottomY, cellTopY);
        return;
      }

      const arrangements = uiPresenter.getArrangements(sectionData);
      const sharedSlotCounts = uiPresenter.sectionSlotCounts.get(sectionData) || null;

      arrangements.forEach((arrangement, arrangementIndex) => {
        const posCx = getSectionListSlotCenter(
          cellLeftX,
          cellWidth,
          arrangements.length,
          arrangementIndex,
        );
        const svgData = uiPresenter.prepareSvgData(sectionData, arrangement);
        const geometry = buildColumnScheduleGeometry(svgData, {
          coverFaces,
          sharedSlotCounts,
        });
        drawColumnGeometry(
          lines2D,
          circles2D,
          geometry,
          posCx,
          sectionCenterY,
          scheduleProfile,
        );

        drawSectionListInfoValues({
          texts2D,
          rows: COLUMN_INFO_ROWS,
          centerX: posCx,
          diagramBottomY,
          infoRowH,
          getValue: (row) => row.format(sectionData, arrangement) || '',
        });
      });

      updateSectionListCellBounds(bounds, cellLeftX, cellWidth, cellBottomY, cellTopY);
    });
  });

  await finalizeSectionListDxf({
    bounds,
    lines2D,
    circles2D,
    texts2D,
    filename,
    logLabel: '柱断面リストDXF生成',
    stories,
    symbols,
    stbName,
    scheduleProfile,
  });
}

export const exportColumnSectionListToDxf = exportConfiguredColumnSectionListToDxf;
export default exportConfiguredColumnSectionListToDxf;
