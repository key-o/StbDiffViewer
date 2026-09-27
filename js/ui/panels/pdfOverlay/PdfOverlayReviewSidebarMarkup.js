/** @fileoverview PDF図面照合パネルのレビュー・セッション用サイドバー markup. */
import { getPdfJsRuntimeInfo } from '../../../parser/pdf/pdfJsRuntime.js';

export function buildPdfOverlayReviewSidebarMarkup() {
  return `
        <div id="pdf-overlay-registration-result" class="workspace-result">未設定</div>
        <h3>選択部材</h3><div id="pdf-overlay-element-info" class="workspace-result">未選択</div>
        <fieldset><legend>部材ごとの照合状態・メモ</legend>
          <label>確認状態 <select id="pdf-overlay-review-state" class="form-control"><option value="unreviewed">未確認</option><option value="confirmed">確認済み</option><option value="mismatch">不一致</option></select></label>
          <label>部材メモ <textarea id="pdf-overlay-member-memo" class="form-control" rows="3" maxlength="2000" placeholder="選択中の部材に結び付くメモ"></textarea></label>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-save-member-review" class="btn btn-secondary btn-sm" disabled>状態とメモを保存</button></div>
          <p class="help-text">部材メモと「未確認」はPDFなしでも保存できます。「確認済み」「不一致」の保存には、PDFの読み込み、領域の階への対応付け、STB図面の配置が必要です。</p>
          <div id="pdf-overlay-member-review-status" class="workspace-result">部材を選択してください。</div>
        </fieldset>
        <fieldset><legend>照合セッションJSON</legend>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-export-session" class="btn btn-secondary btn-sm" disabled>JSONを書き出す</button><button type="button" id="pdf-overlay-import-session-trigger" class="btn btn-secondary btn-sm">JSONを読み込む</button></div>
          <input id="pdf-overlay-import-session" type="file" accept="application/json,.json" hidden>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-restore-session" class="btn btn-secondary btn-sm" disabled>現在の条件で復元を再評価</button></div>
          <p class="help-text">PDFページを読み込むとJSONを書き出せます。JSONの読み込みはPDF未読込でも行えます。</p>
          <div id="pdf-overlay-session-status" class="workspace-result">セッション未保存</div>
        </fieldset>
        <fieldset><legend>図面上の自由メモ</legend>
          <label>メモ <textarea id="pdf-overlay-drawing-memo" class="form-control" rows="2" maxlength="2000" placeholder="部材には結び付かない図面メモ"></textarea></label>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-add-drawing-memo" class="btn btn-secondary btn-sm" disabled>PDF上に配置</button><button type="button" id="pdf-overlay-cancel-drawing-memo" class="btn btn-secondary btn-sm" disabled>配置を取消</button></div>
          <p class="help-text">自由メモはPDFページ上に配置します。PDFを読み込んでから利用できます。</p>
          <ol id="pdf-overlay-drawing-memo-list" class="pdf-overlay-memo-list"></ol>
        </fieldset>
        <div id="pdf-overlay-diagnostics" class="pdf-overlay-diagnostics"></div>
        <p class="help-text text-xs">PDF.js ${getPdfJsRuntimeInfo().version} / ローカル固定配布</p>
  `;
}
