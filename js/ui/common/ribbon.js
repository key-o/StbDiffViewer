/**
 * @fileoverview アイコン主体リボンの共通部品（簡易CAD・モデル編集で共有）。
 *
 * タブ・グループ・コマンド（SVGアイコン + 短ラベル）・縦積みコントロールの markup 生成と、
 * タブ切替の配線だけを持つ。業務ロジックや状態は持たない。見た目は style/components/ribbon.css。
 */

/**
 * 24x24 viewBox の線画アイコン。キーは用途名。
 * 図形の重複や、1つのリボン内での別コマンドへの使い回しは ribbonIcons.test.js で検出する。
 */
const ICON_PATHS = Object.freeze({
  // 編集履歴・モデル登録・配置基準
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12H9"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h5"/>',
  modelA: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 17l4-10 4 10M9.6 13h4.8"/>',
  modelB:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 7h3.5a2.5 2.5 0 010 5H9zM9 12h4a2.5 2.5 0 010 5H9z"/>',
  pickBasis:
    '<rect x="3" y="3" width="11" height="11" stroke-dasharray="2 2"/><path d="M12 12l8 3-3.5 1.5L15 20z"/>',
  // 修正
  edit: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
  move: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M4 16V4h12"/>',
  cancel: '<circle cx="12" cy="12" r="9"/><path d="M8 8l8 8M16 8l-8 8"/>',
  alignAxis: '<path d="M4 3v18" stroke-dasharray="2 2"/><path d="M4 7h14M4 12h9M4 17h16"/>',
  alignPoints:
    '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M7.5 16.5l9-9M13 7h4v4"/>',
  followNodes:
    '<circle cx="5" cy="17" r="2"/><circle cx="19" cy="17" r="2"/><path d="M7 17h10M5 13V5M19 13V5M3 7l2-2 2 2M17 7l2-2 2 2"/>',
  joinOffset: '<path d="M4 21V3h6v10h11v8z"/><path d="M10 13l-3 3M13 13v3"/>',
  // 簡易CAD: ビュー・シート
  view: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  planCut:
    '<rect x="3" y="3" width="18" height="18"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18" stroke-dasharray="1 2"/><rect x="7" y="7" width="10" height="10"/>',
  elevationCut: '<path d="M3 21h18M5 21V4M12 21V4M19 21V4M5 4h14M5 12h14"/>',
  sheetList:
    '<path d="M7 3h14v14"/><rect x="3" y="7" width="14" height="14" rx="1"/><path d="M10 21v-4h7"/>',
  sheetNew: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M12 9v6M9 12h6"/>',
  sheetInfo: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M12 10.5V17M12 7v.5"/>',
  placeView:
    '<rect x="3" y="4" width="18" height="16" rx="1"/><rect x="6" y="7" width="8" height="7"/><path d="M16 8h2M16 11h2"/>',
  placeList:
    '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M6 8h12M6 12h12M6 16h12M10 8v8"/>',
  sheetExport: '<path d="M13 3H4v18h16v-8"/><path d="M12 12l9-9M15 3h6v6"/>',
  // 簡易CAD: タグ・レビュー
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
  tagType: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M7 9h6M7 13h10M7 16h4"/>',
  review: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  note: '<path d="M4 4h16v12H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
  // 簡易CAD: 参照・出力
  dxfAdd: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M12 10v7M8.5 13.5h7"/>',
  dxfLayers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5M3 16l9 5 9-5"/>',
  dxfSave: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M12 10v7M9 14l3 3 3-3"/>',
  stbExport: '<path d="M13 21H6V3h8l4 4v5"/><path d="M14 3v4h4M14 17h7M18 14l3 3-3 3"/>',
  clear: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  pdf: '<rect x="3" y="3" width="12" height="15" rx="1"/><rect x="9" y="7" width="12" height="14" rx="1"/>',
  print:
    '<path d="M7 8V3h10v5"/><rect x="3" y="8" width="18" height="9" rx="1"/><path d="M7 14h10v7H7z"/>',
  project: '<path d="M4 5h6l2 2h8v12H4z"/>',
  diag: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  // 部材・通り芯
  node: '<circle cx="12" cy="12" r="3.5"/>',
  column: '<rect x="8" y="3" width="8" height="18"/>',
  post: '<path d="M12 3v18M9 3h6M9 21h6"/>',
  girder: '<path d="M3 9h18v6H3z"/>',
  beam: '<path d="M3 12h18M3 9v6M21 9v6"/>',
  brace: '<path d="M4 4v16M20 4v16M5 19L19 5"/>',
  slab: '<path d="M3 14l9-5 9 5-9 5z"/>',
  wall: '<rect x="3" y="7" width="18" height="10"/><path d="M3 12h18M9 7v5M15 12v5"/>',
  pile: '<path d="M12 3v14M8 3h8M12 21l-3-4h6z"/>',
  footing: '<path d="M3 19h18M6 19v-4h12v4M10 15V6h4v9"/>',
  foundationColumn: '<path d="M8 3h8v11H8zM4 21h16v-7H4z"/>',
  parapet: '<path d="M3 19h18M5 19V9h14v10M5 14h14"/>',
  story: '<path d="M3 7h18M3 12h18M3 17h18"/>',
  axis: '<circle cx="12" cy="5" r="2"/><path d="M12 7v14"/>',
  arcAxis: '<path d="M4 19a9 9 0 0116 0"/><circle cx="12" cy="6" r="2"/>',
  radialAxis: '<path d="M12 12V3M12 12l8 5M12 12l-8 5"/>',
  joint: '<path d="M3 12h6M15 12h6"/><rect x="9" y="8" width="6" height="8"/>',
  opening: '<rect x="4" y="4" width="16" height="16"/><rect x="9" y="9" width="6" height="6"/>',
  jointArrangement: '<path d="M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6"/>',
  region:
    '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><rect x="9" y="9" width="6" height="6" stroke-dasharray="2 2"/>',
});

