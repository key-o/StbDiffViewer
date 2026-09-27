/** @fileoverview PDF図面照合パネルのDOM markup. */
import { make } from './pdfOverlayPanelHelpers.js';
import { buildPdfOverlayReviewSidebarMarkup } from './PdfOverlayReviewSidebarMarkup.js';

export function buildPdfOverlayPanelMarkup(windowId) {
  const root = make('section', {
    id: windowId,
    class: 'workspace-view',
    'aria-hidden': 'true',
  });
  root.innerHTML = `
    <header class="workspace-view-header">
      <div class="workspace-view-heading">
        <strong class="workspace-view-title">📑 STB / PDF図面</strong>
        <span id="pdf-overlay-status" class="workspace-view-status">未読込</span>
      </div>
      <button type="button" id="pdf-overlay-close" class="btn btn-secondary btn-sm" aria-label="PDF図面ビューを閉じる">✕</button>
    </header>
    <div class="workspace-toolbar">
      <label>表示 <select id="pdf-overlay-display-mode" class="form-control"><option value="stb" selected>STB単独</option><option value="pdf">PDF照合</option></select></label>
      <label>PDF <input id="pdf-overlay-file" class="form-control workspace-file-control" type="file" accept="application/pdf,.pdf"></label>
      <button type="button" id="pdf-overlay-export-pdf" class="btn btn-secondary btn-sm" title="PDFを読み込むと、注記付きPDFを別名保存できます" disabled>PDF保存</button>
      <label>モデル <select id="pdf-overlay-model" class="form-control"><option>A</option><option>B</option></select></label>
      <label>階 <select id="pdf-overlay-story" class="form-control"></select></label>
      <button type="button" id="pdf-overlay-build-btn" class="btn btn-primary btn-sm">STB図面を生成</button>
      <label>用紙 <strong>A3横</strong></label>
      <span class="help-text m-0">PDF未読込時はA3表示</span>
      <label>縮尺 <select id="pdf-overlay-scale" class="form-control"><option value="50">1/50</option><option value="100">1/100</option><option value="150">1/150</option><option value="200" selected>1/200</option><option value="300">1/300</option><option value="custom">カスタム</option></select></label>
      <label id="pdf-overlay-custom-scale-wrap" class="pdf-overlay-custom-scale" hidden>1/<input id="pdf-overlay-custom-scale" class="form-control" type="number" min="1" step="any" value="250" inputmode="decimal" aria-label="カスタム縮尺分母"></label>
      <label>頁 <input id="pdf-overlay-page" class="form-control" type="number" min="1" value="1"></label>
      <label>回転 <select id="pdf-overlay-rotation" class="form-control"><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>
      <span class="pdf-overlay-zoom-readout" title="PDF読込時はマウスホイールでカーソル位置を中心に拡大縮小、右ボタンを押したままドラッグでPDF+STB表示を移動できます。PDF未読込時のA3表示もホイール拡大縮小に対応します">表示倍率 <output id="pdf-overlay-zoom-value">100%</output></span>
      <label>STB濃さ <input id="pdf-overlay-opacity" type="range" min="0" max="1" step="0.05" value="0.85"></label>
      <label><input id="pdf-overlay-labels" type="checkbox" checked>符号</label>
    </div>
    <div id="pdf-overlay-feature-prerequisites" class="workspace-result" role="status" aria-live="polite">PDF未読込：PDF保存・領域選択・自由メモ配置・セッションJSON書き出し・PDF基準点取得・寸法測定にはPDFの読み込みが必要です。STB図面と部材メモはA3表示でも利用できます。</div>
    <div class="workspace-body">
      <aside class="workspace-sidebar">
        <h3>PDF領域と階の対応</h3>
        <fieldset><legend>図面領域</legend>
          <div class="workspace-actions"><button id="pdf-overlay-select-region" type="button" class="btn btn-secondary btn-sm" disabled>PDF上で領域を選択</button><button id="pdf-overlay-map-region" type="button" class="btn btn-secondary btn-sm" disabled>選択領域を現在の階へ対応付け</button></div>
          <div class="workspace-actions"><button id="pdf-overlay-clear-region" type="button" class="btn btn-secondary btn-sm" disabled>領域・対応を解除</button></div>
          <div id="pdf-overlay-region-status" class="workspace-result">領域未選択</div>
          <p class="help-text">PDFを読み込んでから領域をドラッグして選び、モデルと階を選んで対応付けます。対応が有効な間はSTB図面をこの領域内に切り抜きます。</p>
        </fieldset>
        <h3>STB配置</h3>
        <fieldset><legend>標準配置（縮尺 + 移動）</legend>
          <label><input id="pdf-overlay-gizmo-enabled" type="checkbox" checked>ギズモ表示</label>
          <label>起点候補 <select id="pdf-overlay-gizmo-candidate-type" class="form-control"><option value="all">すべて</option><option value="grid">通り芯交点</option><option value="node">節点（ON_GRID節点を含む）</option><option value="vertex">部材輪郭交点</option><option value="center">部材中心</option></select></label>
          <div class="workspace-actions"><button id="pdf-overlay-gizmo-pick-origin" type="button" class="btn btn-secondary btn-sm" disabled>STB上から起点選択</button><button id="pdf-overlay-gizmo-reset" type="button" class="btn btn-secondary btn-sm">移動リセット</button></div>
          <div id="pdf-overlay-gizmo-origin-info" class="workspace-result">自動: 図面中央付近の通り交点</div>
          <p class="help-text">縮尺は上部ツールバーで指定します。ON_GRID節点と通り芯交点は別候補です。赤=X方向、緑=Y方向、中央をドラッグするとXY移動します。この配置は照合セッションに保存できます。</p>
        </fieldset>
        <details class="pdf-overlay-advanced-alignment">
          <summary>詳細位置合わせ（A/B/C） <span class="pdf-overlay-option-tag">オプション</span></summary>
          <div class="pdf-overlay-advanced-alignment-body">
            <p class="help-text">通常は縮尺と移動ギズモで調整します。必要な場合のみ、A/Bで平行移動・回転・均一縮尺を決定し、Cを独立確認点として使用します。STBはmm、PDFは未回転ページのuser-space単位です。PDF上の取得にはPDF、STB候補点の取得にはPDFとSTB図面が必要です。</p>
            ${['a', 'b', 'c'].map((k) => `<fieldset><legend>${k.toUpperCase()}点</legend><div class="pdf-overlay-grid4"><label>STB X (mm)<input id="pdf-overlay-${k}-mx" class="form-control" type="number" value="0"></label><label>STB Y (mm)<input id="pdf-overlay-${k}-my" class="form-control" type="number" value="0"></label><label>PDF X (user-space)<input id="pdf-overlay-${k}-px" class="form-control" type="number" value="0" step="any"></label><label>PDF Y (user-space)<input id="pdf-overlay-${k}-py" class="form-control" type="number" value="0" step="any"></label></div><div class="workspace-actions"><button id="pdf-overlay-pick-${k}" type="button" class="btn btn-secondary btn-sm" disabled>PDF上から${k.toUpperCase()}を取得</button><button id="pdf-overlay-pick-model-${k}" type="button" class="btn btn-secondary btn-sm" disabled>STB候補点から${k.toUpperCase()}を取得</button></div></fieldset>`).join('')}
            <div class="workspace-actions"><button id="pdf-overlay-solve-btn" type="button" class="btn btn-primary btn-sm">A/Bで位置合わせ</button><button id="pdf-overlay-clear-registration-btn" type="button" class="btn btn-secondary btn-sm">解除</button></div>
          </div>
        </details>
        ${buildPdfOverlayReviewSidebarMarkup()}
      </aside>
      <main class="workspace-main">
        <div id="pdf-overlay-drop-overlay" class="pdf-overlay-drop-overlay" aria-hidden="true">
          <strong>PDFをここにドロップ</strong>
          <span>クリック選択と同じPDF読込を実行します</span>
        </div>
        <div id="pdf-overlay-scroll" class="pdf-overlay-scroll">
          <div id="pdf-overlay-stage" class="pdf-overlay-stage">
            <div id="pdf-overlay-canvas-layer" class="pdf-overlay-layer"></div>
            <div id="pdf-overlay-svg-layer" class="pdf-overlay-layer pdf-overlay-svg-layer"></div>
            <div id="pdf-overlay-region-selection-box" class="pdf-overlay-region-selection-box" aria-hidden="true"></div>
          </div>
        </div>
      </main>
    </div>`;
  document.body.append(root);
  return root;
}
