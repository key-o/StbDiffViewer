/** S柱/S梁リストテーブル。断面、端部位置、材質を明示する。 */
import { escapeHtml } from '../../../utils/htmlUtils.js';
import { steelProfileSvg } from './steelSectionProfile.js';
import { SrcSectionListRenderer } from './SrcSectionListRenderer.js';

export class SteelSectionListRenderer {
  constructor() {
    this.scaleDenominator = 40;
    this.srcRenderer = new SrcSectionListRenderer();
  }
  setScaleDenominator(value) {
    this.scaleDenominator = value;
    this.srcRenderer.setScaleDenominator(value);
  }
  getScaleLabel() {
    return `1/${this.scaleDenominator}`;
  }
  getGridCellData(grid, storyId, symbol) {
    return grid.get(`${storyId}:${symbol}`);
  }
  renderGrid({ stories, symbols, grid, type }, container) {
    const isSrc = type === 'src-column' || type === 'src-beam';
    if (isSrc) {
      this.srcRenderer.renderGrid({ stories, symbols, grid, type }, container);
      return;
    }
    if (!stories.length || !symbols.length) {
      container.innerHTML =
        '<div class="section-list-empty">該当する断面がありません</div>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'steel-section-grid-table';
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const name of ['階', ...symbols]) {
      const th = document.createElement('th');
      th.className = name === '階' ? 'section-grid-header-floor' : 'section-grid-header-symbol';
      th.textContent = name;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const story of stories) {
      const row = document.createElement('tr');
      const floor = document.createElement('td');
      floor.className = 'section-grid-floor-cell';
      floor.textContent = story.name;
      row.appendChild(floor);
      for (const symbol of symbols) {
        const td = document.createElement('td');
        td.className = 'section-grid-section-cell';
        const section = grid.get(`${story.id}:${symbol}`);
        if (!section) {
          td.textContent = '—';
          td.classList.add('empty');
        } else if (!section.variants.length) td.textContent = '断面形状の定義がありません';
        else {
          const entries = section.variants
            .map(
              (v) => `<div class="steel-section-variant">
            <strong>${escapeHtml(v.pos)}</strong>
            ${steelProfileSvg(v.profile, this.scaleDenominator)}
            <span>鉄骨: ${escapeHtml(v.shape)}</span>
            <span>材質: ${escapeHtml([v.strengthMain, v.strengthWeb && v.strengthWeb !== v.strengthMain ? `web ${v.strengthWeb}` : ''].filter(Boolean).join(' / ') || '未指定')}</span>
          </div>`,
            )
            .join('');
          td.innerHTML = `<div class="steel-section-variants">${entries}</div>`;
        }
        row.appendChild(td);
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    container.replaceChildren(table);
    container.dataset.sectionListType = type;
  }
}
