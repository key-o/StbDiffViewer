/**
 * SRC柱・SRC梁リストのRC梁型固定行レイアウト。
 * RCのBaseSectionListRenderer.renderLabeledGridHeader/Bodyを共用し、
 * 断面図の大小・位置数・文字列長にかかわらず項目のY座標を固定する。
 */
import { BaseSectionListRenderer } from './BaseSectionListRenderer.js';
import { srcSectionDiagramSvg, srcDiagramExtent } from './srcSectionDiagram.js';
import {
  SRC_SCHEDULE_SPEC_ROWS, srcScheduleSpecValues, estimateSrcSpecSlotWidthPx,
} from './srcScheduleSpecRows.js';
export { SRC_SCHEDULE_SPEC_ROWS } from './srcScheduleSpecRows.js';

export const SRC_SCHEDULE_NAME_ROW_HEIGHT = 24;
export const SRC_SCHEDULE_POSITION_ROW_HEIGHT = 28;
export const SRC_SCHEDULE_SPEC_ROW_HEIGHT = 42;
const LABEL_WIDTH = 112;
const FLOOR_WIDTH = 70;
const SLOT_MIN_WIDTH = 190;
const DIAGRAM_MIN_HEIGHT = 100;

export class SrcSectionListRenderer extends BaseSectionListRenderer {
  constructor() {
    super(null);
    this.scaleDenominator = 40;
    this.symbolSlotWidths = new Map();
    this.symbolSlotCounts = new Map();
  }

  setScaleDenominator(value) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) this.scaleDenominator = number;
  }

  getScaleLabel() {
    return '1/' + this.scaleDenominator;
  }

  getEmptyMessage() {
    return 'SRC断面データがありません';
  }

  getGridTableClassName() {
    // 既存PDF分割・シート編集ではsteel-section-grid-tableを認識する。
    return 'steel-section-grid-table src-section-grid-table';
  }

  getGridCellData(grid, storyId, symbol) {
    return grid.get(storyId + ':' + symbol);
  }

  getSectionIdentifiers(section) {
    return { dedupeId: section.id, labelId: section.id };
  }

  onBeforeGridRender({ symbols, grid }) {
    this.symbolSlotWidths = new Map();
    this.symbolSlotCounts = new Map();
    const pxPerMm = (96 / 25.4) / this.scaleDenominator;
    for (const symbol of symbols) {
      let slotWidth = SLOT_MIN_WIDTH;
      let count = 1;
      for (const section of grid.values()) {
        if (section.name !== symbol) continue;
        count = Math.max(count, section.variants.length);
        for (const variant of section.variants) {
          const extent = srcDiagramExtent(variant);
          const pad = Math.max(extent.width, extent.height) * 0.08;
          slotWidth = Math.max(
            slotWidth,
            Math.ceil((extent.width + 2 * pad) * pxPerMm + 20),
            estimateSrcSpecSlotWidthPx(variant),
          );
        }
      }
      this.symbolSlotWidths.set(symbol, slotWidth);
      this.symbolSlotCounts.set(symbol, count);
    }
  }

  renderGridHeader(symbols) {
    const thead = this.renderLabeledGridHeader(symbols, {
      floorColumnWidth: FLOOR_WIDTH, labelColumnWidth: LABEL_WIDTH,
    });
    thead.querySelectorAll('.section-grid-header-symbol').forEach((th, index) => {
      const symbol = symbols[index];
      const fullWidth = this.symbolSlotWidths.get(symbol) * this.symbolSlotCounts.get(symbol);
      th.style.minWidth = fullWidth + 'px';
      th.style.width = fullWidth + 'px';
      th.style.boxSizing = 'border-box';
    });
    return thead;
  }

  renderGridBody(stories, symbols, grid) {
    return this.renderLabeledGridBody(stories, symbols, grid, {
      floorColumnWidth: FLOOR_WIDTH, labelColumnWidth: LABEL_WIDTH,
    });
  }

  getStoryDiagramHeight(story, symbols, grid) {
    const pxPerMm = (96 / 25.4) / this.scaleDenominator;
    let height = DIAGRAM_MIN_HEIGHT;
    for (const symbol of symbols) {
      const section = this.getGridCellData(grid, story.id, symbol);
      for (const variant of section?.variants || []) {
        const extent = srcDiagramExtent(variant);
        const pad = Math.max(extent.width, extent.height) * 0.08;
        height = Math.max(height, Math.ceil((extent.height + 2 * pad) * pxPerMm + 10));
      }
    }
    return height;
  }

  renderGridRowLabels(diagramHeight) {
    const row = (css, text, extra = '') => '<div class="' + css + '" ' + extra + '>' +
      this.escapeHtml(text) + '</div>';
    return '<div class="src-grid-row-labels">' +
      row('src-grid-name src-grid-label', '断面名') +
      row('src-grid-position src-grid-label', '位置') +
      row('src-grid-diagram src-grid-label', '断面', 'style="height:' + diagramHeight + 'px"') +
      SRC_SCHEDULE_SPEC_ROWS.map(({ label }) => row('src-grid-spec-label src-grid-label', label)).join('') +
      '</div>';
  }

  renderPositionSlot(section, variant, diagramHeight, width, index) {
    const name = index === 0 ? (section?.name || '') : '';
    const diagram = variant ? srcSectionDiagramSvg(variant, this.scaleDenominator) : '—';
    const displayedValues = variant ? srcScheduleSpecValues(variant) : [];
    const values = SRC_SCHEDULE_SPEC_ROWS.map((_, i) => {
      const safe = this.escapeHtml(displayedValues[i] || '');
      return '<div class="src-grid-spec-value" title="' + safe + '" tabindex="0">' + safe + '</div>';
    }).join('');
    return '<div class="src-grid-position-slot' + (variant ? '' : ' src-grid-empty-slot') + '" style="width:' + width + 'px">' +
      '<div class="src-grid-name" title="' + this.escapeHtml(name) + '">' + this.escapeHtml(name) + '</div>' +
      '<div class="src-grid-position">' + (variant ? this.escapeHtml(variant.pos || '全断面') : '') + '</div>' +
      '<div class="src-grid-diagram" style="height:' + diagramHeight + 'px">' + diagram + '</div>' +
      '<div class="src-grid-spec-values">' + values + '</div>' +
      '</div>';
  }

  renderGridCell(section, diagramHeight) {
    const count = this.symbolSlotCounts.get(section.name) || section.variants.length || 1;
    const width = this.symbolSlotWidths.get(section.name) || SLOT_MIN_WIDTH;
    const slots = Array.from({ length: count }, (_, index) =>
      this.renderPositionSlot(section, section.variants[index] || null, diagramHeight, width, index)).join('');
    return '<div class="src-grid-position-slots">' + slots + '</div>';
  }

  renderEmptyGridCell(diagramHeight, symbol) {
    // RCの共通グリッドから符号を受け取り、使用階に断面定義がない場合も
    // その符号の最大位置数・各スロット幅を維持する（PDF分割でも同じ罫線）。
    const count = this.symbolSlotCounts.get(symbol) || 1;
    const width = this.symbolSlotWidths.get(symbol) || SLOT_MIN_WIDTH;
    const slots = Array.from({ length: count }, (_, index) =>
      this.renderPositionSlot(null, null, diagramHeight, width, index)).join('');
    return '<div class="src-grid-position-slots src-grid-empty">' + slots + '</div>';
  }

  renderGrid(data, container) {
    super.renderGrid(data, container);
    if (container) container.dataset.sectionListType = data.type;
  }
}
