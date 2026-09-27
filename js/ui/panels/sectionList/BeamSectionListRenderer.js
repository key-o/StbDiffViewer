/**
 * @fileoverview RC梁断面リストテーブルレンダラー
 *
 * グリッド形式（階×符号）のRC梁断面リストテーブルをHTMLとして描画します。
 * 各セルに複数位置の断面図（LEFT/CENTER/RIGHT）と詳細情報を埋め込みます。
 *
 * @module ui/sectionList/BeamSectionListRenderer
 */

import { BaseSectionListRenderer } from './BaseSectionListRenderer.js';
import { RcBeamVisualRenderer } from '../../../components/rcBeamVisual/index.js';
import { resolveRcScheduleProfile } from '../../../components/rcScheduleProfile.js';
import { resolveBeamSchedulePositionEntries } from '../../../components/rcBeamVisual/beamSchedulePresentation.js';

const GRID_NAME_ROW_HEIGHT = 22;
const GRID_POSITION_ROW_HEIGHT = 22;
const GRID_SPEC_ROW_HEIGHT = 22;
const GRID_LABEL_COLUMN_WIDTH = 78;
const GRID_FLOOR_COLUMN_WIDTH = 70;
const GRID_POSITION_MIN_WIDTH = 116;

export class BeamSectionListRenderer extends BaseSectionListRenderer {
  constructor(options = {}) {
    const scheduleProfile = resolveRcScheduleProfile(options.scheduleProfile || {});
    const svgRenderer = new RcBeamVisualRenderer({
      maxWidth: options.svgWidth || 100,
      maxHeight: options.svgHeight || 100,
      padding: options.svgPadding || 15,
      barScale: options.barScale || 0.8,
      showDimensions: false,
    });

    super(svgRenderer);

    this.scheduleProfile = scheduleProfile;
    this.scaleOptions = {
      scaleDenominator:
        Number(options.scaleDenominator) > 0
          ? Number(options.scaleDenominator)
          : scheduleProfile.scaleDenominator,
      previewDpi:
        Number(options.previewDpi) > 0 ? Number(options.previewDpi) : scheduleProfile.previewDpi,
      maxDiagramWidth: Number(options.maxDiagramWidth) > 0 ? Number(options.maxDiagramWidth) : 90,
      maxDiagramHeight:
        Number(options.maxDiagramHeight) > 0 ? Number(options.maxDiagramHeight) : 90,
    };

    this.lastComputedScale = null;
    this.sectionSlotCounts = new WeakMap();
    this.coverThickness =
      Number(options.coverThickness) > 0 ? Number(options.coverThickness) : null;

    this.options = {
      showPositionLabels: options.showPositionLabels !== false,
      compactMode: options.compactMode || false,
    };
  }

  /** @override */
  getEmptyMessage() {
    return 'RC梁断面データがありません';
  }

  /** @override */
  getGridTableClassName() {
    return 'beam-section-grid-table';
  }

  /** @override */
  getGridCellData(grid, storyId, symbol) {
    return grid.get(`${storyId}:${symbol}`);
  }

  /** @override */
  getSectionIdentifiers(sectionData) {
    const dedupeId = sectionData?.sectionId || sectionData?.id || '';
    const labelId = sectionData?.sectionId || '';
    return { dedupeId, labelId };
  }

  /** @override */
  onBeforeGridRender(data) {
    this.lastComputedScale = this.computeUnifiedScale(data);
    this.indexSymbolSlotCounts(data);
  }

