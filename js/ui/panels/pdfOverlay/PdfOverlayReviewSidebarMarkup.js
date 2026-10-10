/** @fileoverview 簡易CADの詳細フローティングウィンドウ（レビュー・タグ・プロジェクト等）の項目別 markup. */
import { getPdfJsRuntimeInfo } from '../../../parser/pdf/pdfJsRuntime.js';

/** 項目別の markup を返す。各項目は個別のフローティングウィンドウになる。 */
export function buildPdfOverlayReviewSections() {
  return {
    registration: `
        <div id="pdf-overlay-registration-result" class="workspace-result">未設定</div>
    `,
    selection: `
        <h3>選択部材</h3><div id="pdf-overlay-element-info" class="workspace-result">未選択</div>
        <fieldset><legend title="部材の確認状態とメモは簡易CADに結び付き、PDFの有無に依存せず保持します。PDFは任意の重ね合わせです。">部材ごとの確認状態・メモ <span class="workspace-tip" aria-hidden="true">ⓘ</span></legend>
          <label>確認状態 <select id="pdf-overlay-review-state" class="form-control"><option value="unreviewed">未確認</option><option value="confirmed">確認済み</option><option value="mismatch">不一致</option></select></label>
          <label>部材メモ <textarea id="pdf-overlay-member-memo" class="form-control" rows="3" maxlength="2000" placeholder="選択中の部材に結び付くメモ"></textarea></label>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-save-member-review" class="btn btn-secondary btn-sm" disabled>状態とメモを保存</button></div>
          <div id="pdf-overlay-member-review-status" class="workspace-result">部材を選択してください。</div>
        </fieldset>
    `,
    tagPlacement: `
        <fieldset><legend title="通常選択とタグ移動を分離します。編集モードON時に図面タグをドラッグすると、部材アンカーと移動量をSTB model-mm基準で保存します。PDFは表示への写像だけに使用し、PDF変更やページ変更ではタグ配置を変えません。向きはSTBモデルXY基準の時計回りです。">部材タグ配置 <span class="workspace-tip" aria-hidden="true">ⓘ</span></legend>
          <label><input id="pdf-overlay-tag-edit-mode" type="checkbox">タグ編集モード</label>
          <label>向き <select id="pdf-overlay-tag-rotation" class="form-control" disabled><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>
          <label title="既定はオフです。オンにすると部材本体の中心からタグへ引出線を表示します"><input id="pdf-overlay-tag-leader" type="checkbox" disabled>引出線を表示</label>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-reset-tag-placement" class="btn btn-secondary btn-sm" disabled>配置をリセット</button></div>
          <div id="pdf-overlay-tag-placement-status" class="workspace-result">部材タグを選択してください。</div>
        </fieldset>
    `,
    tagFamily: `
        <fieldset><legend title="標準タグは読取専用です。「複製」でユーザー定義へ変更できます。倍率はpaper-mmレイアウトへ一度だけ適用され、STB配置・PDF位置合わせ・ズーム・DPRには影響しません。">タグタイプ管理 <span class="workspace-tip" aria-hidden="true">ⓘ</span></legend>
          <label>カテゴリ <select id="pdf-overlay-tag-family-category" class="form-control"></select></label>
          <label>タグタイプ <select id="pdf-overlay-tag-family" class="form-control"></select></label>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-tag-family-new" class="btn btn-secondary btn-sm">新規</button><button type="button" id="pdf-overlay-tag-family-duplicate" class="btn btn-secondary btn-sm">複製</button><button type="button" id="pdf-overlay-tag-family-delete" class="btn btn-secondary btn-sm">削除</button></div>
          <label>名称 <input id="pdf-overlay-tag-family-name" class="form-control" maxlength="80"></label>
          <label>倍率 <span class="pdf-overlay-tag-family-scale-row"><input id="pdf-overlay-tag-family-scale" class="form-control" type="number" min="50" max="200" step="5" value="100"><span>%</span></span></label>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-tag-family-save-meta" class="btn btn-primary btn-sm">名称・倍率を保存</button><button type="button" id="pdf-overlay-tag-family-edit-layout" class="btn btn-secondary btn-sm">レイアウト編集</button></div>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-tag-family-export" class="btn btn-secondary btn-sm">JSONを書き出す</button><button type="button" id="pdf-overlay-tag-family-import-trigger" class="btn btn-secondary btn-sm">JSONを読み込む</button></div>
          <input id="pdf-overlay-tag-family-import" type="file" accept="application/json,.json" hidden>
          <div id="pdf-overlay-tag-family-status" class="workspace-result">タグタイプを選択してください。</div>
        </fieldset>
    `,
    memo: `
        <fieldset><legend title="自由メモは簡易CADのmodel-mm座標で保持します。PDFを重ねても正本座標は変わりません。">図面上の自由メモ <span class="workspace-tip" aria-hidden="true">ⓘ</span></legend>
          <label>メモ <textarea id="pdf-overlay-drawing-memo" class="form-control" rows="2" maxlength="2000" placeholder="部材には結び付かない図面メモ"></textarea></label>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-add-drawing-memo" class="btn btn-secondary btn-sm" disabled>図面に配置</button><button type="button" id="pdf-overlay-cancel-drawing-memo" class="btn btn-secondary btn-sm" disabled>配置を取消</button></div>
          <ol id="pdf-overlay-drawing-memo-list" class="pdf-overlay-memo-list"></ol>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-migrate-legacy-drawing-memos" class="btn btn-secondary btn-sm" disabled title="旧pageNumber + pdfPointメモを、同一PDF・同一ページ・有効な詳細位置合わせが確認できる場合だけSTB model-mmへ一括変換します。">旧PDFメモを図面座標へ移行</button></div>
          <div id="pdf-overlay-legacy-memo-migration-status" class="workspace-result">旧PDF座標メモはありません。</div>
        </fieldset>
    `,
    project: `
        <fieldset><legend title="部材レビュー・自由メモ・タグ配置をDrawingProjectとして保存します。PDFは不要です。読込時は現在表示中のSTB改訂と階に完全一致する場合だけ適用します。">Drawing Workspace JSON <span class="workspace-tip" aria-hidden="true">ⓘ</span></legend>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-export-drawing-project" class="btn btn-secondary btn-sm" disabled>プロジェクトJSONを書き出す</button><button type="button" id="pdf-overlay-import-drawing-project-trigger" class="btn btn-secondary btn-sm">プロジェクトJSONを読み込む</button></div>
          <input id="pdf-overlay-import-drawing-project" type="file" accept="application/json,.json" hidden>
          <div id="pdf-overlay-drawing-project-status" class="workspace-result">プロジェクト未保存</div>
        </fieldset>
        <fieldset><legend title="読み込んだDrawingProjectを新しいSTB原本へ差し替えます。対応は一意GUIDのみ自動確定し、GUIDなし・再採番・重複は手動承認してから一括commitします。">STB改訂差替え <span class="workspace-tip" aria-hidden="true">ⓘ</span></legend>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-rebind-stb-trigger" class="btn btn-secondary btn-sm">新STBを選択</button><button type="button" id="pdf-overlay-rebind-clear" class="btn btn-secondary btn-sm" disabled>差替えを取消</button></div>
          <input id="pdf-overlay-rebind-stb" type="file" accept=".stb,.xml,application/xml,text/xml" hidden>
          <div id="pdf-overlay-rebind-status" class="workspace-result">Drawing Workspace JSONを読み込むとSTB改訂差替えを開始できます。</div>
          <ol id="pdf-overlay-rebind-mapping-list" class="pdf-overlay-memo-list"></ol>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-rebind-reevaluate" class="btn btn-secondary btn-sm" disabled>選択対応で再評価</button><button type="button" id="pdf-overlay-rebind-commit" class="btn btn-primary btn-sm" disabled>改訂を確定してJSON保存</button></div>
        </fieldset>
        <fieldset><legend title="現行互換のPDF照合セッションです。書き出しにはPDFが必要です。Drawing Workspace全体の永続化はDrawingProjectへ段階的に移行します。">PDF照合セッションJSON <span class="workspace-tip" aria-hidden="true">ⓘ</span></legend>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-export-session" class="btn btn-secondary btn-sm" disabled>JSONを書き出す</button><button type="button" id="pdf-overlay-import-session-trigger" class="btn btn-secondary btn-sm">JSONを読み込む</button></div>
          <input id="pdf-overlay-import-session" type="file" accept="application/json,.json" hidden>
          <div class="workspace-actions"><button type="button" id="pdf-overlay-restore-session" class="btn btn-secondary btn-sm" disabled>現在の条件で復元を再評価</button></div>
          <div id="pdf-overlay-session-status" class="workspace-result">セッション未保存</div>
        </fieldset>
    `,
    diagnostics: `
        <div id="pdf-overlay-diagnostics" class="pdf-overlay-diagnostics"></div>
        <p class="help-text text-xs">PDF.js ${getPdfJsRuntimeInfo().version} / ローカル固定配布</p>

    `,
  };
}
