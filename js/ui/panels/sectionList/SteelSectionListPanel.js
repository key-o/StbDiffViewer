/** S柱/S梁断面リストパネル（共通の出力・分割・DrawingProject保存UI）。 */
import { BaseSectionListPanel } from './BaseSectionListPanel.js';
import {
  extractSteelColumnSectionGrid,
  extractSteelBeamSectionGrid,
} from '../../../data/extractors/steelSectionListExtractor.js';
import { extractSrcColumnSectionGrid, extractSrcBeamSectionGrid } from '../../../data/extractors/srcSectionListExtractor.js';
import { SteelSectionListRenderer } from './SteelSectionListRenderer.js';
import { exportSteelSectionListToDxf } from './SteelSectionListDxfExporter.js';
import { createLogger } from '../../../utils/logger.js';

const TYPES = Object.freeze({
  'steel-column': {
    title: 'S柱断面リスト',
    extract: extractSteelColumnSectionGrid,
    base: 's-column-section-list',
  },
  'steel-beam': {
    title: 'S梁断面リスト',
    extract: extractSteelBeamSectionGrid,
    base: 's-beam-section-list',
  },
  'src-column': { title: 'SRC柱断面リスト', extract: extractSrcColumnSectionGrid, base: 'src-column-section-list' },
  'src-beam': { title: 'SRC梁断面リスト', extract: extractSrcBeamSectionGrid, base: 'src-beam-section-list' },
});

export class SteelSectionListPanel extends BaseSectionListPanel {
  constructor(type) {
    const def = TYPES[type];
    if (!def) throw new RangeError('不明なS断面リスト種別: ' + type);
    super({
      windowId: `${type}-section-list-window`,
      idPrefix: `${type}-section-list`,
      sectionListType: type,
      title: def.title,
      windowClass: 'steel-section-list-window',
      toggleButtonId: 'show' + ({ 'steel-column': 'SteelColumn', 'steel-beam': 'SteelBeam', 'src-column': 'SrcColumn', 'src-beam': 'SrcBeam' })[type] + 'SectionListBtn',
      exportBaseName: def.base,
      tableSelectors: ['.steel-section-grid-table'],
      renderer: new SteelSectionListRenderer(),
      log: createLogger('ui/' + type + 'SectionListPanel'),
    });
    this.extractor = def.extract;
  }
  extractGrid(xmlDoc) {
    return this.extractor(xmlDoc);
  }
  async exportDxf(data, filename, stbName) {
    return exportSteelSectionListToDxf(data, filename, stbName, {
      dxfProfile: this.renderSettings.dxfProfile,
    });
  }
}

const instances = new Map();
export function getSteelSectionListPanel(type) {
  if (!instances.has(type)) instances.set(type, new SteelSectionListPanel(type));
  return instances.get(type);
}
export function initSteelColumnSectionListPanel() {
  getSteelSectionListPanel('steel-column').init();
}
export function initSteelBeamSectionListPanel() {
  getSteelSectionListPanel('steel-beam').init();
}
export function initSrcColumnSectionListPanel() {
  getSteelSectionListPanel('src-column').init();
}
export function initSrcBeamSectionListPanel() {
  getSteelSectionListPanel('src-beam').init();
}
