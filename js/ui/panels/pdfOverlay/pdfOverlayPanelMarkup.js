/** @fileoverview 簡易CADワークスペースのDOM markup。ツールは上部リボン、補助機能は項目別のフローティングウィンドウへ置き、PDF重ねは補助機能として扱う。 */
import { make } from './pdfOverlayPanelHelpers.js';
import {
  PDF_OVERLAY_FLOAT_WINDOWS,
  buildPdfOverlayRibbonMarkup,
  wirePdfOverlayRibbon,
} from './pdfOverlayRibbonMarkup.js';
import { buildPdfOverlayReviewSections } from './PdfOverlayReviewSidebarMarkup.js';

export function buildPdfOverlayPanelMarkup(windowId) {
  const root = make('section', {
    id: windowId,
    class: 'workspace-view',
    'aria-hidden': 'true',
  });
  root.innerHTML = `
    <div class="workspace-shell">
    ${buildPdfOverlayRibbonMarkup()}
    <div id="pdf-overlay-feature-prerequisites" class="workspace-result" role="status" aria-live="polite" title="SVG図面を生成すると部材レビュー・自由メモ・DXF保存をPDFなしで利用できます。PDF保存・領域選択・PDF照合セッションJSON書き出し・PDF基準点取得にはPDFの読み込みが必要です。">PDF未読込：SVG図面を生成するとレビュー・自由メモを利用できます</div>
    <div class="workspace-body">
      <main class="workspace-main">
        <div id="pdf-overlay-drop-overlay" class="pdf-overlay-drop-overlay" aria-hidden="true">
          <strong>PDF / DXFをここにドロップ</strong>
          <span>PDF重ね、または参照DXFとして読み込みます</span>
        </div>
        <div id="pdf-overlay-scroll" class="pdf-overlay-scroll">
          <div id="pdf-overlay-stage" class="pdf-overlay-stage">
            <div id="pdf-overlay-canvas-layer" class="pdf-overlay-layer"></div>
            <div id="pdf-overlay-svg-layer" class="pdf-overlay-layer pdf-overlay-svg-layer"></div>
            <div id="pdf-overlay-region-selection-box" class="pdf-overlay-region-selection-box" aria-hidden="true"></div>
          </div>
        </div>
      </main>
    </div>
    </div>
    <section id="pdf-overlay-tag-family-editor" class="tag-family-editor" hidden aria-hidden="true" aria-label="タグタイプ レイアウトエディタ">
      <header class="tag-family-editor-header">
        <div>
          <strong id="pdf-overlay-tag-family-editor-title">タグタイプ レイアウトエディタ</strong>
          <span id="pdf-overlay-tag-family-editor-subtitle"></span>
        </div>
        <button type="button" id="pdf-overlay-tag-family-editor-close" class="btn btn-secondary btn-sm" aria-label="タグタイプ編集を閉じる">✕</button>
      </header>
      <div class="tag-family-editor-body">
        <aside class="tag-family-editor-column tag-family-editor-left">
          <h4>パラメータ</h4>
          <label>候補 <select id="pdf-overlay-tag-family-editor-parameter-preset" class="form-control"></select></label>
          <label>STB XPath <input id="pdf-overlay-tag-family-editor-parameter-key" class="form-control" type="text" spellcheck="false" autocomplete="off" placeholder="例: StbSecColumn_RC/@name"></label>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-tag-family-editor-add-parameter" class="btn btn-secondary btn-sm">パラメータ追加</button></div>
          <ol id="pdf-overlay-tag-family-editor-parameter-list" class="tag-family-editor-list"></ol>
          <div id="pdf-overlay-tag-family-editor-parameter-properties" class="tag-family-editor-parameter-properties"></div>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-tag-family-editor-apply-parameter" class="btn btn-secondary btn-sm" disabled>パラメータ設定を適用</button></div>
          <h4>図形要素</h4>
          <label>種類 <select id="pdf-overlay-tag-family-editor-primitive-kind" class="form-control">
            <option value="parameter-text">パラメータ文字</option>
            <option value="text">固定文字</option>
            <option value="line">線</option>
            <option value="separator">区切り線</option>
            <option value="rectangle">矩形</option>
            <option value="rounded-rectangle">角丸矩形</option>
            <option value="circle">円</option>
            <option value="circled-value">丸囲み値</option>
            <option value="leader-anchor">引出線アンカー</option>
            <option value="section-figure">断面図(豆図)</option>
          </select></label>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-tag-family-editor-add-primitive" class="btn btn-secondary btn-sm">要素追加</button></div>
          <ol id="pdf-overlay-tag-family-editor-primitive-list" class="tag-family-editor-list"></ol>
        </aside>
        <section class="tag-family-editor-preview-column">
          <div class="tag-family-editor-preview-toolbar" role="toolbar" aria-label="タグプレビュー操作">
            <button type="button" id="pdf-overlay-tag-family-editor-tool-select" class="btn btn-primary btn-sm" aria-pressed="true">選択・移動</button>
            <button type="button" id="pdf-overlay-tag-family-editor-tool-line" class="btn btn-secondary btn-sm" aria-pressed="false">線を描く</button>
            <label class="tag-family-editor-snap-toggle"><input id="pdf-overlay-tag-family-editor-snap-orthogonal" type="checkbox" checked> 水平・垂直</label>
            <label class="tag-family-editor-snap-toggle"><input id="pdf-overlay-tag-family-editor-snap-endpoint" type="checkbox" checked> 端点</label>
            <label class="tag-family-editor-snap-toggle"><input id="pdf-overlay-tag-family-editor-snap-geometry" type="checkbox" checked> 交点・中点</label>
            <label class="tag-family-editor-snap-toggle"><input id="pdf-overlay-tag-family-editor-snap-shape" type="checkbox" checked> 図形点</label>
            <span>線本体は平行移動、端点ハンドルは個別移動。矩形角点・図形中心・アンカーにもスナップ。Shiftで直交を強制。</span>
          </div>
          <div class="tag-family-editor-canvas-wrap">
            <svg id="pdf-overlay-tag-family-editor-preview" class="tag-family-editor-preview" viewBox="0 0 480 320" role="img" aria-label="タグプレビュー"></svg>
          </div>
          <div id="pdf-overlay-tag-family-editor-preview-status" class="workspace-result">プレビュー</div>
        </section>
        <aside class="tag-family-editor-column tag-family-editor-right">
          <h4>選択要素のプロパティ</h4>
          <div id="pdf-overlay-tag-family-editor-properties" class="tag-family-editor-properties">図形要素を選択してください。</div>
          <div class="workspace-actions">
            <button type="button" id="pdf-overlay-tag-family-editor-apply-primitive" class="btn btn-secondary btn-sm" disabled>プロパティ適用</button>
            <button type="button" id="pdf-overlay-tag-family-editor-remove-primitive" class="btn btn-secondary btn-sm" disabled>要素削除</button>
          </div>
        </aside>
      </div>
      <footer class="tag-family-editor-footer">
        <div id="pdf-overlay-tag-family-editor-status" class="workspace-result">未編集</div>
        <div class="workspace-actions">
          <button type="button" id="pdf-overlay-tag-family-editor-save" class="btn btn-primary btn-sm">レイアウトを保存</button>
          <button type="button" id="pdf-overlay-tag-family-editor-cancel" class="btn btn-secondary btn-sm">キャンセル</button>
        </div>
      </footer>
    </section>`;
  root.insertAdjacentHTML('beforeend', buildFloatWindows());
  wirePdfOverlayRibbon(root);
  document.body.append(root);
  return root;
}

