/**
 * @fileoverview 断面リストパネル共通基底クラス
 *
 * RC柱・RC梁断面リストパネルの共通ロジック（フローティングウィンドウ生成、
 * ツールバー、データ抽出・描画、PDF/DXF出力）を提供します。
 * 要素種別ごとの差分（抽出関数・レンダラー・追加設定UI）はサブクラスが実装します。
 *
 * @module ui/sectionList/BaseSectionListPanel
 */

import { floatingWindowManager } from '../floatingWindowManager.js';
import { exportToPdf } from './SectionListPdfExporter.js';
import { getState } from '../../../data/state/globalState.js';
import { showWarning, showError } from '../../common/toast.js';

/**
 * 断面リストパネル基底クラス
 *
 * サブクラスは以下を実装する:
 * - `extractGrid(xmlDoc)` - グリッドデータ抽出
 * - `exportDxf(gridData, filename, stbName)` - DXF出力
 *
 * 必要に応じてオーバーライドする:
 * - `getExtraSettingsHtml()` - 縮尺以外の描画設定UI
 * - `setupExtraListeners()` - 追加UIのイベント登録
 * - `applyExtraRenderSettings()` - 追加設定のレンダラー反映
 * - `getExtraInfoParts()` - 情報行への追記ラベル
 */
export class BaseSectionListPanel {
  /**
   * @param {Object} config
   * @param {string} config.windowId - フローティングウィンドウID
   * @param {string} config.idPrefix - ツールバー等の要素IDプレフィックス
   * @param {string} config.title - ウィンドウタイトル
   * @param {string} config.windowClass - ウィンドウ追加CSSクラス
   * @param {string} config.toggleButtonId - 表示切り替えボタンID
   * @param {string} config.exportBaseName - PDF/DXFファイル名（拡張子なし）
   * @param {Array<string>} config.tableSelectors - PDF出力対象テーブルのセレクター（優先順）
   * @param {Object} config.renderer - レンダラーインスタンス
   * @param {Object} config.log - createLogger で生成したロガー
   */
  constructor(config) {
    this.config = config;
    this.renderer = config.renderer;
    this.log = config.log;
    this.renderSettings = {
      scaleDenominator: 40,
    };
    this.currentData = null;
    this.currentDoc = null;
    this.currentSource = 'A';
    this.isInitialized = false;
  }

  /**
   * グリッドデータを抽出（サブクラスで実装）
   * @param {Document} _xmlDoc - STB XMLドキュメント
   * @returns {Object} グリッドデータ
   */
  extractGrid(_xmlDoc) {
    throw new Error('extractGrid() must be implemented by subclass');
  }

  /**
   * DXF出力を実行（サブクラスで実装）
   * @param {Object} _gridData - グリッドデータ
   * @param {string} _filename - ファイル名（拡張子なし）
   * @param {string} _stbName - STBファイル名
   * @returns {Promise<void>}
   */
  async exportDxf(_gridData, _filename, _stbName) {
    throw new Error('exportDxf() must be implemented by subclass');
  }

  /**
   * 縮尺以外の描画設定UI（サブクラスで必要に応じてオーバーライド）
   * @returns {string} HTML文字列
   */
  getExtraSettingsHtml() {
    return '';
  }

  /**
   * 追加UIのイベント登録（サブクラスで必要に応じてオーバーライド）
   */
  setupExtraListeners() {}

  /**
   * 追加設定をレンダラーへ反映（サブクラスで必要に応じてオーバーライド）
   */
  applyExtraRenderSettings() {}

  /**
   * 情報行へ追記するラベル（サブクラスで必要に応じてオーバーライド）
   * @returns {Array<string>}
   */
  getExtraInfoParts() {
    return [];
  }

  /**
   * パネルを初期化
   */
  init() {
    if (this.isInitialized) return;

    this.createWindowElement();

    floatingWindowManager.registerWindow({
      windowId: this.config.windowId,
      toggleButtonId: this.config.toggleButtonId,
      closeButtonId: `close-${this.config.windowId}-btn`,
      headerId: `${this.config.windowId}-header`,
      draggable: true,
      resizable: true,
      autoShow: false,
      onShow: () => this.onShow(),
      onHide: () => this.onHide(),
    });

    this.setupEventListeners();

    this.isInitialized = true;
    this.log.info(`${this.constructor.name} initialized`);
  }

