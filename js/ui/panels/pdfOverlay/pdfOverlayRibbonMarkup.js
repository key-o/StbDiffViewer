/**
 * @fileoverview 簡易CADワークスペースの上部リボン markup、タブ切替、詳細ウィンドウの定義。
 * 既存の `pdf-overlay-*` ID は PdfOverlayPanel が参照するため、DOM の置き場所だけを変える。
 */

import {
  ribbonCommandHtml,
  ribbonIcon,
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
const BUILTIN_FLOAT_WINDOWS = [
  {
    key: 'dxf',
    icon: 'dxfLayers',
    title: '参照DXF一覧',
    label: 'DXF一覧',
    tip: '読み込んだ参照DXFの表示切替・解除を行います',
  },
  {
    key: 'placement',
    icon: 'region',
    title: 'PDF領域・配置',
    label: '領域・配置',
    tip: 'PDF領域・配置、A/B/C位置合わせと照合セッションJSON',
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
    tip: '開いている間はタグ編集モード。向きと引出線を設定',
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
    key: 'pdfExportSettings',
    icon: 'pdf',
    title: 'PDF詳細設定',
    label: 'PDF設定',
    tip: 'PDF出力品質・フォント・印刷線の設定',
    body: () => `<div class="cad-pdf-export-settings-panel">
      <label>出力品質
        <select id="pdf-overlay-export-mode" class="form-control">
          <option value="vector" selected>ベクター（推奨）</option>
          <option value="raster">ラスタ（互換）</option>
        </select>
      </label>
      <label>日本語TTF（任意）
        <input id="pdf-overlay-vector-font" type="file" class="form-control" accept=".ttf,font/ttf" aria-label="PDF埋め込み用日本語TrueTypeフォント（任意）" />
      </label>
      <p class="cad-pdf-export-font-note">日本語文字をPDFへ埋め込む場合は、埋め込みが許諾された静的TrueTypeフォントを指定してください。</p>
      <label>印刷線幅
        <select id="pdf-overlay-print-line-width" class="form-control">
          <option value="thin" selected>細線（推奨）</option>
          <option value="svg">元の線幅</option>
          <option value="fine">極細</option>
          <option value="legacy">従来（太線）</option>
        </select>
      </label>
      <label>印刷線種
        <select id="pdf-overlay-print-line-pattern" class="form-control">
          <option value="svg" selected>元の線種（破線維持）</option>
          <option value="solid">すべて実線</option>
        </select>
      </label>
    </div>`,
  },
  {
    key: 'project',
    icon: 'project',
    title: '図面プロジェクト',
    label: 'プロジェクト',
    tip: 'DrawingProject JSON・STB改訂差替え・PDF照合セッション',
  },
  { key: 'diagnostics', icon: 'diag', title: '診断', label: '診断', tip: 'DXF・描画の診断結果' },
];

/** 組込みウィンドウのリボン配置（タブ・グループ）。 */
const BUILTIN_RIBBON = Object.freeze({
  dxf: { tab: 'reference', group: '参照DXF' },
  placement: { tab: 'reference', group: 'PDF重ね（オプション）' },
  selection: { tab: 'annotation', group: 'レビュー・メモ' },
  tagPlacement: { tab: 'annotation', group: 'タグ' },
  tagFamily: { tab: 'annotation', group: 'タグ' },
  memo: { tab: 'annotation', group: 'レビュー・メモ' },
  pdfExportSettings: { tab: 'output', group: 'PDF詳細設定' },
  project: { tab: 'output', group: '保存・差替え' },
  diagnostics: { tab: 'output', group: '保存・差替え' },
});

function normalizeFloatWindow(def) {
  return {
    ...def,
    ribbon: def.ribbon ?? BUILTIN_RIBBON[def.key],
    windowId: `pdf-overlay-win-${def.key}`,
    toggleButtonId: `pdf-overlay-open-${def.key}`,
    closeButtonId: `pdf-overlay-win-${def.key}-close`,
    headerId: `pdf-overlay-win-${def.key}-header`,
  };
}

/**
 * 詳細ウィンドウの登録簿。ウィンドウ本体・リボンのボタン・開閉登録の3点が必ずこの1定義から生成される。
 * 組込み定義のあと、registerCadFloatWindow で追加した定義が続く（#559）。
 */
export const PDF_OVERLAY_FLOAT_WINDOWS = BUILTIN_FLOAT_WINDOWS.map(normalizeFloatWindow);

/**
 * 簡易CADのフローティングウィンドウとリボンボタンを追加登録する。buildPdfOverlayPanelMarkup より前に呼ぶ。
 * @param {{key:string, icon:string, title:string, label:string, tip:string,
 *   ribbon:{tab:'home'|'edit'|'annotation'|'reference'|'output', group:string}, body:() => string}} def
 *   body は ウィンドウ内 HTML を返す。既存ID・イベント配線は呼び出し側が持つ。
 */
export function registerCadFloatWindow(def) {
  const missing = ['key', 'icon', 'title', 'label', 'tip'].filter(
    (name) => typeof def?.[name] !== 'string' || !def[name].trim(),
  );
  if (missing.length)
    throw new TypeError(`フローティングウィンドウ定義が不正です: ${missing.join(', ')}`);
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(def.key))
    throw new TypeError('フローティングウィンドウのkeyは英数字で指定してください。');
  if (!TAB_IDS.includes(def.ribbon?.tab) || !String(def.ribbon?.group || '').trim())
    throw new TypeError('リボンのタブとグループを指定してください。');
  if (typeof def.body !== 'function') throw new TypeError('ウィンドウ本体のbody関数が必要です。');
  if (PDF_OVERLAY_FLOAT_WINDOWS.some((entry) => entry.key === def.key))
    throw new Error(`フローティングウィンドウ ${def.key} は登録済みです。`);
  const entry = normalizeFloatWindow(def);
  PDF_OVERLAY_FLOAT_WINDOWS.push(entry);
  return entry;
}

