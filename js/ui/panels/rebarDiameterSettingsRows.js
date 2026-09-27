/**
 * @fileoverview 表示要素設定テーブルの「鉄筋径」色設定行。
 */

import { DEFAULT_REBAR_DIAMETER_COLORS } from '../../config/rebarDiameterColorConfig.js';
import rebarDiameterColorManager from '../../viewer/rendering/rebarDiameterColorManager.js';

export const REBAR_DIAMETER_GROUP_ID = 'RebarDiameterGroup';

export const REBAR_DIAMETER_SETTINGS = Object.keys(DEFAULT_REBAR_DIAMETER_COLORS).map((key) => ({
  key,
  label: key === 'DEFAULT' ? 'その他' : key,
}));

function emptyCell(content = '') {
  const td = document.createElement('td');
  td.textContent = content;
  return td;
}

function createGroupRow() {
  const tr = document.createElement('tr');
  tr.className = 'element-group-row has-sub-categories';
  tr.dataset.groupId = REBAR_DIAMETER_GROUP_ID;

  const nameTd = document.createElement('td');
  const toggle = document.createElement('span');
  toggle.className = 'element-group-toggle';
  toggle.textContent = '\u25B6';
  toggle.title = '鉄筋径の色設定を展開';
  toggle.dataset.groupId = REBAR_DIAMETER_GROUP_ID;
  nameTd.appendChild(toggle);
  nameTd.appendChild(document.createTextNode(' 鉄筋径'));
  tr.appendChild(nameTd);

  for (let i = 0; i < 5; i += 1) tr.appendChild(emptyCell(i < 4 ? '-' : ''));
  return tr;
}

function createDiameterRow(setting) {
  const tr = document.createElement('tr');
  tr.className = 'element-sub-row rebar-diameter-setting-row';
  tr.dataset.parentGroup = REBAR_DIAMETER_GROUP_ID;
  tr.dataset.rebarDiameter = setting.key;
  tr.style.display = 'none';

  const nameTd = document.createElement('td');
  nameTd.className = 'element-sub-label';
  nameTd.textContent = setting.label;
  tr.appendChild(nameTd);
  for (let i = 0; i < 4; i += 1) tr.appendChild(emptyCell('-'));

  const colorTd = document.createElement('td');
  const input = document.createElement('input');
  input.type = 'color';
  input.className = 'element-color-input rebar-diameter-color-input';
  input.dataset.rebarDiameter = setting.key;
  input.title = `${setting.label}の鉄筋色を変更`;
  input.value = rebarDiameterColorManager.getRebarDiameterColor(setting.key);
  input.addEventListener('change', (event) => {
    rebarDiameterColorManager.setRebarDiameterColor(setting.key, event.target.value);
    if (typeof window.requestRender === 'function') window.requestRender();
  });
  colorTd.appendChild(input);
  tr.appendChild(colorTd);
  return tr;
}

/**
 * @param {HTMLTableSectionElement} tbody
 */
export function appendRebarDiameterSettingsRows(tbody) {
  if (!tbody) return;
  tbody.appendChild(createGroupRow());
  for (const setting of REBAR_DIAMETER_SETTINGS) tbody.appendChild(createDiameterRow(setting));
}
