/**
 * @fileoverview RC柱断面リストテーブルレンダラー
 *
 * 構造図形式のRC柱断面リストテーブルをHTMLとして描画します。
 * 各セルにSVG断面図と詳細情報を埋め込みます。
 *
 * @module ui/sectionList/ColumnSectionListRenderer
 */

import { BaseSectionListRenderer } from './BaseSectionListRenderer.js';
import { RcColumnVisualRenderer } from '../../../components/rcColumnVisual/index.js';

/**
 * RC柱断面リストテーブルレンダラー
 */
export class ColumnSectionListRenderer extends BaseSectionListRenderer {
  constructor(options = {}) {
    const svgRenderer = new RcColumnVisualRenderer({
      maxWidth: options.svgWidth || 120,
      maxHeight: options.svgHeight || 120,
      padding: options.svgPadding || 15,
      barScale: options.barScale || 0.5,
      showDimensions: false,
    });

    super(svgRenderer);

    this.scaleOptions = {
      scaleDenominator:
        Number(options.scaleDenominator) > 0 ? Number(options.scaleDenominator) : 40,
      previewDpi: Number(options.previewDpi) > 0 ? Number(options.previewDpi) : 96,
    };
    this.lastComputedScale = null;
    this.sectionSlotCounts = new WeakMap();

    this.options = {
      showCoreBar: options.showCoreBar !== false,
      showStirrupGrade: options.showStirrupGrade !== false,
      compactMode: options.compactMode || false,
    };
  }

  // --- Abstract method implementations ---

  /** @override */
  getEmptyMessage() {
    return 'RC柱断面データがありません';
  }

  /** @override */
  getGridTableClassName() {
    return 'column-section-grid-table';
  }

  /** @override */
  getGridCellData(grid, storyId, symbol) {
    return grid.get(storyId)?.get(symbol);
  }

  /** @override */
  getSectionIdentifiers(sectionData) {
    const id = sectionData?.id || '';
    return { dedupeId: id, labelId: id };
  }

  /** @override */
  onBeforeGridRender(data) {
    this.lastComputedScale = this.computeFixedScale();
    this.indexSymbolSlotCounts(data);
  }

  /** @override */
  onEmptyGrid() {
    this.lastComputedScale = null;
    this.sectionSlotCounts = new WeakMap();
  }

  // --- Column-specific methods ---