/** ウィンドウを持たない単発コマンド（既存パネルの起動など）の登録簿。 */
export const PDF_OVERLAY_RIBBON_ACTIONS = [];

/**
 * リボンへ単発コマンドを追加登録する。buildPdfOverlayPanelMarkup より前に呼ぶ。
 * @param {{key:string, icon:string, label:string, tip:string,
 *   ribbon:{tab:'home'|'edit'|'annotation'|'reference'|'output', group:string}, run:() => void}} def
 */
export function registerCadRibbonAction(def) {
  const missing = ['key', 'icon', 'label', 'tip'].filter(
    (name) => typeof def?.[name] !== 'string' || !def[name].trim(),
  );
  if (missing.length) throw new TypeError(`リボンコマンド定義が不正です: ${missing.join(', ')}`);
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(def.key))
    throw new TypeError('リボンコマンドのkeyは英数字で指定してください。');
  if (!TAB_IDS.includes(def.ribbon?.tab) || !String(def.ribbon?.group || '').trim())
    throw new TypeError('リボンのタブとグループを指定してください。');
  if (typeof def.run !== 'function') throw new TypeError('実行するrun関数が必要です。');
  if (PDF_OVERLAY_RIBBON_ACTIONS.some((entry) => entry.key === def.key))
    throw new Error(`リボンコマンド ${def.key} は登録済みです。`);
  const entry = { ...def, buttonId: `pdf-overlay-action-${def.key}` };
  PDF_OVERLAY_RIBBON_ACTIONS.push(entry);
  return entry;
}

function actionCommand(def) {
  return ribbonCommandHtml({ id: def.buttonId, icon: def.icon, label: def.label, title: def.tip });
}

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

const TAB_IDS = Object.freeze(['home', 'edit', 'annotation', 'reference', 'output']);

/** 指定タブ・グループに登録されたウィンドウ・単発コマンドのリボンコマンド列。 */
function windowCommands(tab, groupLabel) {
  const inGroup = (def) => def.ribbon?.tab === tab && def.ribbon.group === groupLabel;
  return [
    ...PDF_OVERLAY_FLOAT_WINDOWS.filter(inGroup).map((def) => windowCommand(def.key)),
    ...PDF_OVERLAY_RIBBON_ACTIONS.filter(inGroup).map(actionCommand),
  ].join('');
}

/** 組込みグループに無いグループへ登録されたウィンドウは、タブ末尾の新しいグループになる。 */
function extraGroups(tab, knownLabels) {
  const labels = [];
  for (const def of [...PDF_OVERLAY_FLOAT_WINDOWS, ...PDF_OVERLAY_RIBBON_ACTIONS]) {
    if (def.ribbon?.tab !== tab || knownLabels.includes(def.ribbon.group)) continue;
    if (!labels.includes(def.ribbon.group)) labels.push(def.ribbon.group);
  }
  return labels.map((label) => group(label, windowCommands(tab, label))).join('');
}

