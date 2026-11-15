/** S柱・S梁断面リストの共通DXF/シート用モデルmm図形。 */
import { steelSectionProfileParts, appendSteelProfileEntities } from './steelSectionProfile.js';
import { srcDiagramExtent, appendSrcSectionEntities } from './srcSectionDiagram.js';
import { SRC_SCHEDULE_SPEC_ROWS, srcScheduleSpecValues, estimateSrcSpecSlotWidthPx } from './srcScheduleSpecRows.js';
import { BASELINE_RC_SCHEDULE_PROFILE } from '../../../components/rcScheduleProfile.js';
import {
  createSectionListDxfEntityState,
  createCenteredSectionListText,
  drawSectionListStoryRowScaffold,
  drawTableFrame,
  finalizeSectionListDxf,
  LAYERS,
} from './sectionListDxfPrimitives.js';

const LABEL_ROWS = Object.freeze(['位置', '形状', '材質']);
const INFO_ROW_HEIGHT = 220;

export function buildSteelSectionListEntities({ stories, symbols, grid, type }, stbName = '') {
  const isSrc = type === 'src-column' || type === 'src-beam';
  const rows = isSrc ? SRC_SCHEDULE_SPEC_ROWS.map((row) => row.label) : LABEL_ROWS;
  if (!stories?.length || !symbols?.length) return null;
  let maxWidth = 700,
    maxDepth = 700,
    maxPositions = 1;
  for (const cell of grid.values()) {
    maxPositions = Math.max(maxPositions, cell.variants.length);
    for (const variant of cell.variants) {
      const geo = isSrc ? srcDiagramExtent(variant) : steelSectionProfileParts(variant.profile);
      maxWidth = Math.max(maxWidth, geo?.width || 0);
      maxDepth = Math.max(maxDepth, geo?.height || 0);
    }
  }
  // SRCはRC梁と同じく符号ごとの最大位置数・列幅を使用する。
  // S造の既存DXFグリッドは変更しない。
  const srcSlotWidths = new Map();
  const srcSlotCounts = new Map();
  if (isSrc) {
    const pxToModelMm = 25.4 / BASELINE_RC_SCHEDULE_PROFILE.previewDpi *
      BASELINE_RC_SCHEDULE_PROFILE.scaleDenominator;
    for (const symbol of symbols) {
      let positionCount = 1;
      let width = 700 + 350;
      for (const story of stories) {
        const cell = grid.get(story.id + ':' + symbol);
        if (!cell) continue;
        positionCount = Math.max(positionCount, cell.variants.length);
        for (const variant of cell.variants) {
          const extent = srcDiagramExtent(variant);
          width = Math.max(width,
            extent.width + 350,
            Math.ceil(estimateSrcSpecSlotWidthPx(variant) * pxToModelMm));
        }
      }
      srcSlotWidths.set(symbol, width);
      srcSlotCounts.set(symbol, positionCount);
    }
  }

  // mmで実寸断面を描く。複数位置でも変形縮小せず、スロットを広げる。
  const slotW = maxWidth + 350;
  const colW = slotW * maxPositions;
  const diagramH = maxDepth + 350;
  const srcHeaderH = isSrc ? 2 * INFO_ROW_HEIGHT : 0;
  const rowH = srcHeaderH + diagramH + rows.length * INFO_ROW_HEIGHT;
  const { lines2D, circles2D, texts2D, bounds } = createSectionListDxfEntityState();
  const frame = drawTableFrame({
    lines2D,
    texts2D,
    bounds,
    stories,
    symbols,
    cellW: colW,
    columnWidths: isSrc ? symbols.map((symbol) => srcSlotWidths.get(symbol) * srcSlotCounts.get(symbol)) : null,
    cellH: rowH,
    stbName,
    cornerLabel: '符号',
    secondCornerLabel: '位置',
  });
  stories.forEach((story, rowIndex) => {
    const top = frame.rowTops[rowIndex];
    const bottom = top - rowH;
    const diagramTop = top - srcHeaderH;
    const diagramBottom = diagramTop - diagramH;
    texts2D.push(
      createCenteredSectionListText(
        frame.floorColumnW / 2,
        (top + bottom) / 2,
        story.name,
        frame.floorColumnW,
      ),
    );
    if (isSrc) {
      // RCの行見出し枠生成と同じ経路。Fc/主筋等は常に独立した水平帯に置く。
      drawSectionListStoryRowScaffold({
        lines2D, texts2D, frame,
        storyLabel: '', storyCenterY: (top + bottom) / 2,
        sectionCenterY: diagramTop - diagramH / 2,
        diagramBottomY: diagramBottom,
        infoRowH: INFO_ROW_HEIGHT,
        infoRows: rows.map((label) => ({ label })),
        cellTopY: top, slotHeaderRows: ['断面名', '位置'],
      });
    } else {
      rows.forEach((label, i) => {
        texts2D.push(createCenteredSectionListText(
          frame.floorColumnW + frame.rowLabelColumnW / 2,
          diagramBottom - (i + 0.5) * INFO_ROW_HEIGHT,
          label,
          frame.rowLabelColumnW,
        ));
      });
      lines2D.push({
        start: { x: frame.floorColumnW, y: diagramBottom },
        end: { x: frame.tableRight, y: diagramBottom },
        layer: LAYERS.BORDER,
      });
    }
    symbols.forEach((symbol, columnIndex) => {
      const cell = grid.get(story.id + ':' + symbol);
      const left = frame.columnLefts[columnIndex];
      const symbolSlotW = isSrc ? srcSlotWidths.get(symbol) : slotW;
      const symbolCount = isSrc ? srcSlotCounts.get(symbol) : maxPositions;
      if (isSrc) {
        // 断面定義のない階にも位置スロットの縦罫線を描く。
        for (let slot = 1; slot < symbolCount; slot++) {
          const x = left + symbolSlotW * slot;
          lines2D.push({
            start: { x, y: top }, end: { x, y: bottom }, layer: LAYERS.BORDER,
          });
        }
      }
      if (!cell) return;
      cell.variants.forEach((variant, positionIndex) => {
        const cx = left + symbolSlotW * (positionIndex + 0.5);
        if (isSrc) {
          const extent = srcDiagramExtent(variant);
          const ox = (extent.minX + extent.maxX) / 2 || 0;
          const oy = (extent.minY + extent.maxY) / 2 || 0;
          appendSrcSectionEntities(
            variant, cx - ox, diagramTop - diagramH / 2 - oy, lines2D, circles2D,
          );
          texts2D.push(createCenteredSectionListText(
            cx, top - INFO_ROW_HEIGHT / 2, cell.name || symbol, symbolSlotW,
          ));
          texts2D.push(createCenteredSectionListText(
            cx, top - INFO_ROW_HEIGHT * 1.5, variant.pos, symbolSlotW,
          ));
          const values = srcScheduleSpecValues(variant);
          values.forEach((value, i) => {
            texts2D.push(createCenteredSectionListText(
              cx, diagramBottom - (i + 0.5) * INFO_ROW_HEIGHT, value, symbolSlotW,
            ));
          });
        } else {
          const geo = steelSectionProfileParts(variant.profile);
          appendSteelProfileEntities(geo, cx, top - diagramH / 2, lines2D, circles2D);
          const steelGrade = [
            variant.strengthMain,
            variant.strengthWeb && variant.strengthWeb !== variant.strengthMain ? variant.strengthWeb : '',
          ].filter(Boolean).join('/') || '-';
          [variant.pos, variant.shape, steelGrade].forEach((value, i) => {
            texts2D.push(createCenteredSectionListText(
              cx, diagramBottom - (i + 0.5) * INFO_ROW_HEIGHT, value, symbolSlotW,
            ));
          });
        }
      });
    });
  });
  return { lines2D, circles2D, texts2D, bounds, stories, symbols };
}

export async function exportSteelSectionListToDxf(grid, filename, stbName, options = {}) {
  const built = buildSteelSectionListEntities(grid, stbName);
  if (!built) return;
  await finalizeSectionListDxf({
    ...built,
    filename,
    stbName,
    dxfProfile: options.dxfProfile,
    logLabel: 'S・SRC柱梁断面リストDXF生成',
  });
}
