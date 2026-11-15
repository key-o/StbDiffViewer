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
import {
  captureLayoutPages,
  exportToPdf,
  measureGridTable,
  savePdfFromPages,
} from './SectionListPdfExporter.js';
import { openPdfSplitDialog } from './SectionListPdfSplitDialog.js';
import { autoBreaks, buildSheetGrid } from './sectionListPageSplit.js';
import { openSheetEditor } from './SectionListSheetEditor.js';
import {
  resolveSectionListDrawingProjectContext,
  commitSectionListDrawingProjectLayout,
  loadSectionListDrawingProjectLayout,
} from './sectionListDrawingProjectWorkflow.js';
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
      dxfProfile: 'autocad-r12',
    };
    this.currentData = null;
    this.currentDoc = null;
    this.currentSource = 'A';
    this.isInitialized = false;
    /** PDFシート分割の前回値（列・行の区切り / 用紙キー） */
    this.pdfSplitState = { breaks: null, symbolOrder: null, paperKey: null };
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
          <button class="float-window-btn section-list-export-btn" id="${idPrefix}-export-pdf-split-btn" title="階×符号のマトリクスを区切ってシート化し、指定縮尺の実寸で複数ページのPDF出力">
            PDF分割
          </button>
          <button class="float-window-btn section-list-export-btn" id="${idPrefix}-open-stored-sheet-btn" title="共通DrawingProjectに保存したA3梁・柱リストを再編集">
            保存シート編集
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
            <label title="AutoCADはR12 Unicode escape、Jw_cadはShift-JIS実バイトで保存します">
              DXF互換
              <select id="${idPrefix}-dxf-profile-select">
                <option value="autocad-r12" selected>AutoCAD R12</option>
                <option value="jwcad-r12">Jw_cad R12 (Shift-JIS)</option>
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

    const exportPdfSplitBtn = document.getElementById(`${idPrefix}-export-pdf-split-btn`);
    if (exportPdfSplitBtn) {
      exportPdfSplitBtn.addEventListener('click', () => this.handleExportPdfSplit());
    }

    document
      .getElementById(`${idPrefix}-open-stored-sheet-btn`)
      ?.addEventListener('click', () => this.handleEditStoredSheet());
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

    const dxfProfileSelect = document.getElementById(`${idPrefix}-dxf-profile-select`);
    if (dxfProfileSelect) {
      dxfProfileSelect.addEventListener('change', () => this.updateRenderSettingsFromControls());
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
   * PDF出力対象のテーブル要素を取得
   * @returns {HTMLElement|null}
   */
  findExportTable() {
    const { idPrefix, tableSelectors } = this.config;
    const tableContainer = document.getElementById(`${idPrefix}-table-container`);
    for (const selector of tableSelectors) {
      const table = tableContainer?.querySelector(selector);
      if (table) return table;
    }
    return null;
  }

  /**
   * PDF出力を処理
   */
  async handleExportPdf() {
    await this.runPdfExport();
  }

  /**
   * 階×符号のマトリクスで区切り、簡易CADビューで用紙へ配置・調整してPDF出力する
   * （区切りマトリクス → 簡易CADビュー → PDF）
   */
  async handleExportPdfSplit({ initialLayout = null } = {}) {
    const sourceAtOpen = this.currentDoc;
    const dataAtOpen = this.currentData;
    const sourceSlotAtOpen = this.currentSource;
    const { symbols, stories, grid } = this.currentData || {};
    if (!this.findExportTable() || !symbols?.length || !stories?.length) {
      showWarning('出力するテーブルがありません。');
      return;
    }

    const { exportBaseName, idPrefix } = this.config;
    const storyIds = stories.map((story) => story.id);
    const hasCell = (storyId, symbol) =>
      Boolean(this.renderer.getGridCellData(grid, storyId, symbol));

    for (;;) {
      const table = this.findExportTable();
      if (!table) return;
      const metrics = measureGridTable(table, storyIds, { compactColumns: true });
      const result = initialLayout
        ? {
            sheets: [],
            symbolOrder: symbols,
            paperKey: initialLayout.paperKey,
          }
        : await openPdfSplitDialog({
            symbols,
            stories,
            metrics,
            scaleLabel: `1/${this.renderSettings.scaleDenominator}`,
            hasCell,
            initialBreaks: this.pdfSplitState.breaks,
            initialSymbolOrder: this.pdfSplitState.symbolOrder,
            initialPaperKey: this.pdfSplitState.paperKey,
          });
      if (!result) return;

      if (!initialLayout) {
        this.pdfSplitState = {
          breaks: { colBreakAfter: result.colBreakAfter, rowBreakAfter: result.rowBreakAfter },
          symbolOrder: result.symbolOrder,
          paperKey: result.paperKey,
        };
      }

      const scaleSelect = document.getElementById(`${idPrefix}-scale-select`);
      const layout = await openSheetEditor({
        sheets: result.sheets,
        symbols: result.symbolOrder,
        stories,
        initialLayout,
        paperKey: result.paperKey,
        scaleDenominator: this.renderSettings.scaleDenominator,
        scaleOptions: [...(scaleSelect?.options || [])].map((o) => Number(o.value)),
        getTable: () => this.findExportTable(),
        setScale: (denominator) => {
          if (scaleSelect) scaleSelect.value = String(denominator);
          this.updateRenderSettingsFromControls();
          this.rerenderCurrentData();
        },
        autoSplit: (paperKey, options) => {
          const current = this.findExportTable();
          const nextMetrics = measureGridTable(current, storyIds, options);
          const breaks = autoBreaks({
            symbols: result.symbolOrder,
            storyIds,
            metrics: nextMetrics,
            paperKey,
          });
          return buildSheetGrid({
            symbols: result.symbolOrder,
            storyIds,
            ...breaks,
            hasCell,
          }).sheets;
        },
        hasCell,
      });
      if (!layout) return;
      if (layout.action === 'back') {
        if (initialLayout) return;
        continue;
      }

      this.pdfSplitState.paperKey = layout.paperKey;
      if (layout.action === 'save-project') {
        try {
          if (
            this.currentDoc !== sourceAtOpen ||
            this.currentData !== dataAtOpen ||
            this.currentSource !== sourceSlotAtOpen
          )
            throw new Error('編集途中で梁・柱リストの入力モデルが変更されました。');
          const context = await resolveSectionListDrawingProjectContext({
            source: this.currentSource,
            xmlDocument: this.currentDoc,
          });
          await commitSectionListDrawingProjectLayout({
            context,
            listType: this.config.sectionListType,
            layout,
          });
          this.log.info('Section list pages saved into shared DrawingProject');
        } catch (error) {
          this.log.error('Shared section-list sheet save failed:', error);
          showError('共通シート保存に失敗しました: ' + error.message);
        }
        return;
      }
      try {
        await this.withPdfButtonsBusy(async () => {
          const images = await captureLayoutPages({
            tableElement: this.findExportTable(),
            pages: layout.pages,
            allStoryIds: storyIds,
            paperKey: layout.paperKey,
            compactColumns: layout.compactColumns,
            onProgress: (done, total) => {
              const btn = document.getElementById(`${idPrefix}-export-pdf-split-btn`);
              if (btn) btn.textContent = `${done}/${total}`;
            },
          });
          savePdfFromPages(images, layout.paperKey, `${exportBaseName}.pdf`);
        });
        this.log.info('PDF exported successfully');
      } catch (error) {
        this.log.error('PDF export failed:', error);
        showError(`PDF出力に失敗しました: ${error.message}`);
      }
      return;
    }
  }

  /** Reopen typed A3 list pages from the live DrawingProject, never stale B. */
  async handleEditStoredSheet() {
    try {
      const { layout } = await loadSectionListDrawingProjectLayout({
        source: this.currentSource,
        xmlDocument: this.currentDoc,
        listType: this.config.sectionListType,
      });
      const { symbols, stories } = this.currentData || {};
      if (!this.findExportTable() || !symbols?.length || !stories?.length)
        throw new Error('現在の断面リストを先に生成してください。');
      const validSymbols = new Set(symbols);
      const validStories = new Set(stories.map((story) => String(story.id)));
      for (const page of layout.pages) {
        for (const region of page.regions) {
          if (
            region.symbols.some((symbol) => !validSymbols.has(symbol)) ||
            region.storyIds.some((id) => !validStories.has(String(id)))
          )
            throw new Error('保存済みレイアウトに現在のSTB-Aに存在しない階・符号があります。');
        }
      }
      const select = document.getElementById(`${this.config.idPrefix}-scale-select`);
      if (!select || ![...select.options].some((o) => Number(o.value) === layout.scaleDenominator))
        throw new Error('保存済みレイアウトの縮尺が現在の選択肢にありません。');
      select.value = String(layout.scaleDenominator);
      this.updateRenderSettingsFromControls();
      this.rerenderCurrentData();
      await this.handleExportPdfSplit({ initialLayout: layout });
    } catch (error) {
      this.log.error('Stored section-list sheet edit failed:', error);
      showError('保存シート編集に失敗しました: ' + error.message);
    }
  }

  /**
   * PDFボタンを処理中表示にして非同期処理を実行する
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  async withPdfButtonsBusy(task) {
    const { idPrefix } = this.config;
    const buttons = [`${idPrefix}-export-pdf-btn`, `${idPrefix}-export-pdf-split-btn`]
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    const labels = buttons.map((btn) => btn.textContent);
    buttons.forEach((btn) => {
      btn.disabled = true;
      btn.textContent = '...';
    });
    try {
      return await task();
    } finally {
      buttons.forEach((btn, i) => {
        btn.disabled = false;
        btn.textContent = labels[i];
      });
    }
  }

  /**
   * PDF出力の実行（全体を1枚へ縮小フィット。ボタン状態管理・エラー表示つき）
   */
  async runPdfExport() {
    const { exportBaseName } = this.config;
    const table = this.findExportTable();

    if (!table) {
      showWarning('出力するテーブルがありません。');
      return;
    }

    try {
      await this.withPdfButtonsBusy(() => exportToPdf(table, `${exportBaseName}.pdf`));
      this.log.info('PDF exported successfully');
    } catch (error) {
      this.log.error('PDF export failed:', error);
      showError(`PDF出力に失敗しました: ${error.message}`);
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
      this.updateRenderSettingsFromControls();
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
    const dxfProfileSelect = document.getElementById(`${this.config.idPrefix}-dxf-profile-select`);
    const scaleDenominator = Number(scaleSelect?.value || this.renderSettings.scaleDenominator);

    this.renderSettings.scaleDenominator = Number.isFinite(scaleDenominator)
      ? scaleDenominator
      : this.renderSettings.scaleDenominator;
    this.renderSettings.dxfProfile =
      dxfProfileSelect?.value === 'jwcad-r12' ? 'jwcad-r12' : 'autocad-r12';
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