const HOME_TAB = () =>
  [
    group(
      '表示',
      `<div class="ribbon-stack">
      <label>表示 <select id="pdf-overlay-display-mode" class="form-control"><option value="stb" selected>図面</option><option value="pdf">PDF重ね</option></select></label>
      <span class="pdf-overlay-zoom-readout" title="マウスホイールで選択部材の中心を基準に拡大縮小します。未選択時はカーソル位置が基準です。Escで選択解除、右ドラッグで表示移動。PDF未読込時のA3図面でも利用できます">表示倍率 <output id="pdf-overlay-zoom-value">100%</output></span>
    </div>`,
    ),
    group(
      '図面操作',
      `<button id="pdf-overlay-build-btn" type="button" hidden aria-hidden="true"></button>
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
      <label>図面回転 <select id="pdf-overlay-drawing-rotation" class="form-control"><option value="0" selected>0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>
      <label>符号方向 <select id="pdf-overlay-tag-orientation" class="form-control"><option value="follow-drawing">図面に追従</option><option value="follow-member" selected>部材線に追従</option><option value="keep-screen-down">画面下へ補正</option></select></label>
    </div>`,
    ),
    extraGroups('home', ['表示', '図面操作', '用紙・縮尺']),
  ].join('');

/** モデルAの伏図上での部材・節点の数値移動。選択要素の詳細は要素情報パネルが表示する。 */
const EDIT_TAB = () =>
  [
    group(
      'モデル編集',
      `${command({ id: 'cad-edit-toggle', icon: 'edit', label: '編集開始', title: 'モデル編集モードを開始・終了します', attributes: 'aria-pressed="false"' })}
    <div class="ribbon-stack">
      <label>対象 <select id="cad-edit-kind" class="form-control"><option value="member">部材</option><option value="node">節点</option></select></label>
      <label title="ON: 部材の共有節点を移動。OFF: 節点を固定して部材offsetだけを変更"><input id="cad-edit-follow-nodes" type="checkbox"> 節点追従（3Dと共通）</label>
      <span id="cad-edit-status" class="ribbon-stack-status" role="status">編集モードOFF</span>
    </div>`,
    ),
    group(
      '移動',
      `<div class="ribbon-stack">
      <label><span id="cad-edit-first-axis">ΔX</span>(mm) <input id="cad-edit-dx" type="number" class="form-control" value="0" step="any"></label>
      <label><span id="cad-edit-second-axis">ΔY</span>(mm) <input id="cad-edit-dy" type="number" class="form-control" value="0" step="any"></label>
    </div>
    ${command({ id: 'cad-edit-apply', icon: 'move', label: '移動', title: '選択した部材・節点を ΔX / ΔY だけ移動します', disabled: true })}`,
    ),
    group(
      '選択プロパティ',
      `<div class="ribbon-stack">
      <span id="cad-edit-property-title" class="ribbon-stack-status" role="status">未選択</span>
      <div id="cad-edit-node-properties" class="ribbon-stack" hidden>
        <label>X(mm) <input id="cad-edit-property-x" type="number" class="form-control" step="any"></label>
        <label>Y(mm) <input id="cad-edit-property-y" type="number" class="form-control" step="any"></label>
        <label>Z(mm) <input id="cad-edit-property-z" type="number" class="form-control" step="any"></label>
        ${command({ id: 'cad-edit-position-apply', icon: 'move', label: '座標を適用', title: '選択節点を指定したモデル絶対座標へ移動', disabled: true })}
        <label>軸揃え（モデル座標） <select id="cad-edit-align-axis" class="form-control" aria-label="軸揃えの対象座標軸"><option value="X">X</option><option value="Y">Y</option></select></label>
        <label>参照座標(mm) <input id="cad-edit-align-value" type="number" class="form-control" step="any" value="0" aria-label="軸揃えの参照座標"></label>
        ${command({ id: 'cad-edit-align-apply', icon: 'alignAxis', label: '軸揃え', title: '選択節点のXまたはY座標を参照座標に揃えます。図面回転に関係なくモデル座標で処理します', disabled: true })}
      </div>
    </div>`,
    ),
    group(
      '履歴',
      `${command({ id: 'cad-edit-undo', icon: 'undo', label: '元に戻す', title: '直前のモデル編集を取り消す', disabled: true })}
      ${command({ id: 'cad-edit-redo', icon: 'redo', label: 'やり直す', title: '取り消したモデル編集を再実行', disabled: true })}`,
    ),
    group(
      'マウス編集',
      `${command({ id: 'cad-edit-pointer-move', icon: 'move', label: '2点移動', title: '選択部材の始点と終点を図面上でクリックして移動', disabled: true })}
      ${command({ id: 'cad-edit-pointer-copy', icon: 'copy', label: '2点複写', title: '選択部材を図面上の始点・終点の差分で複写', disabled: true })}
      ${command({ id: 'cad-edit-pointer-face', icon: 'alignAxis', label: '辺揃え', title: '移動元と基準側の部材外形の辺を順にクリックして面位置を揃えます', disabled: true })}
      ${command({ id: 'cad-edit-pointer-cancel', icon: 'cancel', label: '取消', title: 'マウス編集を解除', disabled: true })}
      <div class="ribbon-stack">
        <label title="現在の伏図範囲の節点・端部・中点と通り芯にモデルmm座標で吸着します"><input id="cad-edit-snap" type="checkbox" checked> スナップ</label>
        <label title="2点移動・複写の終点をモデルXまたはY軸方向に拘束します"><input id="cad-edit-ortho" type="checkbox"> Ortho（<span id="cad-edit-ortho-axes">X/Y</span>）</label>
      </div>
      <span id="cad-edit-pointer-status" class="ribbon-stack-status" role="status">部材を選択してください</span>`,
    ),
    extraGroups('edit', ['モデル編集', '移動', '選択プロパティ', 'マウス編集', '履歴']),
  ].join('');

