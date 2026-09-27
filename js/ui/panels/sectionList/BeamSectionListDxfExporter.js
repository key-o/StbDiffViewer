/**
 * @fileoverview RC梁断面リストDXF出力モジュール
 *
 * UIと同じ梁断面プレゼンテーションモデル、位置圧縮、作図プロファイルをDXFへ投影する。
 */

import { buildBeamScheduleGeometry } from '../../../components/rcBeamVisual/beamScheduleModel.js';
import {
  getBeamScheduleDiagramModelHeight,
  getBeamSchedulePositionModelWidth,
  getScheduleInfoAreaModelHeight,
  getScheduleInfoRowModelHeight,
  resolveRcScheduleProfile,
} from '../../../components/rcScheduleProfile.js';
import { BeamSectionListRenderer } from './BeamSectionListRenderer.js';
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

const uiPresenter = new BeamSectionListRenderer();

const BEAM_INFO_ROWS = [
  {
    label: 'B x D',
    format: (p) => (Number(p?.width) > 0 && Number(p?.depth) > 0 ? `${p.width}×${p.depth}` : '-'),
  },
  { label: '上端筋', format: (p) => uiPresenter.formatBarCountText(p?.topBar) },
  { label: '下端筋', format: (p) => uiPresenter.formatBarCountText(p?.bottomBar) },
  { label: 'STP', format: (p) => uiPresenter.formatStirrupText(p?.stirrup) },
  { label: '腹筋', format: (p) => uiPresenter.formatBarCountText(p?.webBar) },
];

function getCell(grid, storyId, symbol) {
  const raw = grid.get(`${storyId}:${symbol}`);
  return Array.isArray(raw) ? raw[0] : raw;
}

function drawBeamSectionEntities(lines2D, circles2D, positionData, cx, cy, options = {}) {
  const scheduleProfile = resolveRcScheduleProfile(options.scheduleProfile || {});
  const geometry = buildBeamScheduleGeometry(positionData, {
    drawingCoverOverride:
      Number(options.coverThickness) > 0 ? Number(options.coverThickness) : null,
    profile: scheduleProfile,
  });
  if (!geometry) return;

  const W = geometry.width;
  const D = geometry.depth;
  const { x0, y0, dx, dy } = createCenteredSectionProjection(W, D, cx, cy);

  lines2D.push(...rectLines(x0, y0, W, D, LAYERS.CONCRETE));

  if (geometry.stirrup) {
    const stirrupW = geometry.stirrup.right - geometry.stirrup.left;
    const stirrupH = geometry.stirrup.bottom - geometry.stirrup.top;
    if (stirrupW > 0 && stirrupH > 0) {
      lines2D.push(
        ...rectLines(
          dx(geometry.stirrup.left),
          dy(geometry.stirrup.bottom),
          stirrupW,
          stirrupH,
          LAYERS.HOOP,
        ),
      );
    }
    geometry.stirrup.innerLegs.forEach((leg) => {
      lines2D.push({
        start: { x: dx(leg.x), y: dy(leg.top) },
        end: { x: dx(leg.x), y: dy(leg.bottom) },
        layer: LAYERS.HOOP,
      });
    });
  }

  geometry.mainBars.forEach((bar) => {
    addRebarSymbol(lines2D, circles2D, bar.dia, dx(bar.x), dy(bar.y), LAYERS.REBAR, {
      profile: scheduleProfile,
    });
  });
  geometry.webBars.forEach((bar) => {
    addRebarSymbol(lines2D, circles2D, bar.dia, dx(bar.x), dy(bar.y), LAYERS.REBAR, {
      profile: scheduleProfile,
    });
  });
}

export async function exportBeamSectionListToDxf(
  gridData,
  filename = 'rc-beam-section-list',
  stbName = '',
  options = {},
) {
  const { stories, symbols, grid } = gridData;
  if (!stories?.length || !symbols?.length) {
    log.warn('梁断面データが空のためDXFを出力できません');
    return;
  }

  const scheduleProfile = resolveRcScheduleProfile(options.scheduleProfile || {});
  uiPresenter.setScheduleProfile(scheduleProfile);
  const infoRowH = getScheduleInfoRowModelHeight(scheduleProfile);
  const infoAreaH = getScheduleInfoAreaModelHeight(scheduleProfile);

  const metrics = collectSectionListAdaptiveMetrics({
    stories,
    symbols,
    getCell: (story, symbol) => getCell(grid, story.id, symbol),
    getEntries: (cell) =>
      uiPresenter.getRenderablePositionEntries(cell.positions, cell.positionPattern),
    getEntryDimensions: (entry) => ({
      width: Number(entry.data?.width) || 0,
      height: Number(entry.data?.depth) || 0,
    }),
  });
  const { columnWidths, diagramHeightsByStory, rowHeights } = resolveSectionListAdaptiveLayout({
    stories,
    symbols,
    metrics,
    infoAreaH,
    getPositionWidth: (width) => getBeamSchedulePositionModelWidth(width, scheduleProfile),
    getDiagramHeight: (depth) => getBeamScheduleDiagramModelHeight(depth, scheduleProfile),
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
    secondCornerLabel: '位置',
    scheduleProfile,
  });

  drawSectionListSlotHeaders({
    texts2D,
    frame,
    symbols,
    entriesBySymbol: metrics.headerEntriesBySymbol,
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
      infoRows: BEAM_INFO_ROWS,
    });

    symbols.forEach((symbol, columnIndex) => {
      const cellLeftX = frame.columnLefts[columnIndex];
      const cellWidth = frame.resolvedColumnWidths[columnIndex];
      const cell = getCell(grid, story.id, symbol);
      if (!cell) {
        updateSectionListCellBounds(bounds, cellLeftX, cellWidth, cellBottomY, cellTopY);
        return;
      }

      const entries = uiPresenter.getRenderablePositionEntries(
        cell.positions,
        cell.positionPattern,
      );
      entries.forEach((entry, positionIndex) => {
        const positionData = entry.data;
        const drawingPositionData = {
          ...positionData,
          // SVGと同じく、位置別coverが無い旧形式では断面共通coverを引き継ぐ。
          // coverオブジェクトに保持したsourceCover/mainCentersメタデータも同じ参照で渡す。
          cover: positionData?.cover || cell.cover || null,
        };
        const posCx = getSectionListSlotCenter(cellLeftX, cellWidth, entries.length, positionIndex);

        drawBeamSectionEntities(lines2D, circles2D, drawingPositionData, posCx, sectionCenterY, {
          ...options,
          scheduleProfile,
        });

        drawSectionListInfoValues({
          texts2D,
          rows: BEAM_INFO_ROWS,
          centerX: posCx,
          diagramBottomY,
          infoRowH,
          getValue: (row) => row.format(positionData),
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
    logLabel: '梁断面リストDXF生成',
    stories,
    symbols,
    stbName,
    scheduleProfile,
  });
}
