/**
 * @fileoverview RC柱断面リストパネル
 *
 * フローティングウィンドウとしてRC柱断面リストを表示するパネルコンポーネント。
 * 共通ロジックは BaseSectionListPanel が提供します。
 *
 * @module ui/sectionList/ColumnSectionListPanel
 */

import { BaseSectionListPanel } from './BaseSectionListPanel.js';
import { extractColumnSectionGrid } from '../../../data/extractors/columnSectionListExtractor.js';
import { ConfiguredColumnSectionListRenderer } from './ConfiguredColumnSectionListRenderer.js';
import { exportColumnSectionListToDxf } from './SectionListDxfExporter.js';
import {
  BASELINE_COLUMN_COVER_FACES,
  normalizeColumnCoverFaces,
} from './columnSectionCover.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('ui/ColumnSectionListPanel');
const COVER_KEYS = ['startX', 'endX', 'startY', 'endY'];
const COVER_LABELS = {
  startX: 'X始',
  endX: 'X終',
  startY: 'Y始',
  endY: 'Y終',
};

/**
 * RC柱断面リストパネルクラス
 */
export class ColumnSectionListPanel extends BaseSectionListPanel {
  constructor() {
    super({
      windowId: 'column-section-list-window',
      idPrefix: 'column-section-list',
      title: 'RC柱断面リスト',
      windowClass: 'column-section-list-window',
      toggleButtonId: 'showColumnSectionListBtn',
      exportBaseName: 'rc-column-section-list',
      tableSelectors: ['.column-section-grid-table', '.column-section-list-table'],
      renderer: new ConfiguredColumnSectionListRenderer({
        scaleDenominator: 40,
        coverFaces: BASELINE_COLUMN_COVER_FACES,
      }),
      log,
    });
    this.renderSettings.coverFaces = { ...BASELINE_COLUMN_COVER_FACES };
  }

  /** @inheritdoc */
  extractGrid(xmlDoc) {
    return extractColumnSectionGrid(xmlDoc);
  }

  /** @inheritdoc */
  getExtraSettingsHtml() {
    const inputs = COVER_KEYS.map(
      (key) => `
        <label title="コンクリート面から外周HOOP芯までの作図かぶり (mm)">
          ${COVER_LABELS[key]}
          <input
            id="${this.config.idPrefix}-cover-${key}"
            type="number"
            min="0"
            step="1"
            value="${BASELINE_COLUMN_COVER_FACES[key]}"
            style="width:4.5em"
          >
        </label>`,
    ).join('');
    return `<span class="column-section-cover-settings">かぶり ${inputs}</span>`;
  }

  /** @inheritdoc */
  setupExtraListeners() {
    COVER_KEYS.forEach((key) => {
      const input = document.getElementById(`${this.config.idPrefix}-cover-${key}`);
      input?.addEventListener('change', () => {
        this.updateRenderSettingsFromControls();
        this.rerenderCurrentData();
      });
    });
  }

  readCoverFacesFromControls() {
    const values = Object.fromEntries(
      COVER_KEYS.map((key) => {
        const input = document.getElementById(`${this.config.idPrefix}-cover-${key}`);
        return [key, input?.value];
      }),
    );
    return normalizeColumnCoverFaces(values, this.renderSettings.coverFaces);
  }

  /** @inheritdoc */
  applyExtraRenderSettings() {
    this.renderSettings.coverFaces = this.readCoverFacesFromControls();
    this.renderer.setCoverFaces(this.renderSettings.coverFaces);
  }

  /** @inheritdoc */
  getExtraInfoParts() {
    const c = this.renderSettings.coverFaces;
    return [`かぶり X始${c.startX}/X終${c.endX}/Y始${c.startY}/Y終${c.endY} mm`];
  }

  /** @inheritdoc */
  async exportDxf(gridData, filename, stbName) {
    await exportColumnSectionListToDxf(gridData, filename, stbName, {
      coverFaces: this.renderSettings.coverFaces,
    });
  }
}

// シングルトンインスタンス
let panelInstance = null;

/**
 * パネルインスタンスを取得（遅延初期化）
 * @returns {ColumnSectionListPanel}
 */
export function getColumnSectionListPanel() {
  if (!panelInstance) {
    panelInstance = new ColumnSectionListPanel();
  }
  return panelInstance;
}

/**
 * パネルを初期化
 */
export function initColumnSectionListPanel() {
  const panel = getColumnSectionListPanel();
  panel.init();
  return panel;
}

export default ColumnSectionListPanel;
