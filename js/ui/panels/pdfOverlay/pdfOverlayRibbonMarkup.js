/**
 * @fileoverview 簡易CADワークスペースの上部リボン markup、タブ切替、詳細ウィンドウの定義。
 * 既存の `pdf-overlay-*` ID は PdfOverlayPanel が参照するため、DOM の置き場所だけを変える。
 */

import {
  ribbonCommandHtml,
  ribbonFileCommandHtml,
  ribbonGroupHtml,
  ribbonTabsHtml,
  wireRibbonTabs,
} from '../../common/ribbon.js';

const command = ribbonCommandHtml;
const fileCommand = ribbonFileCommandHtml;
const group = ribbonGroupHtml;

/**
 * 詳細機能のフローティングウィンドウ定義。リボンのボタン（pdf-overlay-open-*）で開閉する。
 * 実体の生成は pdfOverlayPanelMarkup、表示管理（ドラッグ・リサイズ・位置保存）は floatingWindowManager。
 */
export const PDF_OVERLAY_FLOAT_WINDOWS = Object.freeze(
  [
    {
      key: 'dxf',
      icon: 'dxf',
      title: '参照DXF一覧',
      label: 'DXF一覧',
      tip: '読み込んだ参照DXFの表示切替・解除を行います',
    },
    {
      key: 'placement',
      icon: 'align',
      title: 'PDF領域・配置',
      label: '領域・配置',
      tip: 'PDF領域と階の対応、SVG配置、A/B/C位置合わせ',
    },
    {
      key: 'selection',
      icon: 'review',
      title: '選択部材・レビュー',
      label: '部材レビュー',
      tip: '選択部材の確認状態とメモを編集します',
    },
    {
      key: 'tagPlacement',
      icon: 'tag',
      title: 'タグ配置',
      label: 'タグ編集',
      tip: 'タグ編集モードと引出線の設定',
    },
    {
      key: 'tagFamily',
      icon: 'tagType',
      title: 'タグタイプ管理',
      label: 'タグタイプ',
      tip: 'タグタイプの複製・編集・書き出し',
    },
    {
      key: 'memo',
      icon: 'note',
      title: '図面上の自由メモ',
      label: '自由メモ',
      tip: '図面座標に結び付く自由メモ',
    },
    {
      key: 'project',
      icon: 'project',
      title: '図面プロジェクト',
      label: 'プロジェクト',
      tip: 'DrawingProject JSON・STB改訂差替え・PDF照合セッション',
    },
    { key: 'diagnostics', icon: 'diag', title: '診断', label: '診断', tip: 'DXF・描画の診断結果' },
  ].map((def) => ({
    ...def,
    windowId: `pdf-overlay-win-${def.key}`,
    toggleButtonId: `pdf-overlay-open-${def.key}`,
    closeButtonId: `pdf-overlay-win-${def.key}-close`,
    headerId: `pdf-overlay-win-${def.key}-header`,
  })),
);

function windowCommand(key) {
  const def = PDF_OVERLAY_FLOAT_WINDOWS.find((entry) => entry.key === key);
  return ribbonCommandHtml({
    id: def.toggleButtonId,
    icon: def.icon,
    label: def.label,
    title: def.tip,
    attributes: `aria-expanded="false" aria-controls="${def.windowId}"`,
  });
}

const HOME_TAB = [
  group(
    '表示',
    `<div class="ribbon-stack">
      <label>表示 <select id="pdf-overlay-display-mode" class="form-control"><option value="stb" selected>SVG図面</option><option value="pdf">PDF重ね</option></select></label>
      <span class="pdf-overlay-zoom-readout" title="マウスホイールで選択部材の中心を基準に拡大縮小します。未選択時はカーソル位置が基準です。Escで選択解除、右ドラッグで表示移動。PDF未読込時のA3 SVG図面でも利用できます">表示倍率 <output id="pdf-overlay-zoom-value">100%</output></span>
    </div>`,
  ),
  group(
    'SVG図面',
    `${command({ id: 'pdf-overlay-build-btn', icon: 'build', label: '図面生成', title: '現在のモデルと階からSVG図面を生成します' })}
    <div class="ribbon-stack">
      <label title="平面切断面となる柱・間柱・壁を部材色で塗りつぶします"><input id="pdf-overlay-cut-fill" type="checkbox" checked>切断面塗り</label>
      <label title="柱・間柱・壁の切断面塗りつぶし濃度">濃さ <input id="pdf-overlay-cut-fill-opacity" type="range" min="0" max="0.6" step="0.02" value="0.18"></label>
    </div>`,
  ),
  group(
    '用紙・縮尺',
    `<div class="ribbon-stack"><label>用紙 <strong>A3横</strong></label>
      <label>縮尺 <select id="pdf-overlay-scale" class="form-control"><option value="50">1/50</option><option value="100">1/100</option><option value="150">1/150</option><option value="200" selected>1/200</option><option value="300">1/300</option><option value="custom">カスタム</option></select></label>
      <label id="pdf-overlay-custom-scale-wrap" class="pdf-overlay-custom-scale" hidden>1/<input id="pdf-overlay-custom-scale" class="form-control" type="number" min="1" step="any" value="250" inputmode="decimal" aria-label="カスタム縮尺分母"></label>
    </div>
    <div class="ribbon-stack">
      <label>SVG回転 <select id="pdf-overlay-drawing-rotation" class="form-control"><option value="0" selected>0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>
      <label>符号方向 <select id="pdf-overlay-tag-orientation" class="form-control"><option value="follow-drawing">図面に追従</option><option value="follow-member" selected>部材線に追従</option><option value="keep-screen-down">画面下へ補正</option></select></label>
    </div>`,
  ),
].join('');