  /**
   * ウィンドウ要素を生成
   */
  createWindowElement() {
    const { windowId, idPrefix, title, windowClass } = this.config;
    const windowEl = document.createElement('div');
    windowEl.id = windowId;
    windowEl.className = `floating-window ${windowClass} hidden`;
    windowEl.innerHTML = `
      <div class="float-window-header" id="${windowId}-header">
        <span class="float-window-title">${title}</span>
        <div class="float-window-controls">
          <button class="float-window-btn section-list-export-btn" id="${idPrefix}-export-pdf-btn" title="PDF出力">
            PDF
          </button>
          <button class="float-window-btn section-list-export-btn" id="${idPrefix}-export-dxf-btn" title="DXF出力">
            DXF
          </button>
          <button class="float-window-btn section-list-refresh-btn" id="${idPrefix}-refresh-btn" title="更新">
            ↻
          </button>
          <button class="float-window-btn" id="close-${windowId}-btn">✕</button>
        </div>
      </div>
      <div class="float-window-content section-list-content">
        <div class="section-list-toolbar">
          <div class="section-list-source-selector">
            <label>
              <input type="radio" name="${idPrefix}-source" value="A" checked>
              モデルA
            </label>
            <label>
              <input type="radio" name="${idPrefix}-source" value="B">
              モデルB
            </label>
          </div>
          <div class="section-list-render-settings">
            <label>
              縮尺
              <select id="${idPrefix}-scale-select">
                <option value="20">1/20</option>
                <option value="30">1/30</option>
                <option value="40" selected>1/40</option>
                <option value="50">1/50</option>
                <option value="75">1/75</option>
                <option value="100">1/100</option>
              </select>
            </label>
            ${this.getExtraSettingsHtml()}
          </div>
          <div class="section-list-info" id="${idPrefix}-info"></div>
        </div>
        <div class="section-list-table-wrapper" id="${idPrefix}-table-container">
          <div class="section-list-loading">データを読み込んでいます...</div>
        </div>
      </div>
    `;

    document.body.appendChild(windowEl);
  }