/** 詳細機能の markup。項目ごとに独立したフローティングウィンドウへ収める。 */
function buildFloatWindows() {
  const review = buildPdfOverlayReviewSections();
  const bodies = {
    dxf: `<section class="pdf-overlay-dxf-reference-manager">
      <div id="pdf-overlay-dxf-reference-status" class="workspace-result">DXF未読込</div>
      <div id="pdf-overlay-dxf-reference-list" class="pdf-overlay-dxf-reference-list"></div>
    </section>`,
    placement: `${review.registration}
    <div class="pdf-overlay-pdf-subfeature">
    <h3>PDF領域と階の対応</h3>
    <fieldset><legend title="PDFを読み込んでから領域をドラッグして選び、モデルと階を選んで対応付けます。対応が有効な間は簡易CADをこの領域内に切り抜きます。">図面領域 <span class="workspace-tip" aria-hidden="true">ⓘ</span></legend>
      <div class="workspace-actions"><button id="pdf-overlay-select-region" type="button" class="btn btn-secondary btn-sm" disabled>PDF上で領域を選択</button><button id="pdf-overlay-map-region" type="button" class="btn btn-secondary btn-sm" disabled>選択領域を現在の階へ対応付け</button></div>
      <div class="workspace-actions"><button id="pdf-overlay-clear-region" type="button" class="btn btn-secondary btn-sm" disabled>領域・対応を解除</button></div>
      <div id="pdf-overlay-region-status" class="workspace-result">領域未選択</div>
    </fieldset>
    <h3>SVG配置</h3>
    <fieldset><legend title="縮尺とSVG回転は上部ツールバーで指定します。ON_GRID節点と通り芯交点は別候補です。赤=X方向、緑=Y方向、中央をドラッグするとXY移動します。この配置は照合セッションに保存できます。">標準配置（縮尺 + 移動） <span class="workspace-tip" aria-hidden="true">ⓘ</span></legend>
      <label><input id="pdf-overlay-gizmo-enabled" type="checkbox" checked>ギズモ表示</label>
      <label>起点候補 <select id="pdf-overlay-gizmo-candidate-type" class="form-control"><option value="all">すべて</option><option value="grid">通り芯交点</option><option value="node">節点（ON_GRID節点を含む）</option><option value="vertex">部材輪郭交点</option><option value="center">部材中心</option></select></label>
      <div class="workspace-actions"><button id="pdf-overlay-gizmo-pick-origin" type="button" class="btn btn-secondary btn-sm" disabled>SVG上から起点選択</button><button id="pdf-overlay-gizmo-reset" type="button" class="btn btn-secondary btn-sm">移動リセット</button></div>
      <div id="pdf-overlay-gizmo-origin-info" class="workspace-result">自動: 図面中央付近の通り交点</div>
    </fieldset>
    <details class="pdf-overlay-advanced-alignment">
      <summary title="通常は縮尺・SVG回転・移動ギズモで調整します。必要な場合のみ、A/Bで平行移動・回転・均一縮尺を決定し、Cを独立確認点として使用します。STBはmm、PDFは未回転ページのuser-space単位です。PDF上の取得にはPDF、STB候補点の取得にはPDFとSVG図面が必要です。">詳細位置合わせ（A/B/C） <span class="pdf-overlay-option-tag">オプション</span></summary>
      <div class="pdf-overlay-advanced-alignment-body">
        ${['a', 'b', 'c'].map((k) => `<fieldset><legend>${k.toUpperCase()}点</legend><div class="pdf-overlay-grid4"><label>STB X (mm)<input id="pdf-overlay-${k}-mx" class="form-control" type="number" value="0"></label><label>STB Y (mm)<input id="pdf-overlay-${k}-my" class="form-control" type="number" value="0"></label><label>PDF X (user-space)<input id="pdf-overlay-${k}-px" class="form-control" type="number" value="0" step="any"></label><label>PDF Y (user-space)<input id="pdf-overlay-${k}-py" class="form-control" type="number" value="0" step="any"></label></div><div class="workspace-actions"><button id="pdf-overlay-pick-${k}" type="button" class="btn btn-secondary btn-sm" disabled>PDF上から${k.toUpperCase()}を取得</button><button id="pdf-overlay-pick-model-${k}" type="button" class="btn btn-secondary btn-sm" disabled>SVG候補点から${k.toUpperCase()}を取得</button></div></fieldset>`).join('')}
        <div class="workspace-actions"><button id="pdf-overlay-solve-btn" type="button" class="btn btn-primary btn-sm">A/Bで位置合わせ</button><button id="pdf-overlay-clear-registration-btn" type="button" class="btn btn-secondary btn-sm">解除</button></div>
      </div>
    </details>
    </div>`,
    selection: review.selection,
    tagPlacement: review.tagPlacement,
    tagFamily: review.tagFamily,
    memo: review.memo,
    project: review.project,
    diagnostics: review.diagnostics,
  };
  return PDF_OVERLAY_FLOAT_WINDOWS.map((def, index) => {
    const offset = 24 * index;
    return `<div id="${def.windowId}" class="floating-window cad-float-window" style="left:${96 + offset}px;top:${150 + offset}px" role="dialog" aria-label="${def.title}">
      <div id="${def.headerId}" class="float-window-header"><span class="float-window-title">${def.title}</span><div class="float-window-controls"><button type="button" id="${def.closeButtonId}" class="float-window-btn" aria-label="${def.title}を閉じる">✕</button></div></div>
      <div class="float-window-content workspace-sidebar cad-float-content">${bodies[def.key]}</div>
    </div>`;
  }).join('');
}