const ANNOTATION_TAB = [
  group('タグ', `${windowCommand('tagPlacement')}${windowCommand('tagFamily')}`),
  group('レビュー・メモ', `${windowCommand('selection')}${windowCommand('memo')}`),
].join('');

const REFERENCE_TAB = [
  group(
    '参照DXF',
    `${fileCommand({ id: 'pdf-overlay-dxf-file', icon: 'add', label: 'DXF追加', title: '参照DXFを追加します（複数選択可）', accept: '.dxf,application/dxf', multiple: true })}
    ${command({ id: 'pdf-overlay-dxf-clear', icon: 'clear', label: '全解除', disabled: true })}
    ${windowCommand('dxf')}
    <div class="ribbon-stack">
      <span id="pdf-overlay-dxf-file-status" class="pdf-overlay-file-status" title="選択したDXFファイル">未選択</span>
      <label>単位 <select id="pdf-overlay-dxf-unit" class="form-control"><option value="" selected>自動（未定義はmm）</option><option value="mm">mm</option><option value="cm">cm</option><option value="m">m</option></select></label>
    </div>
    <div class="ribbon-stack">
      <label>X(mm) <input id="pdf-overlay-dxf-offset-x" class="form-control" type="number" value="0" step="any"></label>
      <label>Y(mm) <input id="pdf-overlay-dxf-offset-y" class="form-control" type="number" value="0" step="any"></label>
    </div>
    <div class="ribbon-stack"><label>回転 <input id="pdf-overlay-dxf-rotation" class="form-control" type="number" value="0" step="any">°</label></div>`,
  ),
  group(
    'PDF重ね（オプション）',
    `${fileCommand({ id: 'pdf-overlay-file', icon: 'pdf', label: 'PDF読込', title: '重ね合わせるPDFを読み込みます', accept: 'application/pdf,.pdf' })}
    <div class="ribbon-stack">
      <label>頁 <input id="pdf-overlay-page" class="form-control" type="number" min="1" value="1"></label>
      <label>PDF回転 <select id="pdf-overlay-rotation" class="form-control"><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>
    </div>
    <div class="ribbon-stack"><label>SVG濃さ <input id="pdf-overlay-opacity" type="range" min="0" max="1" step="0.05" value="0.85"></label></div>
    ${windowCommand('placement')}`,
  ),
].join('');

const OUTPUT_TAB = [
  group(
    '図面書き出し',
    `${command({ id: 'pdf-overlay-export-dxf', icon: 'dxf', label: 'DXF保存', title: '現在のSVG図面と同じDrawingRenderPlanからDXFを保存します。PDFは不要です。', disabled: true })}
  ${command({ id: 'pdf-overlay-export-pdf', icon: 'pdf', label: 'PDF保存', title: 'PDFを読み込むと、注記付きPDFを別名保存できます', disabled: true })}`,
  ),
  group('保存・差替え', `${windowCommand('project')}${windowCommand('diagnostics')}`),
].join('');

const TABS = Object.freeze([
  { id: 'home', label: 'ホーム', body: HOME_TAB },
  { id: 'annotation', label: 'タグ・レビュー', body: ANNOTATION_TAB },
  { id: 'reference', label: '参照・重ね', body: REFERENCE_TAB },
  { id: 'output', label: '出力', body: OUTPUT_TAB },
]);

export function buildPdfOverlayRibbonMarkup() {
  const { tabList, bodies } = ribbonTabsHtml('pdf-overlay', TABS);
  return `
    <div class="ribbon" role="region" aria-label="簡易CADリボン">
      <div class="ribbon-tabbar">
        <strong class="workspace-view-title">📐 簡易CAD</strong>
        ${tabList}
        <div class="ribbon-status">
          <label>モデル <select id="pdf-overlay-model" class="form-control"><option>A</option><option>B</option></select></label>
          <label>階 <select id="pdf-overlay-story" class="form-control"></select></label>
          <span id="pdf-overlay-status" class="workspace-view-status">未読込</span>
          <button type="button" id="pdf-overlay-close" class="ribbon-iconbtn workspace-view-close" title="閉じる" aria-label="簡易CADビューを閉じる">✕</button>
        </div>
      </div>
      ${bodies}
    </div>`;
}

/** タブ切替のみ。詳細ウィンドウの開閉は floatingWindowManager が管理する。 */
export function wirePdfOverlayRibbon(root) {
  wireRibbonTabs(root);
}