  /**
   * イベントリスナーを設定
   */
  setupEventListeners() {
    const { idPrefix } = this.config;

    const exportPdfBtn = document.getElementById(`${idPrefix}-export-pdf-btn`);
    if (exportPdfBtn) {
      exportPdfBtn.addEventListener('click', () => this.handleExportPdf());
    }

    const exportDxfBtn = document.getElementById(`${idPrefix}-export-dxf-btn`);
    if (exportDxfBtn) {
      exportDxfBtn.addEventListener('click', () => this.handleExportDxf());
    }

    const refreshBtn = document.getElementById(`${idPrefix}-refresh-btn`);
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.refresh());
    }

    const sourceRadios = document.querySelectorAll(`input[name="${idPrefix}-source"]`);
    sourceRadios.forEach((radio) => {
      radio.addEventListener('change', (e) => this.handleSourceChange(e.target.value));
    });

    const scaleSelect = document.getElementById(`${idPrefix}-scale-select`);
    if (scaleSelect) {
      scaleSelect.addEventListener('change', () => {
        this.updateRenderSettingsFromControls();
        this.rerenderCurrentData();
      });
    }

    this.setupExtraListeners();
  }

  /**
   * ウィンドウ表示時のコールバック
   */
  onShow() {
    this.log.info(`${this.constructor.name} shown`);
    this.updateRenderSettingsFromControls();
    this.refresh();
  }

  /**
   * ウィンドウ非表示時のコールバック
   */
  onHide() {
    this.log.info(`${this.constructor.name} hidden`);
  }

  /**
   * データソースを変更
   * @param {string} source - 'A' または 'B'
   */
  handleSourceChange(source) {
    this.currentSource = source;
    this.log.info(`Source changed to: ${source}`);
    this.refresh(source);
  }

  /**
   * データを更新・再描画
   * @param {string} [source] - データソース（'A' または 'B'）
   */
  refresh(source) {
    const { idPrefix } = this.config;
    const container = document.getElementById(`${idPrefix}-table-container`);
    const infoEl = document.getElementById(`${idPrefix}-info`);

    if (!container) return;

    if (!source) {
      const checkedRadio = document.querySelector(`input[name="${idPrefix}-source"]:checked`);
      source = checkedRadio ? checkedRadio.value : 'A';
    }
    this.currentSource = source;

    const xmlDoc = source === 'A' ? getState('models.documentA') : getState('models.documentB');

    if (!xmlDoc) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'section-list-empty';
      emptyDiv.textContent = `モデル${source}が読み込まれていません`;
      container.innerHTML = '';
      container.appendChild(emptyDiv);
      if (infoEl) infoEl.textContent = '';
      return;
    }

    // ローディング表示
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'section-list-loading';
    loadingDiv.textContent = 'データを抽出しています...';
    container.innerHTML = '';
    container.appendChild(loadingDiv);
    this.updateRenderSettingsFromControls();

    // 非同期で処理（UIブロックを避ける）
    setTimeout(() => {
      try {
        this.currentData = this.extractGrid(xmlDoc);
        this.currentDoc = xmlDoc;

        container.classList.add('grid-mode');
        this.renderer.renderGrid(this.currentData, container);
        this.updateInfoLabel(infoEl);

        this.log.info('Section grid rendered', {
          floors: this.currentData.stories?.length,
          symbols: this.currentData.symbols?.length,
          totalCells:
            (this.currentData.stories?.length || 0) * (this.currentData.symbols?.length || 0),
        });
      } catch (error) {
        this.log.error('Error rendering section grid:', error);
        const errorDiv = document.createElement('div');
        errorDiv.className = 'section-list-error';
        errorDiv.textContent = `エラー: ${error.message}`;
        container.innerHTML = '';
        container.appendChild(errorDiv);
      }
    }, 10);
  }

  /**
   * 情報行（階 × 符号 + 縮尺 + 追加ラベル）を更新
   * @param {HTMLElement|null} infoEl
   */
  updateInfoLabel(infoEl) {
    if (!infoEl || !this.currentData) return;
    const floorCount = this.currentData.stories?.length || 0;
    const symbolCount = this.currentData.symbols?.length || 0;
    const parts = [`${floorCount}階 × ${symbolCount}符号`];
    const scaleLabel = this.renderer.getScaleLabel();
    if (scaleLabel) parts.push(scaleLabel);
    parts.push(...this.getExtraInfoParts());
    infoEl.textContent = parts.join(' | ');
  }

  /**
   * PDF出力を処理
   */
  async handleExportPdf() {
    const { idPrefix, tableSelectors, exportBaseName } = this.config;
    const tableContainer = document.getElementById(`${idPrefix}-table-container`);
    let table = null;
    for (const selector of tableSelectors) {
      table = tableContainer?.querySelector(selector);
      if (table) break;
    }

    if (!table) {
      showWarning('出力するテーブルがありません。');
      return;
    }

    const exportBtn = document.getElementById(`${idPrefix}-export-pdf-btn`);
    if (exportBtn) {
      exportBtn.disabled = true;
      exportBtn.textContent = '...';
    }

    try {
      await exportToPdf(table, `${exportBaseName}.pdf`);
      this.log.info('PDF exported successfully');
    } catch (error) {
      this.log.error('PDF export failed:', error);
      showError(`PDF出力に失敗しました: ${error.message}`);
    } finally {
      if (exportBtn) {
        exportBtn.disabled = false;
        exportBtn.textContent = 'PDF';
      }
    }
  }

  /**
   * DXF出力を処理
   */
  async handleExportDxf() {
    if (!this.currentData) {
      showWarning('出力するデータがありません。');
      return;
    }

    const { idPrefix, exportBaseName } = this.config;
    const exportBtn = document.getElementById(`${idPrefix}-export-dxf-btn`);
    if (exportBtn) {
      exportBtn.disabled = true;
      exportBtn.textContent = '...';
    }

    try {
      const source = this.currentSource || 'A';
      const fileKey = source === 'A' ? 'files.originalFileA' : 'files.originalFileB';
      const file = getState(fileKey);
      const stbName = file?.name ? file.name.replace(/\.[^/.]+$/, '') : '';
      await this.exportDxf(this.currentData, exportBaseName, stbName);
      this.log.info('DXF exported successfully');
    } catch (error) {
      this.log.error('DXF export failed:', error);
      showError(`DXF出力に失敗しました: ${error.message}`);
    } finally {
      if (exportBtn) {
        exportBtn.disabled = false;
        exportBtn.textContent = 'DXF';
      }
    }
  }

  /**
   * ツールバーから描画設定を反映
   */
  updateRenderSettingsFromControls() {
    const scaleSelect = document.getElementById(`${this.config.idPrefix}-scale-select`);
    const scaleDenominator = Number(scaleSelect?.value || this.renderSettings.scaleDenominator);

    this.renderSettings.scaleDenominator = Number.isFinite(scaleDenominator)
      ? scaleDenominator
      : this.renderSettings.scaleDenominator;
    this.renderer.setScaleDenominator(this.renderSettings.scaleDenominator);

    this.applyExtraRenderSettings();
  }

  /**
   * 既存抽出データで再描画
   */
  rerenderCurrentData() {
    const { idPrefix } = this.config;
    const container = document.getElementById(`${idPrefix}-table-container`);
    const infoEl = document.getElementById(`${idPrefix}-info`);
    if (!container) return;
    if (!this.currentData) {
      this.refresh();
      return;
    }

    this.renderer.renderGrid(this.currentData, container);
    this.updateInfoLabel(infoEl);
  }

  /**
   * パネルを表示
   */
  show() {
    floatingWindowManager.showWindow(this.config.windowId);
  }

  /**
   * パネルを非表示
   */
  hide() {
    floatingWindowManager.hideWindow(this.config.windowId);
  }

  /**
   * パネルの表示/非表示を切り替え
   */
  toggle() {
    floatingWindowManager.toggleWindow(this.config.windowId);
  }

  /**
   * パネルが表示されているか確認
   * @returns {boolean}
   */
  isVisible() {
    return floatingWindowManager.isWindowVisible(this.config.windowId);
  }
}

export default BaseSectionListPanel;
