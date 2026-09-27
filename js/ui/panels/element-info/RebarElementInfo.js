import { applyPanelSize, setupPanelResizeObserver } from './ElementInfoPanel.js';

const REBAR_KIND_LABELS = Object.freeze({
  columnMain: '柱主筋',
  columnHoop: '柱帯筋',
  girderMain: '大梁主筋',
  girderHoop: '大梁あばら筋',
  beamMain: '小梁主筋',
  beamHoop: '小梁あばら筋',
  beamStirrup: '小梁あばら筋',
  pileMain: '杭主筋',
  pileHoop: '杭帯筋',
  pileBand: '杭帯筋',
  pileSpiral: '杭らせん筋',
  foundationMain: '基礎筋',
  stripFootingMain: '布基礎筋',
});

function appendInfoRow(table, label, value) {
  const row = document.createElement('tr');
  const header = document.createElement('th');
  const cell = document.createElement('td');
  header.textContent = label;
  cell.textContent = value;
  row.append(header, cell);
  table.appendChild(row);
}

export function displayRebarInfo({ rebarKind, barDiameterMm, instanceId, modelSource } = {}) {
  const panel = document.getElementById('component-info');
  const content = document.getElementById('element-info-content');
  if (!panel || !content) return false;

  applyPanelSize(panel);
  setupPanelResizeObserver(panel);

  const title = document.createElement('h3');
  const side = modelSource === 'A' || modelSource === 'B' ? `（モデル${modelSource}）` : '';
  title.textContent = `鉄筋${side}`;

  const table = document.createElement('table');
  const kindRow = document.createElement('tr');
  const kindHeader = document.createElement('th');
  const kindCell = document.createElement('td');
  kindHeader.textContent = '種別';
  kindCell.textContent = REBAR_KIND_LABELS[rebarKind] || rebarKind || '鉄筋';
  kindRow.append(kindHeader, kindCell);
  table.appendChild(kindRow);

  if (Number.isFinite(Number(barDiameterMm)) && Number(barDiameterMm) > 0) {
    appendInfoRow(table, '呼び径', `D${Number(barDiameterMm)}`);
  }
  appendInfoRow(
    table,
    '形状番号',
    instanceId === null || instanceId === undefined ? '単体' : String(instanceId + 1),
  );
  content.replaceChildren(title, table);
  return true;
}
