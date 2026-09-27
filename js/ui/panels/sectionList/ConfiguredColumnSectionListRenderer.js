/**
 * RC柱断面リスト用レンダラー。
 * 既存の表レイアウトに共通作図プロファイルと4面別かぶりを適用する。
 *
 * グリッド表示ではDXFと同様に、階ごとに断面図帯と仕様行の高さを共有する。
 * 項目名は階列の右隣に1列だけ設け、各断面セルには値のみを描画する。
 */

import { ColumnSectionListRenderer } from './ColumnSectionListRenderer.js';
import { resolveRcScheduleProfile } from '../../../components/rcScheduleProfile.js';
import { BASELINE_COLUMN_COVER_FACES } from '../../../components/rcColumnVisual/columnSectionCover.js';

const GRID_NAME_ROW_HEIGHT = 22;
const GRID_POSITION_ROW_HEIGHT = 22;
const GRID_SPEC_ROW_HEIGHT = 22;
const GRID_LABEL_COLUMN_WIDTH = 78;
const GRID_FLOOR_COLUMN_WIDTH = 70;

export class ConfiguredColumnSectionListRenderer extends ColumnSectionListRenderer {
  constructor(options = {}) {
    const scheduleProfile = resolveRcScheduleProfile(options.scheduleProfile || {});
    super({
      ...options,
      scaleDenominator:
        Number(options.scaleDenominator) > 0
          ? Number(options.scaleDenominator)
          : scheduleProfile.scaleDenominator,
      previewDpi:
        Number(options.previewDpi) > 0 ? Number(options.previewDpi) : scheduleProfile.previewDpi,
    });
    this.scheduleProfile = scheduleProfile;
    this.svgRenderer.setCoverFaces(options.coverFaces || BASELINE_COLUMN_COVER_FACES);
    this.svgRenderer.setScheduleProfile(this.scheduleProfile);
  }

  setCoverFaces(coverFaces) {
    this.svgRenderer.setCoverFaces(coverFaces);
  }

  setScheduleProfile(scheduleProfile) {
    this.scheduleProfile = resolveRcScheduleProfile(scheduleProfile || {});
    this.scaleOptions.scaleDenominator = this.scheduleProfile.scaleDenominator;
    this.scaleOptions.previewDpi = this.scheduleProfile.previewDpi;
    this.svgRenderer.setScheduleProfile(this.scheduleProfile);
  }

  /** @override */
  renderGridHeader(symbols) {
    return this.renderLabeledGridHeader(symbols, {
      floorColumnWidth: GRID_FLOOR_COLUMN_WIDTH,
      labelColumnWidth: GRID_LABEL_COLUMN_WIDTH,
    });
  }

  /** @override */
  renderGridBody(stories, symbols, grid) {
    return this.renderLabeledGridBody(stories, symbols, grid, {
      floorColumnWidth: GRID_FLOOR_COLUMN_WIDTH,
      labelColumnWidth: GRID_LABEL_COLUMN_WIDTH,
    });
  }

  /**
   * 1階内で最も大きい豆図のSVG高さを求める。
   * 小さい断面はこの共通帯の中央へ配置される。
   */
  getStoryDiagramHeight(story, symbols, grid) {
    const scale = this.lastComputedScale?.scale || this.computeFixedScale().scale;
    const padding = Number(this.svgRenderer?.settings?.padding) || 0;
    const minimum = padding * 2 + 16;
    let maximum = minimum;

    symbols.forEach((symbol) => {
      const raw = this.getGridCellData(grid, story.id, symbol);
      const sections = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
      sections.forEach((sectionData) => {
        const sectionHeight = this.getSectionModelHeight(sectionData);
        if (sectionHeight > 0) maximum = Math.max(maximum, sectionHeight * scale + padding * 2);
      });
    });

    return Math.ceil(maximum);
  }

  getSectionModelHeight(sectionData) {
    if (!sectionData) return 0;
    if (sectionData.isCircular || Number(sectionData.diameter) > 0) {
      return Number(sectionData.diameter) || 0;
    }
    return Number(sectionData.height) || 0;
  }

  getGridSpecLabels() {
    const labels = ['B×D / Fc', '主筋', '主筋材料', '1段目dt'];
    if (this.options.showCoreBar) labels.push('芯鉄筋');
    labels.push('帯筋');
    return labels;
  }

  getGridSpecValues(sectionData, arrangement) {
    const dimText = this.formatDimensions(sectionData);
    const concreteStrength = sectionData.concrete?.strength;
    const concreteText = `${dimText} / ${concreteStrength ? this.escapeHtml(concreteStrength) : '—'}`;
    const values = [
      concreteText,
      this.formatMainBar(sectionData, arrangement),
      this.formatMainGrade(arrangement.mainBar),
      this.formatDt(sectionData, arrangement) || '—',
    ];
    if (this.options.showCoreBar) {
      values.push(arrangement.coreBar ? this.formatCoreBar(sectionData, arrangement) : '—');
    }
    values.push(this.formatHoop(sectionData, arrangement));
    return values;
  }

