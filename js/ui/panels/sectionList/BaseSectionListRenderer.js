/**
 * @fileoverview RC断面リストテーブルレンダラー基底クラス
 *
 * ColumnSectionListRenderer と BeamSectionListRenderer の共通ロジックを
 * 集約した抽象基底クラスです。グリッド形式のテーブル描画、HTMLエスケープ、
 * 重複除去付きバリアント描画などを提供します。
 *
 * @module ui/sectionList/BaseSectionListRenderer
 */

import { escapeHtml } from '../../../utils/htmlUtils.js';

/**
 * RC断面リストテーブルレンダラー基底クラス
 *
 * サブクラスは以下の抽象メソッドを実装する必要があります:
 * - renderSectionCell(sectionData): 断面セルのHTMLを返す
 * - getEmptyMessage(): データ無し時のメッセージ
 * - getGridTableClassName(): グリッドテーブルのCSSクラス名
 * - getGridCellData(grid, storyId, symbol): グリッドからセルデータを取得
 * - getSectionIdentifiers(sectionData): 重複除去・ラベル用ID情報を返す
 */
export class BaseSectionListRenderer {
  /**
   * @param {Object} svgRenderer - SVG描画レンダラーインスタンス
   */
  constructor(svgRenderer) {
    this.svgRenderer = svgRenderer;
  }

  /**
   * HTMLエスケープ
   * @param {string} str - 文字列
   * @returns {string}
   */
  escapeHtml(str) {
    return escapeHtml(str);
  }

  /**
   * グリッドのヘッダー行を生成
   * @param {Array<string>} symbols - 符号一覧
   * @returns {HTMLElement} thead要素
   */
  renderGridHeader(symbols) {
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    // 階列ヘッダー（左端固定列）
    const thFloor = document.createElement('th');
    thFloor.className = 'section-grid-header-floor';
    thFloor.textContent = '階';
    headerRow.appendChild(thFloor);

    // 各符号列のヘッダー
    symbols.forEach((symbol) => {
      const thSymbol = document.createElement('th');
      thSymbol.className = 'section-grid-header-symbol';
      thSymbol.textContent = symbol;
      headerRow.appendChild(thSymbol);
    });

    thead.appendChild(headerRow);
    return thead;
  }

  /**
   * 項目列付きのグリッドヘッダーを生成する。
   * 柱・梁の断面リストで共通の固定列レイアウトを使用する。
   * @param {Array<string>} symbols - 符号一覧
   * @param {Object} options - 固定列幅
   * @returns {HTMLElement} thead要素
   */
  renderLabeledGridHeader(symbols, { floorColumnWidth = 70, labelColumnWidth = 78 } = {}) {
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    const thFloor = document.createElement('th');
    thFloor.className = 'section-grid-header-floor';
    thFloor.textContent = '階';
    headerRow.appendChild(thFloor);

    const thLabel = document.createElement('th');
    thLabel.className = 'section-grid-header-row-label';
    thLabel.textContent = '項目';
    Object.assign(thLabel.style, {
      position: 'sticky',
      top: '0',
      left: `${floorColumnWidth}px`,
      zIndex: '19',
      width: `${labelColumnWidth}px`,
      minWidth: `${labelColumnWidth}px`,
      boxSizing: 'border-box',
      textAlign: 'center',
      whiteSpace: 'nowrap',
      background: 'var(--bg-tertiary, #e8e8e8)',
      borderBottom: '2px solid var(--border-color, #999)',
    });
    headerRow.appendChild(thLabel);

    symbols.forEach((symbol) => {
      const thSymbol = document.createElement('th');
      thSymbol.className = 'section-grid-header-symbol';
      thSymbol.textContent = symbol;
      headerRow.appendChild(thSymbol);
    });

    thead.appendChild(headerRow);
    return thead;
  }

