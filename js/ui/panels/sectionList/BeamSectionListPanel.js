/**
 * @fileoverview RC梁断面リストパネル
 *
 * フローティングウィンドウとしてRC梁断面リストを表示するパネルコンポーネント。
 * 共通ロジックは BaseSectionListPanel が提供し、本クラスは
 * 作図かぶり設定UIなど梁固有の拡張のみを実装します。
 *
 * @module ui/sectionList/BeamSectionListPanel
 */

import { BaseSectionListPanel } from './BaseSectionListPanel.js';
import { extractBeamSectionGrid } from '../../../data/extractors/beamSectionList/index.js';
import { BeamSectionListRenderer } from './BeamSectionListRenderer.js';
import { exportBeamSectionListToDxf } from './SectionListDxfExporter.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('ui/BeamSectionListPanel');

/**
 * RC梁断面リストパネルクラス
 */
export class BeamSectionListPanel extends BaseSectionListPanel {
  constructor() {
    super({
      windowId: 'beam-section-list-window',
      idPrefix: 'beam-section-list',
      title: 'RC梁断面リスト',
      windowClass: 'beam-section-list-window',
      toggleButtonId: 'showBeamSectionListBtn',
      exportBaseName: 'rc-beam-section-list',
      tableSelectors: ['.beam-section-grid-table'],
      renderer: new BeamSectionListRenderer({ scaleDenominator: 40, coverThickness: null }),
      log,
    });
    this.renderSettings.coverThickness = null;
  }

  /** @inheritdoc */
  extractGrid(xmlDoc) {
    return extractBeamSectionGrid(xmlDoc);
  }

  /** @inheritdoc */
  async exportDxf(gridData, filename, stbName) {
    await exportBeamSectionListToDxf(gridData, filename, stbName, {
      coverThickness: this.renderSettings.coverThickness,
    });
  }

  /** @inheritdoc */
  getExtraSettingsHtml() {
    return `
            <label>
              作図かぶり
              <input id="${this.config.idPrefix}-cover-input" type="number" min="10" max="120" step="5" placeholder="基準" title="空欄で基準作図値（STP芯50mm・主筋芯72mm）。入力値はSTP芯位置としてSVG/DXFへ共通適用">
              mm
            </label>`;
  }

  /** @inheritdoc */
  setupExtraListeners() {
    const coverInput = document.getElementById(`${this.config.idPrefix}-cover-input`);
    if (coverInput) {
      const applyCoverChange = () => {
        this.updateRenderSettingsFromControls();
        this.rerenderCurrentData();
      };
      coverInput.addEventListener('change', applyCoverChange);
      coverInput.addEventListener('blur', applyCoverChange);
    }
  }

  /** @inheritdoc */
  applyExtraRenderSettings() {
    const coverInput = document.getElementById(`${this.config.idPrefix}-cover-input`);
    const coverText = String(coverInput?.value || '').trim();
    const coverThickness = coverText === '' ? null : Number(coverText);

    this.renderSettings.coverThickness =
      Number.isFinite(coverThickness) && coverThickness > 0 ? coverThickness : null;
    this.renderer.setCoverThickness(this.renderSettings.coverThickness);
  }

  /** @inheritdoc */
  getExtraInfoParts() {
    return [
      this.renderSettings.coverThickness
        ? `作図かぶり ${this.renderSettings.coverThickness}mm`
        : '作図かぶり 基準（STP芯50 / 主筋芯72mm）',
    ];
  }
}

/**
 * グローバルなシングルトンインスタンス
 */
let beamSectionListPanel = null;

/**
 * RC梁断面リストパネルを取得（シングルトン）
 * @returns {BeamSectionListPanel}
 */
export function getBeamSectionListPanel() {
  if (!beamSectionListPanel) {
    beamSectionListPanel = new BeamSectionListPanel();
  }
  return beamSectionListPanel;
}

/**
 * RC梁断面リストパネルを初期化
 */
export function initBeamSectionListPanel() {
  const panel = getBeamSectionListPanel();
  panel.init();
}