export function ribbonIcon(name) {
  const paths = ICON_PATHS[name];
  if (!paths) throw new RangeError(`未定義のリボンアイコンです: ${name}`);
  return `<svg class="ribbon-icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
}

export function hasRibbonIcon(name) {
  return Object.hasOwn(ICON_PATHS, name);
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** アイコン + 短ラベルのコマンド（button）。 */
export function ribbonCommandHtml({
  id = '',
  icon,
  label,
  title = '',
  disabled = false,
  className = '',
  attributes = '',
}) {
  const classes = `ribbon-cmd${className ? ` ${className}` : ''}`;
  return `<button type="button"${id ? ` id="${id}"` : ''} class="${classes}"${
    title ? ` title="${escapeAttribute(title)}"` : ''
  }${disabled ? ' disabled' : ''}${attributes ? ` ${attributes}` : ''}>${ribbonIcon(icon)}<span class="ribbon-cmd-label">${label}</span></button>`;
}

/** DOM 版。動的に生成するコマンド（作成コマンド等）に使う。 */
export function createRibbonCommand({ id, icon, label, title = label, className = '' }) {
  const wrapper = document.createElement('template');
  wrapper.innerHTML = ribbonCommandHtml({ id, icon, label, title, className });
  const button = wrapper.content.firstElementChild;
  button.setAttribute('aria-label', label);
  return button;
}

/** 既存 button（他モジュールが生成・配線済み）をリボンのコマンド表示へ差し替える。id と listener は保つ。 */
export function decorateAsRibbonCommand(button, { icon, label, className = '' }) {
  // 元の外観クラス（btn系）は複製元から引き継がれているだけなので外し、リボンの見た目に統一する。
  button.classList.remove('btn', 'btn-secondary', 'btn-primary');
  button.classList.add('ribbon-cmd', ...className.split(' ').filter(Boolean));
  const wrapper = document.createElement('template');
  wrapper.innerHTML = `${ribbonIcon(icon)}<span class="ribbon-cmd-label">${label}</span>`;
  button.replaceChildren(wrapper.content);
}

/** ファイル選択コマンド。input は label 内に置き、既存の change 配線をそのまま使う。 */
export function ribbonFileCommandHtml({ id, icon, label, title, accept, multiple = false }) {
  return `<label class="ribbon-cmd ribbon-cmd-file" title="${escapeAttribute(title)}">${ribbonIcon(icon)}<span class="ribbon-cmd-label">${label}</span><input id="${id}" class="ribbon-file-input" type="file" accept="${accept}"${
    multiple ? ' multiple' : ''
  }></label>`;
}

export function ribbonGroupHtml(label, content, { className = '' } = {}) {
  return `<section class="ribbon-group${className ? ` ${className}` : ''}" aria-label="${label}"><div class="ribbon-group-content">${content}</div><div class="ribbon-group-label">${label}</div></section>`;
}

/** 小型コントロールの縦積み。 */
export function ribbonStackHtml(content) {
  return `<div class="ribbon-stack">${content}</div>`;
}

/**
 * タブ列とタブ本体を返す。本体は先頭タブだけ表示する。
 * @param {string} idPrefix 例: 'pdf-overlay' → #pdf-overlay-tab-home / #pdf-overlay-ribbon-home
 * @param {{id: string, label: string, body: string}[]} tabs
 */
export function ribbonTabsHtml(idPrefix, tabs) {
  const tabList = tabs
    .map(
      (tab, index) =>
        `<button type="button" class="ribbon-tab" role="tab" id="${idPrefix}-tab-${tab.id}" data-ribbon-tab="${tab.id}" aria-selected="${index === 0}" aria-controls="${idPrefix}-ribbon-${tab.id}">${tab.label}</button>`,
    )
    .join('');
  const bodies = tabs
    .map(
      (tab, index) =>
        `<div class="ribbon-body" role="tabpanel" id="${idPrefix}-ribbon-${tab.id}" data-ribbon-body="${tab.id}" aria-labelledby="${idPrefix}-tab-${tab.id}"${index === 0 ? '' : ' hidden'}>${tab.body}</div>`,
    )
    .join('');
  return { tabList: `<div class="ribbon-tablist" role="tablist">${tabList}</div>`, bodies };
}

/** タブ切替のみ配線する。 */
export function wireRibbonTabs(root) {
  const tabs = [...root.querySelectorAll('[data-ribbon-tab]')];
  const bodies = [...root.querySelectorAll('[data-ribbon-body]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const other of tabs) other.setAttribute('aria-selected', String(other === tab));
      for (const body of bodies) body.hidden = body.dataset.ribbonBody !== tab.dataset.ribbonTab;
    });
  }
}

/** リボンのコマンドはアイコンを持つため、ラベル span があればそこだけを読み書きする。 */
export function getCommandLabel(button) {
  return (button.querySelector?.('.ribbon-cmd-label') || button).textContent;
}

export function setCommandLabel(button, text) {
  (button.querySelector?.('.ribbon-cmd-label') || button).textContent = text;
}