  /**
   * 項目列付きのグリッド本体を生成する。
   * 断面種別ごとのセル内容はサブクラスの描画メソッドへ委譲する。
   * @param {Array<Object>} stories - 階一覧
   * @param {Array<string>} symbols - 符号一覧
   * @param {Map} grid - グリッドデータ
   * @param {Object} options - 固定列幅
   * @returns {HTMLElement} tbody要素
   */
  renderLabeledGridBody(
    stories,
    symbols,
    grid,
    { floorColumnWidth = 70, labelColumnWidth = 78 } = {},
  ) {
    const tbody = document.createElement('tbody');

    stories.forEach((story) => {
      const tr = document.createElement('tr');
      const diagramHeight = this.getStoryDiagramHeight(story, symbols, grid);

      const tdFloor = document.createElement('td');
      tdFloor.className = 'section-grid-floor-cell';
      tdFloor.textContent = story.name;
      tr.appendChild(tdFloor);

      const tdLabels = document.createElement('td');
      tdLabels.className = 'section-grid-row-label-cell';
      Object.assign(tdLabels.style, {
        position: 'sticky',
        left: `${floorColumnWidth}px`,
        zIndex: '4',
        width: `${labelColumnWidth}px`,
        minWidth: `${labelColumnWidth}px`,
        padding: '0',
        boxSizing: 'border-box',
        verticalAlign: 'top',
        background: 'var(--bg-secondary, #f5f5f5)',
      });
      tdLabels.innerHTML = this.renderGridRowLabels(diagramHeight);
      tr.appendChild(tdLabels);

      symbols.forEach((symbol) => {
        const tdSection = document.createElement('td');
        tdSection.className = 'section-grid-section-cell';
        tdSection.style.padding = '0';

        const raw = this.getGridCellData(grid, story.id, symbol);
        if (raw) {
          tdSection.innerHTML = this.renderGridCell(raw, diagramHeight);
        } else {
          tdSection.innerHTML = this.renderEmptyGridCell(diagramHeight);
          tdSection.classList.add('empty');
        }

        tr.appendChild(tdSection);
      });

      tbody.appendChild(tr);
    });

    return tbody;
  }

  /**
   * グリッド形式で断面リストテーブルをレンダリング
   * @param {Object} data - extractXxxSectionGridの出力
   * @param {HTMLElement} container - 描画先コンテナ
   */
  renderGrid(data, container) {
    if (!container) return;

    const { stories, symbols, grid } = data;

    if (!symbols || symbols.length === 0 || !stories || stories.length === 0) {
      container.innerHTML = `<div class="section-list-empty">${this.getEmptyMessage()}</div>`;
      this.onEmptyGrid();
      return;
    }

    this.onBeforeGridRender(data);

    const table = document.createElement('table');
    table.className = this.getGridTableClassName();

    // ヘッダー行
    const thead = this.renderGridHeader(symbols);
    table.appendChild(thead);

    // ボディ行
    const tbody = this.renderGridBody(stories, symbols, grid);
    table.appendChild(tbody);

    // コンテナをクリアしてテーブルを追加
    container.innerHTML = '';
    container.appendChild(table);
  }

  /**
   * グリッドのボディ行を生成
   * @param {Array} stories - 階一覧
   * @param {Array<string>} symbols - 符号一覧
   * @param {Map} grid - グリッドデータ
   * @returns {HTMLElement} tbody要素
   */
  renderGridBody(stories, symbols, grid) {
    const tbody = document.createElement('tbody');

    stories.forEach((story) => {
      const tr = document.createElement('tr');

      // 階セル（左端固定列）
      const tdFloor = document.createElement('td');
      tdFloor.className = 'section-grid-floor-cell';
      tdFloor.textContent = story.name;
      tr.appendChild(tdFloor);

      // 各符号のセル
      symbols.forEach((symbol) => {
        const tdSection = document.createElement('td');
        tdSection.className = 'section-grid-section-cell';

        const sectionData = this.getGridCellData(grid, story.id, symbol);

        if (sectionData) {
          if (Array.isArray(sectionData)) {
            tdSection.innerHTML = this.renderSectionVariants(sectionData);
          } else {
            tdSection.innerHTML = this.renderSectionCell(sectionData);
          }
        } else {
          // 空セル
          tdSection.innerHTML = '<div class="section-cell-empty">-</div>';
          tdSection.classList.add('empty');
        }

        tr.appendChild(tdSection);
      });

      tbody.appendChild(tr);
    });

    return tbody;
  }