  /**
   * 断面リストテーブルをレンダリング
   * @param {Object} data - extractColumnSectionListの出力
   * @param {HTMLElement} container - 描画先コンテナ
   */
  render(data, container) {
    if (!container) return;

    const { sections } = data;

    if (!sections || sections.length === 0) {
      container.innerHTML = '<div class="section-list-empty">RC柱断面データがありません</div>';
      this.onEmptyGrid();
      return;
    }

    this.lastComputedScale = this.computeFixedScale();
    this.indexListSlotCounts(sections);

    const table = document.createElement('table');
    table.className = 'column-section-list-table';

    // ヘッダー行
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    // 階列ヘッダー
    const thFloor = document.createElement('th');
    thFloor.className = 'section-list-header-floor';
    thFloor.textContent = '階';
    headerRow.appendChild(thFloor);

    // 符号列ヘッダー
    const thSymbol = document.createElement('th');
    thSymbol.className = 'section-list-header-symbol';
    thSymbol.textContent = '符号';
    headerRow.appendChild(thSymbol);

    // 断面列ヘッダー
    const thSection = document.createElement('th');
    thSection.className = 'section-list-header-section';
    thSection.textContent = '断面詳細';
    headerRow.appendChild(thSection);

    thead.appendChild(headerRow);
    table.appendChild(thead);

    // ボディ行
    const tbody = document.createElement('tbody');

    sections.forEach((row) => {
      const tr = document.createElement('tr');

      // 階セル
      const tdFloor = document.createElement('td');
      tdFloor.className = 'section-list-floor-cell';
      tdFloor.textContent = row.storyName;
      tr.appendChild(tdFloor);

      // 符号セル
      const tdSymbol = document.createElement('td');
      tdSymbol.className = 'section-list-symbol-cell';
      tdSymbol.textContent = row.symbol;
      tr.appendChild(tdSymbol);

      // 断面詳細セル
      const tdSection = document.createElement('td');
      tdSection.className = 'section-list-section-cell';
      tdSection.innerHTML = this.renderSectionCell(row.sectionData);
      tr.appendChild(tdSection);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);

    // コンテナをクリアしてテーブルを追加
    container.innerHTML = '';
    container.appendChild(table);
  }

  /**
   * 断面セルの内容をレンダリング
   * @param {Object} sectionData - 断面データ
   * @returns {string} HTMLストリング
   */
  renderSectionCell(sectionData) {
    const parts = [];
    const arrangements = this.getArrangements(sectionData);
    const isMultiple = arrangements.length > 1;

    // ラッパーdivで囲む（flexboxレイアウト用）
    parts.push('<div class="section-cell-content column-section-cell">');

    // 符号名（例: "9C1, 10C1"）
    parts.push(
      `<div class="section-cell-name">${this.escapeHtml(sectionData.symbolNames || '')}</div>`,
    );

    parts.push(`<div class="column-arrangements-container${isMultiple ? ' is-multiple' : ''}">`);

    const positionTotals = arrangements.reduce((counts, arrangement) => {
      counts[arrangement.position] = (counts[arrangement.position] || 0) + 1;
      return counts;
    }, {});
    const positionIndexes = {};

    arrangements.forEach((arrangement) => {
      parts.push('<div class="column-arrangement-item">');

      if (isMultiple || arrangement.position !== 'SAME') {
        positionIndexes[arrangement.position] = (positionIndexes[arrangement.position] || 0) + 1;
        parts.push(
          `<div class="column-arrangement-label">${this.getPositionLabel(
            arrangement.position,
            positionIndexes[arrangement.position],
            positionTotals[arrangement.position],
          )}</div>`,
        );
      }

      // 断面図（SVG）
      const svgData = this.prepareSvgData(sectionData, arrangement);
      const svgString = this.svgRenderer.renderToString(svgData, {
        fixedScale: this.lastComputedScale?.scale,
        sharedSlotCounts: this.sectionSlotCounts.get(sectionData) || null,
      });
      parts.push(`<div class="section-cell-diagram">${svgString}</div>`);

      parts.push(this.renderArrangementSpecs(sectionData, arrangement));
      parts.push('</div>');
    });

    parts.push('</div>');

    // ラッパー閉じタグ
    parts.push('</div>');

    return parts.join('');
  }

  /**
   * 位置別配筋を正規化する
   * @param {Object} sectionData - 断面データ
   * @returns {Array<Object>} 位置別配筋
   */
  getArrangements(sectionData) {
    if (Array.isArray(sectionData.arrangements) && sectionData.arrangements.length > 0) {
      const order = { TOP: 0, BOTTOM: 1, SAME: 2 };
      return sectionData.arrangements
        .map((arrangement) => ({
          ...arrangement,
          position: arrangement.position || 'SAME',
        }))
        .sort((a, b) => (order[a.position] ?? 99) - (order[b.position] ?? 99));
    }

    return [
      {
        position: 'SAME',
        mainBar: sectionData.mainBar || null,
        hoop: sectionData.hoop || null,
        coreBar: sectionData.coreBar || null,
        cover: sectionData.cover,
      },
    ];
  }

  /**
   * 位置ラベルを返す
   * @param {string} position - SAME/TOP/BOTTOM
   * @param {number} [index=1] - 同位置内の連番
   * @param {number} [total=1] - 同位置の総数
   * @returns {string} 日本語ラベル
   */
  getPositionLabel(position, index = 1, total = 1) {
    const label =
      {
        TOP: '柱頭',
        BOTTOM: '柱脚',
        SAME: '全断面',
      }[position] || this.escapeHtml(position || '全断面');
    return total > 1 ? `${label}${index}` : label;
  }

  /**
   * 位置別の仕様表をレンダリングする
   * @param {Object} sectionData - 断面データ
   * @param {Object} arrangement - 位置別配筋
   * @returns {string} HTML文字列
   */
  renderArrangementSpecs(sectionData, arrangement) {
    const parts = [
      '<div class="section-cell-specs column-arrangement-specs">',
      '<table class="section-specs-table">',
    ];

    const dimText = this.formatDimensions(sectionData);
    const concreteStrength = sectionData.concrete?.strength;
    const concreteText = `${dimText} / ${concreteStrength ? this.escapeHtml(concreteStrength) : '—'}`;
    parts.push(
      `<tr><td class="spec-label">B×D / Fc</td><td class="spec-value">${concreteText}</td></tr>`,
    );

    parts.push(
      `<tr><td class="spec-label">主筋</td><td class="spec-value">${this.formatMainBar(sectionData, arrangement)}</td></tr>`,
    );

    parts.push(
      `<tr><td class="spec-label">主筋材料</td><td class="spec-value">${this.formatMainGrade(arrangement.mainBar)}</td></tr>`,
    );

    const dtText = this.formatDt(sectionData, arrangement);
    if (dtText) {
      parts.push(
        `<tr><td class="spec-label">1段目dt</td><td class="spec-value">${dtText}</td></tr>`,
      );
    }

    if (this.options.showCoreBar && arrangement.coreBar) {
      parts.push(
        `<tr><td class="spec-label">芯鉄筋</td><td class="spec-value">${this.formatCoreBar(sectionData, arrangement)}</td></tr>`,
      );
    }

    parts.push(
      `<tr><td class="spec-label">帯筋</td><td class="spec-value">${this.formatHoop(sectionData, arrangement)}</td></tr>`,
    );

    parts.push('</table>', '</div>');
    return parts.join('');
  }

  /**
   * SVGレンダリング用のデータを準備
   * @param {Object} sectionData - 断面データ
   * @returns {Object} SVGレンダラー用データ
   */
  prepareSvgData(sectionData, arrangement = this.getArrangements(sectionData)[0]) {
    const mainBar = arrangement.mainBar || null;
    const cover = arrangement.cover ?? sectionData.cover;

    if (sectionData.isCircular || sectionData.diameter > 0) {
      return {
        diameter: sectionData.diameter,
        cover,
        mainBar: mainBar
          ? {
              count: mainBar.countTotal ?? mainBar.count,
              countTotal: mainBar.countTotal,
              dia: mainBar.dia,
              center: mainBar.center ?? mainBar.dt,
            }
          : null,
        hoop: arrangement.hoop || null,
        coreBar: arrangement.coreBar || null,
      };
    } else {
      return {
        width: sectionData.width,
        height: sectionData.height,
        cover,
        mainBar: mainBar
          ? {
              countX: mainBar.countX,
              countY: mainBar.countY,
              countTotal: mainBar.countTotal,
              dia: mainBar.dia,
              diaSub: mainBar.diaSub,
              mainDirection: mainBar.mainDirection,
              layers: mainBar.layers,
              firstLayerExtraGroups: mainBar.firstLayerExtraGroups,
              secondLayer: mainBar.secondLayer,
              centerStartX: mainBar.centerStartX,
              centerEndX: mainBar.centerEndX,
              centerStartY: mainBar.centerStartY,
              centerEndY: mainBar.centerEndY,
              dtX: mainBar.dtX,
              dtY: mainBar.dtY,
            }
          : null,
        hoop: arrangement.hoop || null,
        coreBar: arrangement.coreBar || null,
      };
    }
  }

  /**
   * 現在の描画縮尺ラベルを取得する。
   * @returns {string}
   */
  getScaleLabel() {
    return this.lastComputedScale ? `縮尺 1/${this.lastComputedScale.effectiveDenominator}` : '';
  }

  /**
   * 縮尺分母を設定する。
   * @param {number} denominator - 1/n の n
   */
  setScaleDenominator(denominator) {
    const value = Number(denominator);
    if (Number.isFinite(value) && value > 0) this.scaleOptions.scaleDenominator = value;
  }

  /**
   * CSS px換算の固定縮尺を返す。
   * @returns {{scale:number,effectiveDenominator:string}}
   */
  computeFixedScale() {
    return {
      scale: this.scaleOptions.previewDpi / 25.4 / this.scaleOptions.scaleDenominator,
      effectiveDenominator: this.scaleOptions.scaleDenominator.toString(),
    };
  }

  /**
   * 同一符号の全階・全位置から方向別最大スロット数を求める。
   * @param {Object} data - 柱断面グリッド
   */
  indexSymbolSlotCounts(data) {
    this.sectionSlotCounts = new WeakMap();
    const { stories = [], symbols = [], grid } = data || {};
    if (!(grid instanceof Map)) return;

    symbols.forEach((symbol) => {
      const sections = stories.flatMap((story) => {
        const value = grid.get(story.id)?.get(symbol);
        return value ? (Array.isArray(value) ? value : [value]) : [];
      });
      const maximum = sections.reduce(
        (result, sectionData) => {
          const counts = this.collectSectionSlotCounts(sectionData);
          return { x: Math.max(result.x, counts.x), y: Math.max(result.y, counts.y) };
        },
        { x: 0, y: 0 },
      );
      sections.forEach((sectionData) => this.sectionSlotCounts.set(sectionData, maximum));
    });
  }

  /**
   * 旧リスト形式でも符号別の方向別最大スロット数を関連付ける。
   * @param {Array<Object>} rows - 柱断面リスト行
   */
  indexListSlotCounts(rows) {
    this.sectionSlotCounts = new WeakMap();
    const sectionsBySymbol = new Map();
    (rows || []).forEach((row) => {
      if (!row?.sectionData) return;
      const sections = sectionsBySymbol.get(row.symbol) || [];
      sections.push(row.sectionData);
      sectionsBySymbol.set(row.symbol, sections);
    });

    sectionsBySymbol.forEach((sections) => {
      const maximum = sections.reduce(
        (result, sectionData) => {
          const counts = this.collectSectionSlotCounts(sectionData);
          return { x: Math.max(result.x, counts.x), y: Math.max(result.y, counts.y) };
        },
        { x: 0, y: 0 },
      );
      sections.forEach((sectionData) => this.sectionSlotCounts.set(sectionData, maximum));
    });
  }

  /**
   * 1断面の主筋各段と帯筋から方向別最大本数を返す。
   * @param {Object} sectionData - 柱断面データ
   * @returns {{x:number,y:number}}
   */
  collectSectionSlotCounts(sectionData) {
    const result = { x: 0, y: 0 };
    this.getArrangements(sectionData).forEach((arrangement) => {
      const mainBar = arrangement.mainBar || {};
      const extras = Array.isArray(mainBar.firstLayerExtraGroups)
        ? mainBar.firstLayerExtraGroups
        : [];
      result.x = Math.max(
        result.x,
        (Number(mainBar.countX) || 0) +
          extras.reduce((sum, group) => sum + (Number(group.countX) || 0), 0),
      );
      result.y = Math.max(
        result.y,
        (Number(mainBar.countY) || 0) +
          extras.reduce((sum, group) => sum + (Number(group.countY) || 0), 0),
      );
      const secondGroups = mainBar.secondLayer?.groups?.length
        ? mainBar.secondLayer.groups
        : mainBar.secondLayer
          ? [mainBar.secondLayer]
          : [];
      result.x = Math.max(
        result.x,
        secondGroups.reduce((sum, group) => sum + (Number(group.countX) || 0), 0),
      );
      result.y = Math.max(
        result.y,
        secondGroups.reduce((sum, group) => sum + (Number(group.countY) || 0), 0),
      );
      result.x = Math.max(result.x, Number(arrangement.hoop?.countY) || 0);
      result.y = Math.max(result.y, Number(arrangement.hoop?.countX) || 0);
    });
    return result;
  }

  /**
   * 寸法をフォーマット
   * @param {Object} sectionData - 断面データ
   * @returns {string}
   */
  formatDimensions(sectionData) {
    if (sectionData.isCircular || sectionData.diameter > 0) {
      return sectionData.diameter > 0 ? `φ${sectionData.diameter}` : '—';
    } else {
      return sectionData.width > 0 && sectionData.height > 0
        ? `${sectionData.width}×${sectionData.height}`
        : '—';
    }
  }

  /**
   * 主筋をフォーマット
   * @param {Object} sectionData - 断面データ
   * @returns {string}
   */
  formatMainBar(sectionData, arrangement = this.getArrangements(sectionData)[0]) {
    const mainBar = arrangement.mainBar;
    if (!mainBar) return '—';

    const countX = this.toPositiveNumber(mainBar.countX);
    const countY = this.toPositiveNumber(mainBar.countY);
    let total = this.toPositiveNumber(mainBar.countTotal ?? mainBar.count);

    if (!total && countX && countY) {
      total = countX * 2 + countY * 2 - 4;
    }

    if (!total || !mainBar.dia) return '—';

    const layers = Array.isArray(mainBar.layers) ? mainBar.layers : [];
    const hasLayerDetail =
      layers.length > 1 || layers.some((layer) => (layer.groups?.length || 0) > 1);
    if (hasLayerDetail) {
      const layerText = layers
        .map((layer) => {
          const groups = (layer.groups || [])
            .map(
              (group) =>
                `${this.escapeHtml(group.dia || '—')} X${group.countX || 0}/Y${group.countY || 0}`,
            )
            .join(' + ');
          return `${layer.step}段目 ${groups}`;
        })
        .join(' / ');
      return `総数 ${total} <span class="bar-direction-note">（${layerText}）</span>`;
    }

    if (
      !(sectionData.isCircular || sectionData.diameter > 0) &&
      mainBar.diaSub &&
      mainBar.diaSub !== mainBar.dia
    ) {
      const diaX = mainBar.mainDirection === 'Y' ? mainBar.diaSub : mainBar.dia;
      const diaY = mainBar.mainDirection === 'Y' ? mainBar.dia : mainBar.diaSub;
      return `X: ${countX}-${this.escapeHtml(diaX)} / Y: ${countY}-${this.escapeHtml(diaY)} <span class="bar-direction-note">（片側）</span>`;
    }

    let text = `${total}-${this.escapeHtml(mainBar.dia)}`;
    if (
      !(sectionData.isCircular || sectionData.diameter > 0) &&
      countX &&
      countY &&
      countX !== countY
    ) {
      text += ` <span class="bar-direction-note">（X: ${countX} / Y: ${countY}）</span>`;
    }
    return text;
  }

  formatMainGrade(mainBar) {
    if (!mainBar?.grade) return '—';
    const layers = Array.isArray(mainBar.layers) ? mainBar.layers : [];
    const layerGrades = [
      ...new Set(
        layers.flatMap((layer) => (layer.groups || []).map((group) => group.grade).filter(Boolean)),
      ),
    ];
    if (layerGrades.length > 1)
      return layerGrades.map((grade) => this.escapeHtml(grade)).join(' / ');
    if (mainBar.diaSub && mainBar.gradeSub && mainBar.gradeSub !== mainBar.grade) {
      const gradeX = mainBar.mainDirection === 'Y' ? mainBar.gradeSub : mainBar.grade;
      const gradeY = mainBar.mainDirection === 'Y' ? mainBar.grade : mainBar.gradeSub;
      return `X: ${this.escapeHtml(gradeX)} / Y: ${this.escapeHtml(gradeY)}`;
    }
    let text = this.escapeHtml(mainBar.grade);
    if (mainBar.secondLayer?.grade && mainBar.secondLayer.grade !== mainBar.grade) {
      text += ` / 2段目: ${this.escapeHtml(mainBar.secondLayer.grade)}`;
    }
    return text;
  }

  /**
   * 1段目dtをフォーマット
   * @param {Object} sectionData - 断面データ
   * @returns {string}
   */
  formatDt(sectionData, arrangement = this.getArrangements(sectionData)[0]) {
    const mainBar = arrangement.mainBar;
    if (!mainBar) return '';

    if (sectionData.isCircular || sectionData.diameter > 0) {
      return mainBar.dt ? `${mainBar.dt}mm` : '';
    } else {
      const dtX = mainBar.dtX;
      const dtY = mainBar.dtY;

      if (dtX && dtY && dtX !== dtY) {
        return `X: ${dtX}mm / Y: ${dtY}mm`;
      } else if (dtX || dtY) {
        return `${dtX || dtY}mm`;
      }
      return '';
    }
  }

  /**
   * 芯鉄筋をフォーマット
   * @param {Object} sectionData - 断面データ
   * @returns {string}
   */
  formatCoreBar(sectionData, arrangement = this.getArrangements(sectionData)[0]) {
    const coreBar = arrangement.coreBar;
    if (!coreBar) return '—';

    const legacyTotal =
      (this.toPositiveNumber(coreBar.countX) || 0) + (this.toPositiveNumber(coreBar.countY) || 0);
    const total = this.toPositiveNumber(coreBar.total) || legacyTotal;
    if (!total || !coreBar.dia) return '—';

    const parts = [`${total}-${this.escapeHtml(coreBar.dia)}`];
    parts.push(coreBar.grade ? this.escapeHtml(coreBar.grade) : '—');
    if (coreBar.placementEstimated) {
      parts.push('<span class="placement-estimated-note">配置推定</span>');
    }
    if (coreBar.position > 0) {
      parts.push(`位置: ${coreBar.position}mm`);
    }

    return parts.join(' / ');
  }

  /**
   * 帯筋をフォーマット
   * @param {Object} sectionData - 断面データ
   * @returns {string}
   */
  formatHoop(sectionData, arrangement = this.getArrangements(sectionData)[0]) {
    const hoop = arrangement.hoop;
    if (!hoop || !hoop.dia || !this.toPositiveNumber(hoop.pitch)) return '—';

    const countX = this.toPositiveNumber(hoop.countX);
    const countY = this.toPositiveNumber(hoop.countY);
    let legText = '';
    if (countX && countY) {
      legText = countX === countY ? `${countX}-` : `X${countX}・Y${countY}-`;
    } else if (countX) {
      legText = `X${countX}-`;
    } else if (countY) {
      legText = `Y${countY}-`;
    }

    let text = `${legText}${this.escapeHtml(hoop.dia)}@${hoop.pitch}`;

    if (hoop.dia2 && hoop.pitch2) {
      text += ` / ${this.escapeHtml(hoop.dia2)}@${hoop.pitch2}`;
    }

    if (this.options.showStirrupGrade && hoop.grade) {
      text += ` / ${this.escapeHtml(hoop.grade)}`;
    }

    return text;
  }

  /**
   * 正の有限数へ変換する
   * @param {*} value - 入力値
   * @returns {number|null} 正の数、またはnull
   */
  toPositiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }
}

export default ColumnSectionListRenderer;