const ANNOTATION_TAB = () =>
  [
    group('タグ', windowCommands('annotation', 'タグ')),
    group('レビュー・メモ', windowCommands('annotation', 'レビュー・メモ')),
    extraGroups('annotation', ['タグ', 'レビュー・メモ']),
  ].join('');

const REFERENCE_TAB = () =>
  [
    group(
      '参照DXF',
      `${fileCommand({ id: 'pdf-overlay-dxf-file', icon: 'dxfAdd', label: 'DXF追加', title: '参照DXFを追加します（複数選択可）', accept: '.dxf,application/dxf', multiple: true })}
    ${command({ id: 'pdf-overlay-dxf-clear', icon: 'clear', label: '全解除', disabled: true })}
    ${windowCommands('reference', '参照DXF')}
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
    <div class="ribbon-stack"><label>図面の濃さ <input id="pdf-overlay-opacity" type="range" min="0" max="1" step="0.05" value="0.85"></label></div>
    ${windowCommands('reference', 'PDF重ね（オプション）')}`,
    ),
    extraGroups('reference', ['参照DXF', 'PDF重ね（オプション）']),
  ].join('');

const OUTPUT_TAB = () =>
  [
    group('PDF詳細設定', windowCommands('output', 'PDF詳細設定')),
    group('保存・差替え', windowCommands('output', '保存・差替え')),
    extraGroups('output', ['PDF詳細設定', '保存・差替え']),
  ].join('');

export function buildPdfOverlayRibbonMarkup() {
  const tabs = [
    { id: 'home', label: 'ホーム', body: HOME_TAB() },
    { id: 'edit', label: '編集', body: EDIT_TAB() },
    { id: 'annotation', label: 'タグ・レビュー', body: ANNOTATION_TAB() },
    { id: 'reference', label: '参照・重ね', body: REFERENCE_TAB() },
    { id: 'output', label: '出力', body: OUTPUT_TAB() },
  ];
  const { tabList, bodies } = ribbonTabsHtml('pdf-overlay', tabs);
  return `
    <div class="ribbon" role="region" aria-label="簡易CADリボン">
      <div class="ribbon-tabbar">
        <strong class="workspace-view-title">📑 簡易CAD</strong>
        ${tabList}
        <div class="ribbon-status cad-global-export-actions" role="group" aria-label="図面の書き出し">
          <label class="cad-global-export-target" for="pdf-overlay-export-target">出力対象
            <select id="pdf-overlay-export-target" class="form-control" aria-label="PDF・DXF出力対象（ビューまたはシート）">
              <option value="">出力可能な図面なし</option>
            </select>
          </label>
          <button type="button" id="pdf-overlay-export-pdf" class="cad-global-export-button" title="選択したビューまたはシートをPDF保存" disabled>${ribbonIcon('print')}<span class="ribbon-cmd-label">PDF保存</span></button>
          <button type="button" id="pdf-overlay-export-dxf" class="cad-global-export-button" title="選択したビューまたはシートをDXF保存します" disabled>${ribbonIcon('dxfSave')}<span class="ribbon-cmd-label">DXF保存</span></button>
          <button type="button" id="pdf-overlay-close" class="ribbon-iconbtn workspace-view-close" title="閉じる" aria-label="簡易CADビューを閉じる">✕</button>
        </div>
      </div>
      ${bodies}
    </div>`;
}

/** タブ切替のみ。詳細ウィンドウの開閉は floatingWindowManager が管理する。 */
export function wirePdfOverlayRibbon(root) {
  wireRibbonTabs(root);
  for (const def of PDF_OVERLAY_RIBBON_ACTIONS) {
    root.querySelector(`#${def.buttonId}`)?.addEventListener('click', () => def.run());
  }
}