  /** @override */
  onEmptyGrid() {
    this.lastComputedScale = null;
    this.sectionSlotCounts = new WeakMap();
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
   * 1階内で最も大きい梁豆図のSVG高さを求める。
   * 梁せいが小さい豆図は、この共通断面図帯の中央へ配置される。
   */
  getStoryDiagramHeight(story, symbols, grid) {
    const scale = this.lastComputedScale?.scale || this.computeUnifiedScale({ grid })?.scale || 0;
    const padding = Number(this.svgRenderer?.settings?.padding) || 0;
    const minimum = padding * 2 + 16;
    let maximum = minimum;

    symbols.forEach((symbol) => {
      const raw = this.getGridCellData(grid, story.id, symbol);
      const sections = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
      sections.forEach((sectionData) => {
        this.getRenderablePositionEntries(
          sectionData?.positions,
          sectionData?.positionPattern,
        ).forEach((entry) => {
          const depth = Number(entry.data?.depth) || 0;
          if (depth > 0) maximum = Math.max(maximum, depth * scale + padding * 2);
        });
      });
    });

    return Math.ceil(maximum);
  }

  getGridSpecLabels() {
    return ['B×D', '上端筋', '下端筋', 'あばら筋', '腹筋', 'Fc', '主筋材料', 'あばら筋材料'];
  }

  getGridSpecValues(sectionData, positionData) {
    const dimensionText =
      Number(positionData?.width) > 0 && Number(positionData?.depth) > 0
        ? `${positionData.width}×${positionData.depth}`
        : '-';
    return [
      dimensionText,
      this.formatBarCountText(positionData?.topBar),
      this.formatBarCountText(positionData?.bottomBar),
      this.formatStirrupText(positionData?.stirrup),
      this.formatBarCountText(positionData?.webBar),
      sectionData?.concrete?.strength || '-',
      this.collectPositionGrades(positionData, ['topBar', 'bottomBar']),
      this.collectPositionGrades(positionData, ['stirrup']),
    ];
  }

  renderGridRowLabels(diagramHeight) {
    const specRows = this.getGridSpecLabels()
      .map(
        (label, index) =>
          `<div class="beam-grid-spec-label" style="height:${GRID_SPEC_ROW_HEIGHT}px;box-sizing:border-box;display:flex;align-items:center;padding:3px 4px;white-space:nowrap;${index > 0 ? 'border-top:1px solid var(--border-color, #ccc);' : ''}">${this.escapeHtml(label)}</div>`,
      )
      .join('');

    return [
      '<div class="section-cell-content beam-grid-row-labels" style="display:flex;flex-direction:column;width:100%;height:auto;gap:0;">',
      `<div class="section-cell-name" style="height:${GRID_NAME_ROW_HEIGHT}px;box-sizing:border-box;margin:0;padding:0;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--border-color, #ccc);border-radius:0;">断面名</div>`,
      `<div class="beam-grid-position-label" style="height:${GRID_POSITION_ROW_HEIGHT}px;box-sizing:border-box;margin:0;padding:3px 5px;display:flex;align-items:center;border-bottom:1px solid var(--border-color, #ccc);background:var(--bg-tertiary, #e8e8e8);">位置</div>`,
      `<div class="beam-grid-diagram-label" style="height:${diagramHeight}px;box-sizing:border-box;margin:0;padding:3px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--border-color, #ccc);background:white;">断面</div>`,
      `<div class="beam-grid-spec-labels" style="background:var(--bg-secondary, #f5f5f5);">${specRows}</div>`,
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
    const positionEntries = this.getRenderablePositionEntries(
      sectionData?.positions,
      sectionData?.positionPattern,
    );
    const entries =
      positionEntries.length > 0 ? positionEntries : [{ key: '', label: '—', data: null }];

    const positionHtml = entries
      .map((entry) => {
        const positionData = entry.data;
        let svgString = '';
        if (positionData) {
          const beamDataForSvg = {
            ...positionData,
            cover: positionData?.cover || sectionData.cover || null,
          };
          svgString = this.svgRenderer.renderToString(beamDataForSvg, {
            fixedScale: this.lastComputedScale?.scale,
            sharedSlotCount: this.sectionSlotCounts.get(sectionData) || null,
            scheduleProfile: this.scheduleProfile,
            drawingCoverOverride: this.coverThickness,
          });
        }

        const values = this.getGridSpecValues(sectionData, positionData)
          .map(
            (value, index) =>
              `<div class="beam-grid-spec-value" style="height:${GRID_SPEC_ROW_HEIGHT}px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;padding:3px 5px;white-space:nowrap;${index > 0 ? 'border-top:1px solid var(--border-color, #ccc);' : ''}">${this.escapeHtml(value || '-')}</div>`,
          )
          .join('');

        return [
          `<div class="beam-grid-position-item" style="display:flex;flex-direction:column;width:100%;min-width:${GRID_POSITION_MIN_WIDTH}px;border-right:1px solid var(--border-color, #ccc);background:white;">`,
          `<div class="beam-grid-position-value" style="height:${GRID_POSITION_ROW_HEIGHT}px;box-sizing:border-box;margin:0;padding:3px 5px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--border-color, #ccc);background:var(--bg-tertiary, #e8e8e8);font-weight:var(--font-weight-bold);">${this.escapeHtml(entry.label || '—')}</div>`,
          `<div class="beam-section-diagram" style="height:${diagramHeight}px;box-sizing:border-box;margin:0;padding:3px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--border-color, #ccc);">${svgString}</div>`,
          `<div class="beam-grid-spec-values">${values}</div>`,
          '</div>',
        ].join('');
      })
      .join('');

    return [
      '<div class="section-cell-content beam-section-cell beam-grid-section-cell" style="display:flex;flex-direction:column;width:100%;height:auto;gap:0;">',
      `<div class="section-cell-name" style="height:${GRID_NAME_ROW_HEIGHT}px;box-sizing:border-box;margin:0;padding:0 4px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--border-color, #ccc);border-radius:0;">${this.escapeHtml(sectionData?.symbolNames || '')}</div>`,
      `<div class="beam-grid-positions-container" style="display:grid;grid-template-columns:repeat(${entries.length},minmax(${GRID_POSITION_MIN_WIDTH}px,1fr));justify-content:stretch;gap:0;width:100%;">${positionHtml}</div>`,
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
      '<div class="section-cell-content beam-grid-empty-cell" style="display:flex;flex-direction:column;width:100%;height:auto;gap:0;">',
      `<div style="height:${GRID_NAME_ROW_HEIGHT}px;box-sizing:border-box;border-bottom:1px solid var(--border-color, #ccc);"></div>`,
      `<div style="height:${GRID_POSITION_ROW_HEIGHT}px;box-sizing:border-box;border-bottom:1px solid var(--border-color, #ccc);"></div>`,
      `<div class="section-cell-empty" style="height:${diagramHeight}px;min-height:0;box-sizing:border-box;padding:0;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--border-color, #ccc);">-</div>`,
      `<div>${blankRows}</div>`,
      '</div>',
    ].join('');
  }

  renderSectionCell(sectionData) {
    const parts = [];

    parts.push('<div class="section-cell-content beam-section-cell">');
    parts.push(`<div class="section-cell-name">${this.escapeHtml(sectionData.symbolNames)}</div>`);

    const patternLabel = this.getPositionPatternLabel(sectionData.positionPattern);
    if (patternLabel) {
      parts.push(`<div class="section-cell-pattern">${patternLabel}</div>`);
    }

    const positionEntries = this.getRenderablePositionEntries(
      sectionData.positions,
      sectionData.positionPattern,
    );

    parts.push(
      `<table class="beam-position-schedule beam-position-count-${positionEntries.length}">`,
    );
    parts.push('<thead><tr>');
    parts.push('<th class="beam-schedule-corner" scope="col">位置</th>');
    positionEntries.forEach((entry) => {
      parts.push(`<th class="position-label" scope="col">${this.escapeHtml(entry.label)}</th>`);
    });
    parts.push('</tr></thead>');
    parts.push('<tbody>');

    parts.push('<tr class="beam-schedule-diagram-row">');
    parts.push('<th class="beam-schedule-row-label" scope="row">断面</th>');
    positionEntries.forEach((entry) => {
      const positionData = entry.data;
      const beamDataForSvg = {
        ...positionData,
        // XMLのdepth_coverは意味データとして保持するが、作図かぶりには直接使用しない。
        cover: positionData?.cover || sectionData.cover || null,
      };
      const svgString = this.svgRenderer.renderToString(beamDataForSvg, {
        fixedScale: this.lastComputedScale?.scale,
        sharedSlotCount: this.sectionSlotCounts.get(sectionData) || null,
        scheduleProfile: this.scheduleProfile,
        drawingCoverOverride: this.coverThickness,
      });
      parts.push(
        `<td class="beam-schedule-position-cell"><div class="beam-section-diagram">${svgString}</div></td>`,
      );
    });
    parts.push('</tr>');

    this.appendPositionScheduleRow(parts, 'B×D', positionEntries, (data) =>
      Number(data?.width) > 0 && Number(data?.depth) > 0 ? `${data.width}×${data.depth}` : '-',
    );
    this.appendPositionScheduleRow(parts, '上端筋', positionEntries, (data) =>
      this.formatBarCountText(data?.topBar),
    );
    this.appendPositionScheduleRow(parts, '下端筋', positionEntries, (data) =>
      this.formatBarCountText(data?.bottomBar),
    );
    this.appendPositionScheduleRow(parts, 'あばら筋', positionEntries, (data) =>
      this.formatStirrupText(data?.stirrup),
    );
    this.appendPositionScheduleRow(parts, '腹筋', positionEntries, (data) =>
      this.formatBarCountText(data?.webBar),
    );

    parts.push('</tbody></table>');
    parts.push(this.renderMaterialSummary(sectionData, positionEntries));
    parts.push('</div>');

    return parts.join('');
  }

  appendPositionScheduleRow(parts, label, positionEntries, formatter) {
    parts.push('<tr>');
    parts.push(`<th class="beam-schedule-row-label" scope="row">${this.escapeHtml(label)}</th>`);
    positionEntries.forEach((entry) => {
      const value = formatter(entry.data, entry.key);
      parts.push(`<td class="beam-schedule-position-cell">${this.escapeHtml(value || '-')}</td>`);
    });
    parts.push('</tr>');
  }

  collectPositionGradeList(position, keys) {
    return keys.flatMap((key) => {
      const bar = position?.[key];
      if (!bar) return [];
      const layerGrades =
        bar.layers
          ?.flatMap((layer) =>
            layer.barGroups?.length > 0
              ? layer.barGroups.map((group) => group.grade)
              : [layer.grade],
          )
          .filter(Boolean) || [];
      return layerGrades.length > 0 ? layerGrades : [bar.grade].filter(Boolean);
    });
  }

  collectPositionGrades(position, keys) {
    const grades = this.collectPositionGradeList(position, keys);
    return [...new Set(grades)].join('/') || '-';
  }

  renderMaterialSummary(sectionData, positionEntries) {
    const positions = positionEntries.map((entry) => entry.data).filter(Boolean);
    const collectGrades = (keys) =>
      [
        ...new Set(positions.flatMap((position) => this.collectPositionGradeList(position, keys))),
      ].join('/');
    const items = [
      ['コンクリート', sectionData.concrete?.strength || '-'],
      ['主筋', collectGrades(['topBar', 'bottomBar'])],
      ['あばら筋', collectGrades(['stirrup'])],
    ].filter(([, value]) => value);

    const content = items
      .map(
        ([label, value]) =>
          `<span class="beam-material-item"><span class="spec-label">${this.escapeHtml(label)}</span><span class="spec-value">${this.escapeHtml(value)}</span></span>`,
      )
      .join('');
    return `<div class="beam-section-common-spec">${content}</div>`;
  }

  getRenderablePositionEntries(positions, positionPattern = '') {
    return resolveBeamSchedulePositionEntries(positions, positionPattern);
  }

  /** 後方互換。圧縮後の代表source keyだけを返す。 */
  getRenderablePositionKeys(positions, positionPattern = '') {
    return this.getRenderablePositionEntries(positions, positionPattern).map(
      (entry) => entry.sourceKeys[0],
    );
  }

  getPositionLabel(position, pattern = '', positionKeys = []) {
    const isStartEnd = pattern === 'START_END';
    const isEndCenter =
      pattern === 'END_CENTER' ||
      (positionKeys.length === 2 &&
        positionKeys.includes('LEFT') &&
        positionKeys.includes('CENTER'));
    const isCollapsedSame = positionKeys.length === 1;
    const labels = {
      LEFT: isCollapsedSame ? '全断面' : isStartEnd ? '始端' : isEndCenter ? '両端部' : '左端',
      CENTER: '中央',
      RIGHT: isStartEnd ? '終端' : '右端',
      SAME: '全断面',
    };
    return labels[position] || position;
  }

  formatBarCountText(bar) {
    if (!bar || bar.count <= 0) return '-';
    const layers = bar.layers?.filter((layer) => layer.count > 0) || [];
    if (layers.length > 0) {
      const groups = layers.flatMap((layer) =>
        layer.barGroups?.length > 0 ? layer.barGroups : [layer],
      );
      const dias = new Set(groups.map((group) => group.dia).filter(Boolean));
      const grades = new Set(groups.map((group) => group.grade).filter(Boolean));
      const countsText = layers.map((layer) => layer.count).join('/');
      if (dias.size === 0) {
        return countsText;
      }
      if (dias.size === 1 && grades.size <= 1) {
        return `${countsText}-${[...dias][0]}`;
      }
      return groups
        .map(
          (group) =>
            `${group.count}${group.dia ? `-${group.dia}` : ''}${group.grade ? `(${group.grade})` : ''}`,
        )
        .join(' + ');
    }

    const count1st = bar.count1st || bar.count;
    const count2nd = bar.count2nd || 0;
    const countText = count2nd > 0 ? `${count1st}/${count2nd}` : `${count1st}`;
    return bar.dia ? `${countText}-${bar.dia}` : countText;
  }

  formatStirrupText(stirrup) {
    if (!stirrup || !stirrup.dia) return '-';
    const countText = stirrup.count > 0 ? `${stirrup.count}-` : '';
    const pitchText = stirrup.pitch ? `@${stirrup.pitch}` : '';
    return `${countText}${stirrup.dia}${pitchText}`;
  }

  getPositionPatternLabel(pattern) {
    const labels = {
      SAME: '全断面同一',
      END_CENTER: '端部・中央',
      START_END: '始端・終端',
      THREE: '左端・中央・右端',
      LEFT_CENTER_SHARED: '左端・中央（共有）',
      RIGHT_CENTER_SHARED: '中央・右端（共有）',
    };
    return labels[pattern] || '';
  }

  getScaleLabel() {
    if (!this.lastComputedScale?.effectiveDenominator) {
      return '';
    }
    return `縮尺 1/${this.lastComputedScale.effectiveDenominator}`;
  }

  setScaleDenominator(denominator) {
    const value = Number(denominator);
    if (Number.isFinite(value) && value > 0) {
      this.scaleOptions.scaleDenominator = value;
      this.scheduleProfile = resolveRcScheduleProfile({
        ...this.scheduleProfile,
        scaleDenominator: value,
      });
    }
  }

  setScheduleProfile(scheduleProfile) {
    this.scheduleProfile = resolveRcScheduleProfile(scheduleProfile || {});
    this.scaleOptions.scaleDenominator = this.scheduleProfile.scaleDenominator;
    this.scaleOptions.previewDpi = this.scheduleProfile.previewDpi;
  }

  setCoverThickness(thickness) {
    const value = Number(thickness);
    this.coverThickness = Number.isFinite(value) && value > 0 ? value : null;
  }

  computeUnifiedScale(data) {
    const dims = this.collectBeamDimensions(data?.grid);
    if (dims.maxWidth <= 0 || dims.maxDepth <= 0) {
      return null;
    }

    const mmToPx = this.scaleOptions.previewDpi / 25.4;
    const baseScale = mmToPx / this.scaleOptions.scaleDenominator;
    return {
      scale: baseScale,
      effectiveDenominator: this.scaleOptions.scaleDenominator.toString(),
    };
  }

  indexSymbolSlotCounts(data) {
    this.sectionSlotCounts = new WeakMap();
    const { stories = [], symbols = [], grid } = data || {};
    if (!(grid instanceof Map)) return;

    symbols.forEach((symbol) => {
      const sections = stories.flatMap((story) => {
        const value = grid.get(`${story.id}:${symbol}`);
        return value ? (Array.isArray(value) ? value : [value]) : [];
      });
      const maxCount = sections.reduce(
        (maximum, sectionData) => Math.max(maximum, this.collectSectionSlotCount(sectionData)),
        0,
      );
      sections.forEach((sectionData) => this.sectionSlotCounts.set(sectionData, maxCount));
    });
  }

  collectSectionSlotCount(sectionData) {
    let maxCount = 0;
    Object.values(sectionData?.positions || {}).forEach((position) => {
      for (const bar of [position?.topBar, position?.bottomBar]) {
        const layers = this.svgRenderer.getRenderableBarLayers(bar);
        layers.forEach((layer) => {
          maxCount = Math.max(maxCount, Number(layer.count) || 0);
        });
      }
      maxCount = Math.max(maxCount, Number(position?.stirrup?.count) || 0);
    });
    return maxCount;
  }

  collectBeamDimensions(grid) {
    let maxWidth = 0;
    let maxDepth = 0;

    if (!(grid instanceof Map)) {
      return { maxWidth, maxDepth };
    }

    grid.forEach((sectionDataOrList) => {
      const list = Array.isArray(sectionDataOrList) ? sectionDataOrList : [sectionDataOrList];
      list.forEach((sectionData) => {
        const positions = sectionData?.positions || {};
        Object.values(positions).forEach((positionData) => {
          const width = Number(positionData?.width) || 0;
          const depth = Number(positionData?.depth) || 0;
          if (width > maxWidth) maxWidth = width;
          if (depth > maxDepth) maxDepth = depth;
        });
      });
    });

    return { maxWidth, maxDepth };
  }
}

export default BeamSectionListRenderer;