  renderGridRowLabels(diagramHeight) {
    const specRows = this.getGridSpecLabels()
      .map(
        (label, index) =>
          `<div class="column-grid-spec-label" style="height:${GRID_SPEC_ROW_HEIGHT}px;box-sizing:border-box;display:flex;align-items:center;padding:3px 4px;white-space:nowrap;${index > 0 ? 'border-top:1px solid var(--border-color, #ccc);' : ''}">${this.escapeHtml(label)}</div>`,
      )
      .join('');

    return [
      '<div class="section-cell-content column-grid-row-labels" style="display:flex;flex-direction:column;width:100%;height:auto;">',
      `<div class="section-cell-name" style="height:${GRID_NAME_ROW_HEIGHT}px;box-sizing:border-box;margin-bottom:0;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--border-color, #ccc);">断面名</div>`,
      `<div class="column-arrangement-label" style="height:${GRID_POSITION_ROW_HEIGHT}px;box-sizing:border-box;margin:0;padding:3px 5px;border-bottom:1px solid var(--border-color, #ccc);background:var(--bg-tertiary, #e8e8e8);">位置</div>`,
      `<div class="section-cell-diagram column-grid-diagram-label" style="height:${diagramHeight}px;box-sizing:border-box;margin:0;padding:3px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--border-color, #ccc);background:white;">断面</div>`,
      `<div class="column-grid-spec-labels" style="background:var(--bg-secondary, #f5f5f5);">${specRows}</div>`,
      '</div>',
    ].join('');
  }

  renderGridCell(rawSectionData, diagramHeight) {
    const sections = this.getUniqueGridSections(rawSectionData);
    if (sections.length === 1) return this.renderGridSection(sections[0], diagramHeight);

    return `<div class="section-cell-variants" style="display:grid;grid-template-columns:repeat(${sections.length},minmax(0,1fr));justify-content:stretch;gap:0;width:100%;">${sections
      .map((sectionData) => this.renderGridSection(sectionData, diagramHeight))
      .join('')}</div>`;
  }

  getUniqueGridSections(rawSectionData) {
    const source = Array.isArray(rawSectionData) ? rawSectionData : [rawSectionData];
    const seen = new Set();
    return source.filter((sectionData) => {
      const { dedupeId } = this.getSectionIdentifiers(sectionData);
      const key = `${dedupeId}:${sectionData?.symbolNames || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  renderGridSection(sectionData, diagramHeight) {
    const arrangements = this.getArrangements(sectionData);
    const totals = arrangements.reduce((result, arrangement) => {
      result[arrangement.position] = (result[arrangement.position] || 0) + 1;
      return result;
    }, {});
    const indexes = {};
    const arrangementHtml = arrangements
      .map((arrangement) => {
        indexes[arrangement.position] = (indexes[arrangement.position] || 0) + 1;
        const positionLabel = this.getPositionLabel(
          arrangement.position,
          indexes[arrangement.position],
          totals[arrangement.position],
        );
        const svgData = this.prepareSvgData(sectionData, arrangement);
        const svgString = this.svgRenderer.renderToString(svgData, {
          fixedScale: this.lastComputedScale?.scale,
          sharedSlotCounts: this.sectionSlotCounts.get(sectionData) || null,
        });
        const values = this.getGridSpecValues(sectionData, arrangement)
          .map(
            (value, index) =>
              `<div class="column-grid-spec-value" style="height:${GRID_SPEC_ROW_HEIGHT}px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;padding:3px 5px;white-space:nowrap;${index > 0 ? 'border-top:1px solid var(--border-color, #ccc);' : ''}">${value || '—'}</div>`,
          )
          .join('');

        return [
          '<div class="column-arrangement-item" style="display:flex;flex-direction:column;width:100%;min-width:0;border-right:1px solid var(--border-color, #ccc);background:white;">',
          `<div class="column-arrangement-label" style="height:${GRID_POSITION_ROW_HEIGHT}px;box-sizing:border-box;margin:0;padding:3px 5px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--border-color, #ccc);background:var(--bg-tertiary, #e8e8e8);">${positionLabel}</div>`,
          `<div class="section-cell-diagram" style="height:${diagramHeight}px;box-sizing:border-box;margin:0;padding:3px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--border-color, #ccc);">${svgString}</div>`,
          `<div class="column-grid-spec-values">${values}</div>`,
          '</div>',
        ].join('');
      })
      .join('');

    return [
      '<div class="section-cell-content column-section-cell column-grid-section-cell" style="display:flex;flex-direction:column;width:100%;height:auto;">',
      `<div class="section-cell-name" style="height:${GRID_NAME_ROW_HEIGHT}px;box-sizing:border-box;margin-bottom:0;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--border-color, #ccc);">${this.escapeHtml(sectionData.symbolNames || '')}</div>`,
      `<div class="column-arrangements-container${arrangements.length > 1 ? ' is-multiple' : ''}" style="display:grid;grid-template-columns:repeat(${arrangements.length},minmax(0,1fr));justify-content:stretch;gap:0;width:100%;">${arrangementHtml}</div>`,
      '</div>',
    ].join('');
  }

  renderEmptyGridCell(diagramHeight) {
    const blankRows = this.getGridSpecLabels()
      .map(
        (_, index) =>
          `<div style="height:${GRID_SPEC_ROW_HEIGHT}px;box-sizing:border-box;${index > 0 ? 'border-top:1px solid var(--border-color, #ccc);' : ''}"></div>`,
      )
      .join('');
    return [
      '<div class="section-cell-content column-grid-empty-cell" style="display:flex;flex-direction:column;width:100%;height:auto;">',
      `<div style="height:${GRID_NAME_ROW_HEIGHT}px;box-sizing:border-box;border-bottom:1px solid var(--border-color, #ccc);"></div>`,
      `<div style="height:${GRID_POSITION_ROW_HEIGHT}px;box-sizing:border-box;border-bottom:1px solid var(--border-color, #ccc);"></div>`,
      `<div class="section-cell-empty" style="height:${diagramHeight}px;min-height:0;box-sizing:border-box;padding:0;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--border-color, #ccc);">-</div>`,
      `<div>${blankRows}</div>`,
      '</div>',
    ].join('');
  }
}

export default ConfiguredColumnSectionListRenderer;