  /**
   * 同一セル内に複数断面がある場合のレンダリング
   * @param {Array<Object>} sectionDataList - 断面データ配列
   * @returns {string} HTML文字列
   */
  renderSectionVariants(sectionDataList) {
    const uniqueVariants = [];
    const seenSectionIds = new Set();

    sectionDataList.forEach((sectionData) => {
      const { dedupeId } = this.getSectionIdentifiers(sectionData);
      const dedupeKey = `${dedupeId}:${sectionData?.symbolNames || ''}`;
      if (!seenSectionIds.has(dedupeKey)) {
        seenSectionIds.add(dedupeKey);
        uniqueVariants.push(sectionData);
      }
    });

    if (uniqueVariants.length === 1) {
      return this.renderSectionCell(uniqueVariants[0]);
    }

    const parts = ['<div class="section-cell-variants">'];
    uniqueVariants.forEach((sectionData, index) => {
      const { labelId } = this.getSectionIdentifiers(sectionData);
      const label = labelId
        ? `断面${index + 1} (ID: ${this.escapeHtml(labelId)})`
        : `断面${index + 1}`;
      parts.push('<div class="section-cell-variant">');
      parts.push(`<div class="section-cell-variant-label">${label}</div>`);
      parts.push(this.renderSectionCell(sectionData));
      parts.push('</div>');
    });
    parts.push('</div>');

    return parts.join('');
  }

  // --- Abstract methods (must be overridden by subclasses) ---

  /**
   * 断面セルの内容をレンダリング
   * @abstract
   * @param {Object} sectionData - 断面データ
   * @returns {string} HTMLストリング
   */
  renderSectionCell(_sectionData) {
    throw new Error('renderSectionCell() must be implemented by subclass');
  }

  /**
   * データ無し時のメッセージを返す
   * @abstract
   * @returns {string}
   */
  getEmptyMessage() {
    throw new Error('getEmptyMessage() must be implemented by subclass');
  }

  /**
   * グリッドテーブルのCSSクラス名を返す
   * @abstract
   * @returns {string}
   */
  getGridTableClassName() {
    throw new Error('getGridTableClassName() must be implemented by subclass');
  }

  /**
   * グリッドからセルデータを取得
   * @abstract
   * @param {Map} grid - グリッドデータ
   * @param {string} storyId - 階ID
   * @param {string} symbol - 符号
   * @returns {Object|Array|undefined}
   */
  getGridCellData(_grid, _storyId, _symbol) {
    throw new Error('getGridCellData() must be implemented by subclass');
  }

  /**
   * 断面データから重複除去・ラベル用IDを返す
   * @abstract
   * @param {Object} sectionData - 断面データ
   * @returns {{dedupeId: string, labelId: string}}
   */
  getSectionIdentifiers(_sectionData) {
    throw new Error('getSectionIdentifiers() must be implemented by subclass');
  }

  // --- Virtual hooks (no-op by default, overridable) ---

  /**
   * グリッド描画前のフック
   * @param {Object} _data - グリッドデータ
   */
  onBeforeGridRender(_data) {
    // no-op: サブクラスでオーバーライド可能
  }

  /**
   * グリッドが空の場合のフック
   */
  onEmptyGrid() {
    // no-op: サブクラスでオーバーライド可能
  }
}

export default BaseSectionListRenderer;
