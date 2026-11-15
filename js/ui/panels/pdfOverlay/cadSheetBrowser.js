/** #565: saved views are model cut definitions; sheets are independent print layouts.
 * Sheet-only edits never need an active DrawingModel if the project is open.
 * The legacy snapshot is only used to initialize a missing project.
 * Compatible current-plan geometry is previewed through DrawingRenderPlan.
 * Multi-view CAD editing is not enabled; sheet SVG, DXF and PDF are exportable.
 */
import {
  DRAWING_PROJECT_KIND,
  DRAWING_PROJECT_SCHEMA_VERSION,
  normalizeDrawingProject,
} from '../../../data/drawing/drawingProjectSchema.js';
import {
  createEmptyDrawingSheetProject,
  seedEmptyDrawingSheetProjectView,
} from '../../../data/drawing/drawingSheetEmptyProject.js';
import {
  SHEET_PAPER_NAMES,
  describeSheetPaper,
  getSheetPaperSize,
} from '../../../data/drawing/drawingSheetPaper.js';
import { getDrawingSheetWorkspaceBounds } from '../../../data/drawing/drawingSheetWorkspaceBounds.js';
import { getSheetFrameLayout } from '../../../data/drawing/drawingSheetFrame.js';
import { DXF_LAYER_LINE_TYPES } from '../../../data/drawing/drawingDxfLayerSettings.js';
import { ELEMENT_TYPE_COLORS } from '../../../constants/dxfElementTypes.js';
import {
  PRINT_COLOR_MODES,
  PRINT_EXPORT_MODES,
  PRINT_LINE_PATTERNS,
  PRINT_LINE_WIDTH_PRESETS,
  resolveSheetPrintOptions,
} from '../../../data/drawing/drawingPrintSettings.js';
import { cutDrawingModelToBounds } from '../../../data/drawing/drawingSheetCutRegion.js';
import {
  editDrawingSheetMetadata,
  resolveCurrentSheetDrawingDocument,
} from '../../../data/drawing/drawingSheetProjectEdit.js';
import {
  createDrawingSheetRenderPlans,
  renderDrawingSheetCompositeSvg,
  serializeDrawingSheetCompositeSvg,
} from '../../../viewer/drawing/drawingSheetCompositeSvg.js';
import { downloadBlob } from '../../../utils/downloadHelper.js';
import { downloadDrawingSheetDxf } from '../../../export/dxf/DrawingSheetDxfWriter.js';
import { exportCompositeCadSheetPdf } from './cadSheetPdfExporter.js';
import { buildCadSheetBatchArchive } from './cadSheetBatchExporter.js';
import { bindCadSheetExportActions } from './cadSheetExportActions.js';
import { collectDrawingSheetModels } from '../../../data/drawing/drawingSheetSourceCollector.js';
import { registerCurrentSheetView } from '../../../data/drawing/drawingSheetViewRegistration.js';
import {
  renameSheetDrawingView,
  removeSheetDrawingView,
} from '../../../data/drawing/drawingSheetViewCatalog.js';
import { createInitialCadElevationProject } from './cadInitialElevationProject.js';
import { registerAllCadSheetViews } from '../../../data/drawing/drawingSheetBulkViewRegistration.js';
import { createDefaultCadViewProject } from '../../../data/drawing/drawingDefaultCadViews.js';
import { autoPlaceUnplacedCadViews } from '../../../data/drawing/drawingSheetAutoLayout.js';
import { listCadDrawingViews } from './cadDrawingViewList.js';
import { parseOptionalCadCutBounds } from './cadCutoutInput.js';
import { registerCadFloatWindow, registerCadRibbonAction } from './pdfOverlayRibbonMarkup.js';
import { floatingWindowManager } from '../floatingWindowManager.js';
import {
  displayCadSelectionInfo,
  displayCadCandidateInfo,
  refreshCadSelectionInfo,
} from '../element-info/CadViewElementInfo.js';
import { currentDrawingSheetSession } from '../../../data/drawing/drawingSheetSessionBridge.js';
import { CAD_SECTION_LIST_WINDOWS, openCadSectionListWindow } from './cadSectionListRibbon.js';
import { getState } from '../../../data/state/globalState.js';
import {
  resolveSheetViewportDocument,
  editSheetViewportAnnotation,
  moveSheetViewportTag,
} from '../../../data/drawing/drawingSheetViewportAnnotations.js';
import {
  computeSheetViewportDrag,
  preserveSheetViewportContentCenter,
  screenDeltaToSheetMm,
} from '../../../data/drawing/drawingSheetViewportDrag.js';
import { parseStories } from '../../../common-stb/import/parser/stbParserCore.js';
import { sha256 } from '../../../utils/sha256.js';
import { storyView } from './pdfOverlayPanelHelpers.js';
import {
  addDrawingSheet,
  convertSectionListLayoutToCadSheets,
  inspectDrawingSheetPlacements,
  placeDrawingDocumentOnSheet,
  placeSectionListRegionOnSheet,
  removeSectionListRegionFromSheet,
  updateSectionListRegionOnSheet,
  removeDrawingSheet,
  removeDrawingSheetPlacement,
  updateDrawingSheet,
  updateDrawingSheetPlacement,
} from '../../../data/drawing/drawingSheetCollection.js';
import {
  CAD_SHEET_LIST_TYPES,
  DEFAULT_LIST_REGION_SCALE,
  extractCadListGrid,
  buildVerifiedListReferencesForSheet,
  listRevisionSources,
  listCurrentSlabListRegions,
  measureListRegion,
  measureVerifiedSlabRegion,
} from './cadSheetListRegions.js';
import { findContainedSlabListOrigin } from './cadSlabListPlacementOrigin.js';

const SHEET_GENERATION_STAGE_LABELS = Object.freeze({
  initializing: '開始準備',
  'list-source-preparation': 'シート配置とリストの確認',
  'collect-start': '図面ソースの収集',
  'plan-producer': '伏図DrawingModelの生成',
  'elevation-producer': '軸組図DrawingModelの生成',
  'source-revision-check': '図面のSTB改訂照合',
  'final-revision-check': '全図面の最終改訂照合',
  'sheet-composition-check': 'シートの配置整合性確認',
  'collect-complete': '図面ソース収集完了',
  'list-revision-check': 'リストのSTB改訂照合',
  'svg-composition': 'シート図形の合成',
});

function describeSheetGenerationStage(progress) {
  const label = SHEET_GENERATION_STAGE_LABELS[progress?.phase] || '図形生成処理';
  return progress?.drawingDocumentId
    ? label + '（ビューID: ' + String(progress.drawingDocumentId).slice(0, 64) + '）'
    : label;
}

/** Capture the values that determine a registration before awaiting STB revision checks. */
function snapshotCadRegistrationFields(fields, lookup) {
  return JSON.stringify(
    fields.map((field) => {
      const element = lookup(field);
      return element?.type === 'checkbox' ? element.checked : (element?.value ?? null);
    }),
  );
}

/**
 * シートとビューを1つのツリーで扱うウィンドウ本文。
 * 2つのselectは選択状態の保持と既存の選択・編集処理との共有のために隠して残し、操作はツリーが担う。
 */
export function buildCadSheetListMarkup() {
  return [
    '<section id="pdf-overlay-view-browser" class="cad-sheet-browser cad-view-browser" aria-label="シート・ビュー一覧">',
    '<div id="pdf-overlay-sheet-tree" class="cad-catalog-tree" role="tree" aria-label="シート・ビュー一覧"></div>',
    '<div hidden aria-hidden="true">',
    '<select id="pdf-overlay-sheet-list" aria-label="登録済みシート"></select>',
    '<select id="pdf-overlay-registered-view-list" aria-label="登録済みビュー一覧"></select>',
    '</div>',
    '<div id="pdf-overlay-sheet-section-list-summary" role="note"></div>',
    '<div id="pdf-overlay-sheet-status" class="workspace-result" role="status" aria-live="polite">シート未作成</div>',
    '<div id="pdf-overlay-registered-view-status" class="workspace-result" role="status">登録済みビューなし</div>',
    '<div id="pdf-overlay-registered-view-menu" class="cad-view-context-menu" role="menu" aria-label="ビューの操作" hidden>',
    '<button type="button" id="pdf-overlay-sheet-rename-view" role="menuitem">名前変更</button>',
    '<button type="button" id="pdf-overlay-sheet-delete-view" role="menuitem">削除</button>',
    '</div>',
    '<div id="pdf-overlay-registered-view-editor" class="cad-view-name-editor" hidden>',
    '<label for="pdf-overlay-sheet-edit-view-name">ビュー名</label>',
    '<input id="pdf-overlay-sheet-edit-view-name" type="text" maxlength="100">',
    '<div class="workspace-actions">',
    '<button type="button" id="pdf-overlay-registered-view-save" class="btn btn-primary btn-sm">保存</button>',
    '<button type="button" id="pdf-overlay-registered-view-cancel" class="btn btn-secondary btn-sm">取消</button>',
    '</div>',
    '</div>',
    '</section>',
  ].join('');
}

/**
 * Resolve one catalog entry without mutating the active sheet or registered views.
 * Legacy section-list IDs and new-list commands are navigation items, not CAD sheets.
 */
export function resolveCadSheetCatalogSelection(project, value) {
  if (typeof value !== 'string' || !value) return null;
  const sheets = project?.drawingSheets ?? [];
  if (value.startsWith('section:')) {
    const sheet = sheets.find(
      (entry) => entry.id === value.slice('section:'.length) && entry.kind === 'section-list',
    );
    if (!sheet || !Object.hasOwn(CAD_SECTION_LIST_WINDOWS, sheet.listType)) return null;
    return { kind: 'section-list', sheetId: sheet.id, listType: sheet.listType };
  }
  if (value.startsWith('new-list:')) {
    const listType = value.slice('new-list:'.length);
    if (!Object.hasOwn(CAD_SECTION_LIST_WINDOWS, listType)) return null;
    // The catalog only offers a new-list command while that type is absent.
    if (sheets.some((entry) => entry.kind === 'section-list' && entry.listType === listType))
      return null;
    return { kind: 'new-list', listType };
  }
  const sheet = sheets.find((entry) => entry.id === value && entry.kind !== 'section-list');
  return sheet ? { kind: 'sheet', sheetId: sheet.id } : null;
}

function cutoutBoundsMarkup(kind) {
  return [
    '<fieldset class="cad-sheet-cut-bounds"><legend>モデル座標での切り出し範囲（mm・任意）</legend>',
    '<p class="cad-sheet-hint">4座標をすべて指定すると矩形切り出しを行います。非対応の境界・部材形状は登録せずエラーを表示します。</p>',
    ...[
      ['min-x', 'X最小'],
      ['min-y', 'Y最小'],
      ['max-x', 'X最大'],
      ['max-y', 'Y最大'],
    ].map(
      ([field, label]) =>
        '<label>' +
        label +
        '<input type="number" id="pdf-overlay-sheet-cut-' +
        kind +
        '-' +
        field +
        '" step="any" placeholder="未指定"></label>',
    ),
    '</fieldset>',
  ];
}

const CAD_SHEET_WINDOW_BODIES = Object.freeze({
  // The legacy selectors are retained as internal controls for the existing
  // drawing/navigation pipeline; the user-visible cutout form never depends on them.
  planCutout: () =>
    [
      '<section class="cad-sheet-browser" aria-label="伏図切り出し">',
      '<p class="cad-sheet-hint">現在開いているビューに関係なく、STB-Aの階を指定して切り出します。</p>',
      '<label for="pdf-overlay-sheet-cut-plan-story">切り出す階</label>',
      '<select id="pdf-overlay-sheet-cut-plan-story" aria-label="伏図の対象階"></select>',
      '<label for="pdf-overlay-sheet-cut-plan-name">ビュー名（任意）</label>',
      '<input id="pdf-overlay-sheet-cut-plan-name" type="text" maxlength="100" placeholder="例: 2F 伏図">',
      ...cutoutBoundsMarkup('plan'),
      '<label><input id="pdf-overlay-sheet-cut-plan-separate" type="checkbox">同じ階から別のビューとして登録</label>',
      '<button type="button" id="pdf-overlay-sheet-cut-plan-register" class="btn btn-primary btn-sm">伏図を切り出して登録</button>',
      '<div id="pdf-overlay-sheet-cut-plan-status" class="workspace-result" role="status" aria-live="polite"></div>',
      '<div hidden aria-hidden="true">',
      '<select id="pdf-overlay-model"><option value="A">STB-A</option><option value="B">STB-B</option></select>',
      '<select id="pdf-overlay-story"></select>',
      '<select id="pdf-overlay-axis-view"><option value="">指定なし（伏図）</option></select>',
      '<select id="pdf-overlay-view-list"></select>',
      '<div id="pdf-overlay-view-source"></div>',
      '<div id="pdf-overlay-status"></div>',
      '<input id="pdf-overlay-elevation-depth" type="number" value="2000" disabled>',
      '<input id="pdf-overlay-view-name" type="text">',
      '<input id="pdf-overlay-sheet-axis-depth" type="number" min="1" value="1500">',
      '<input type="number" id="pdf-overlay-sheet-cut-min-x">',
      '<input type="number" id="pdf-overlay-sheet-cut-min-y">',
      '<input type="number" id="pdf-overlay-sheet-cut-max-x">',
      '<input type="number" id="pdf-overlay-sheet-cut-max-y">',
      '<input type="checkbox" id="pdf-overlay-sheet-create-separate-view">',
      '</div>',
      '</section>',
    ].join(''),
  elevationCutout: () =>
    [
      '<section class="cad-sheet-browser" aria-label="軸組図切り出し">',
      '<p class="cad-sheet-hint">現在開いているビューに関係なく、STB-Aの通り芯を指定して切り出します。</p>',
      '<label for="pdf-overlay-sheet-cut-elevation-axis">切り出す通り芯</label>',
      '<select id="pdf-overlay-sheet-cut-elevation-axis" aria-label="軸組図の対象通り芯"></select>',
      '<label for="pdf-overlay-sheet-cut-elevation-depth">奥行（片側・mm）</label>',
      '<input id="pdf-overlay-sheet-cut-elevation-depth" type="number" min="1" step="any" value="2000">',
      '<label for="pdf-overlay-sheet-cut-elevation-name">ビュー名（任意）</label>',
      '<input id="pdf-overlay-sheet-cut-elevation-name" type="text" maxlength="100" placeholder="例: X1通り軸組図">',
      ...cutoutBoundsMarkup('elevation'),
      '<label><input id="pdf-overlay-sheet-cut-elevation-separate" type="checkbox">同じ通り芯から別のビューとして登録</label>',
      '<button type="button" id="pdf-overlay-sheet-cut-elevation-register" class="btn btn-primary btn-sm">軸組図を切り出して登録</button>',
      '<div id="pdf-overlay-sheet-cut-elevation-status" class="workspace-result" role="status" aria-live="polite"></div>',
      '</section>',
    ].join(''),
  // Legacy hidden registration inputs belong to the cutout form.
  sheetEdit: () =>
    [
      '<section class="cad-sheet-browser" aria-label="シート情報">',
      '<label for="pdf-overlay-sheet-number">シート番号</label>',
      '<input id="pdf-overlay-sheet-number" type="text" maxlength="100" placeholder="S-01">',
      '<label for="pdf-overlay-sheet-name">シート名</label>',
      '<input id="pdf-overlay-sheet-name" type="text" maxlength="100" placeholder="2F 伏図">',
      '<label for="pdf-overlay-sheet-paper">用紙サイズ</label>',
      '<select id="pdf-overlay-sheet-paper" aria-label="用紙サイズ">' +
        SHEET_PAPER_NAMES.map((paper) => {
          const { widthMm, heightMm } = getSheetPaperSize(paper, 'landscape');
          return `<option value="${paper}"${paper === 'A3' ? ' selected' : ''}>${paper}（${widthMm}×${heightMm}mm）</option>`;
        }).join('') +
        '</select>',
      '<label for="pdf-overlay-sheet-orientation">用紙方向</label>',
      '<select id="pdf-overlay-sheet-orientation" aria-label="用紙方向"><option value="landscape">横向き</option><option value="portrait">縦向き</option></select>',
      '<label><input id="pdf-overlay-sheet-frame-enabled" type="checkbox"> 図枠・表題欄を付ける</label>',
      '<label for="pdf-overlay-sheet-frame-project">工事名（表題欄）</label>',
      '<input id="pdf-overlay-sheet-frame-project" type="text" maxlength="80">',
      '<label for="pdf-overlay-sheet-frame-drawn-by">作成者</label>',
      '<input id="pdf-overlay-sheet-frame-drawn-by" type="text" maxlength="80">',
      '<label for="pdf-overlay-sheet-frame-date">日付</label>',
      '<input id="pdf-overlay-sheet-frame-date" type="text" maxlength="80" placeholder="2026-10-20">',
      '<div class="workspace-actions">',
      '<button type="button" id="pdf-overlay-sheet-create" class="btn btn-secondary btn-sm">新規</button>',
      '<button type="button" id="pdf-overlay-sheet-rename" class="btn btn-secondary btn-sm">シート情報更新</button>',
      '<button type="button" id="pdf-overlay-sheet-delete" class="btn btn-secondary btn-sm">削除</button></div>',
      '</section>',
    ].join(''),
  sheetPlacement: () =>
    [
      '<section class="cad-sheet-browser" aria-label="シート上のビュー配置">',
      '<div id="pdf-overlay-sheet-target" class="workspace-result cad-sheet-target" role="status"></div>',
      '<strong>① ビューを選ぶ</strong>',
      '<p class="cad-sheet-hint">ビューの生成・登録は「伏図切り出し」「軸組図切り出し」で行います。ここでは登録済みビューのみ配置します。</p>',
      '<label for="pdf-overlay-sheet-view-catalog">登録済みビュー（ダブルクリックで配置）</label>',
      '<select id="pdf-overlay-sheet-view-catalog" size="6" aria-label="配置する登録済みビュー"></select>',
      '<strong>② シートに配置する</strong>',
      '<div class="workspace-actions">',
      '<button type="button" id="pdf-overlay-sheet-place" class="btn btn-primary btn-sm">選んだビューをシートへ配置</button>',
      '<button type="button" id="pdf-overlay-sheet-auto-place-views" class="btn btn-secondary btn-sm" title="未配置のビューを新しいシートへ自動で並べます（用紙サイズは「用紙サイズ」の選択）">未配置ビューをまとめて自動配置</button></div>',
      '<strong>③ ビューポートの位置・大きさを調整する</strong>',
      '<p class="cad-sheet-hint">用紙外にも配置できます。PDFは用紙外をトリムします。</p>',
      '<label for="pdf-overlay-sheet-placements">シート上に配置済みのビュー（選ぶと下で調整できます）</label>',
      '<select id="pdf-overlay-sheet-placements" size="3" aria-label="シート上に配置済みのビュー"></select>',
      '<div class="workspace-actions">',
      '<button type="button" id="pdf-overlay-sheet-unplace" class="btn btn-secondary btn-sm">選択中の配置を解除</button></div>',
      '<div class="cad-sheet-placement-edit">',
      '<label>X(mm)<input id="pdf-overlay-sheet-x" type="number" step="any"></label>',
      '<label>Y(mm)<input id="pdf-overlay-sheet-y" type="number" step="any"></label>',
      '<label>幅(mm)<input id="pdf-overlay-sheet-width" type="number" min="1" step="any"></label>',
      '<label>高さ(mm)<input id="pdf-overlay-sheet-height" type="number" min="1" step="any"></label>',
      '<label>縮尺 1/<input id="pdf-overlay-sheet-scale" type="number" min="1" step="any"></label>',
      '<label>回転<select id="pdf-overlay-sheet-rotation"><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>',
      '<button type="button" id="pdf-overlay-sheet-apply" class="btn btn-secondary btn-sm">この値で配置を更新</button></div>',
      '<p class="cad-sheet-hint">シート上のビューポートの枠線をドラッグして移動できます。選択した枠の四隅・各辺の青いハンドルで大きさを変更できます（用紙外も編集可能）。</p>',
      '<details class="cad-sheet-annotation-edit" open><summary>④ ビューポートのタグ・寸法を編集</summary>',
      '<p class="cad-sheet-hint">ビューの保存注記を編集します。変更は同じビューを使う他シートにも反映されます。シート上の保存タグはドラッグでも移動できます。</p>',
      '<label>タグ<select id="pdf-overlay-sheet-edit-tag" aria-label="ビューポートの保存タグ"></select></label>',
      '<div class="cad-sheet-placement-edit">',
      '<label>タグX(mm)<input id="pdf-overlay-sheet-tag-x" type="number" step="any"></label>',
      '<label>タグY(mm)<input id="pdf-overlay-sheet-tag-y" type="number" step="any"></label>',
      '<label>回転<select id="pdf-overlay-sheet-tag-angle"><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>',
      '<label><input id="pdf-overlay-sheet-tag-leader" type="checkbox">引出線</label>',
      '<button type="button" id="pdf-overlay-sheet-tag-save" class="btn btn-secondary btn-sm">タグ更新</button></div>',
      '<label>寸法<select id="pdf-overlay-sheet-edit-dimension" aria-label="ビューポートの保存寸法"></select></label>',
      '<label>寸法オフセット（モデルmm）<input id="pdf-overlay-sheet-dimension-offset" type="number" step="any"></label>',
      '<button type="button" id="pdf-overlay-sheet-dimension-save" class="btn btn-secondary btn-sm">寸法更新</button>',
      '<div id="pdf-overlay-sheet-annotation-status" role="status" aria-live="polite"></div>',
      '</details>',
      '</section>',
    ].join(''),
  sheetListPlacement: () =>
    [
      '<section class="cad-sheet-browser cad-sheet-list-region" aria-label="シート上のリスト配置">',
      '<div id="pdf-overlay-sheet-list-target" class="workspace-result cad-sheet-target" role="status"></div>',
      '<p class="cad-sheet-hint">STB-AのRC梁・RC柱・S梁・S柱・SRC梁・SRC柱・スラブリストを選んでシートに配置します。配置後も位置と縮尺を個別に変更できます。</p>',
      '<label for="pdf-overlay-sheet-list-type">リスト種別</label>',
      '<select id="pdf-overlay-sheet-list-type" aria-label="リスト種別">' +
        Object.entries(CAD_SHEET_LIST_TYPES)
          .map(([key, def]) => '<option value="' + key + '">' + def.label + '</option>')
          .join('') +
        '</select>',
      '<label for="pdf-overlay-sheet-list-stories">階（複数選択可）</label>',
      '<select id="pdf-overlay-sheet-list-stories" size="4" multiple aria-label="リスト領域の階"></select>',
      '<label for="pdf-overlay-sheet-list-symbols">符号（複数選択可）</label>',
      '<select id="pdf-overlay-sheet-list-symbols" size="4" multiple aria-label="リスト領域の符号"></select>',
      '<label>縮尺 1/<input id="pdf-overlay-sheet-list-scale" type="number" min="1" step="any" value="' +
        DEFAULT_LIST_REGION_SCALE +
        '"></label>',
      '<div class="workspace-actions">',
      '<button type="button" id="pdf-overlay-sheet-list-refresh" class="btn btn-secondary btn-sm">階・符号を読込</button>',
      '<button type="button" id="pdf-overlay-sheet-list-place" class="btn btn-secondary btn-sm">リスト領域を配置</button></div>',
      '<label for="pdf-overlay-sheet-list-placements">シート上のリスト領域</label>',
      '<select id="pdf-overlay-sheet-list-placements" size="3" aria-label="配置リスト領域"></select>',
      '<button type="button" id="pdf-overlay-sheet-list-unplace" class="btn btn-secondary btn-sm">リスト領域の配置解除</button>',
      '<strong>配置したリストを編集</strong>',
      '<div class="cad-sheet-placement-edit">',
      '<label>X(mm)<input id="pdf-overlay-sheet-list-edit-x" type="number" step="any"></label>',
      '<label>Y(mm)<input id="pdf-overlay-sheet-list-edit-y" type="number" step="any"></label>',
      '<label>幅(mm)<input id="pdf-overlay-sheet-list-edit-width" type="number" min="1" step="any"></label>',
      '<label>高さ(mm)<input id="pdf-overlay-sheet-list-edit-height" type="number" min="1" step="any"></label>',
      '<label>縮尺 1/<input id="pdf-overlay-sheet-list-edit-scale" type="number" min="1" step="any"></label>',
      '<label>見出し<input id="pdf-overlay-sheet-list-edit-label" type="text" maxlength="200" placeholder="任意"></label>',
      '<button type="button" id="pdf-overlay-sheet-list-apply" class="btn btn-secondary btn-sm">配置したリストを更新</button>',
      '</div>',
      '</section>',
      '</section>',
    ].join(''),
  sheetOutput: () =>
    [
      '<section class="cad-sheet-browser" aria-label="シート確認・保存">',
      '<button type="button" id="pdf-overlay-sheet-preview-generate" class="btn btn-secondary btn-sm">シート内の全ビューを生成・確認</button>',
      '<button type="button" id="pdf-overlay-sheet-save-svg" class="btn btn-secondary btn-sm">確認済みシート保存</button>',
      '<button type="button" id="pdf-overlay-sheet-save-dxf" class="btn btn-secondary btn-sm">確認済みシートDXF保存</button>',
      '<button type="button" id="pdf-overlay-sheet-save-pdf" class="btn btn-secondary btn-sm">確認済みシートPDF保存</button>',
      '<button type="button" id="pdf-overlay-sheet-save-all-zip" class="btn btn-secondary btn-sm">全シート一括保存（ZIP）</button>',
      '<details class="cad-dxf-layer-settings"><summary>DXFレイヤー設定（名前・色・線種）</summary>',
      '<p class="cad-sheet-hint">部材種別ごとにDXF出力のレイヤー名・色番号(1-255)・線種を指定します。プロジェクトに保存され、シートDXFと一括保存ZIPに反映されます。未指定の項目は既定のままです。</p>',
      '<label for="pdf-overlay-sheet-dxf-layer-id">部材種別（レイヤーID）</label>',
      '<select id="pdf-overlay-sheet-dxf-layer-id" aria-label="DXFレイヤー対象">' +
        DXF_LAYER_IDS.map((layerId) => `<option value="${layerId}">${layerId}</option>`).join('') +
        '</select>',
      '<label for="pdf-overlay-sheet-dxf-layer-name">レイヤー名（半角英数 $ - _、31文字まで）</label>',
      '<input id="pdf-overlay-sheet-dxf-layer-name" type="text" maxlength="31" placeholder="既定のまま">',
      '<label for="pdf-overlay-sheet-dxf-layer-color">色番号（1-255）</label>',
      '<input id="pdf-overlay-sheet-dxf-layer-color" type="number" min="1" max="255" step="1" placeholder="既定のまま">',
      '<label for="pdf-overlay-sheet-dxf-layer-linetype">線種</label>',
      '<select id="pdf-overlay-sheet-dxf-layer-linetype" aria-label="DXFレイヤー線種"><option value="">既定のまま</option>' +
        Object.entries(DXF_LAYER_LINE_TYPES)
          .map(([key, def]) => `<option value="${key}">${def.label}（${key}）</option>`)
          .join('') +
        '</select>',
      '<div class="workspace-actions">',
      '<button type="button" id="pdf-overlay-sheet-dxf-layer-apply" class="btn btn-secondary btn-sm">設定</button>',
      '<button type="button" id="pdf-overlay-sheet-dxf-layer-remove" class="btn btn-secondary btn-sm">この種別の設定を解除</button></div>',
      '<ul id="pdf-overlay-sheet-dxf-layer-list" aria-label="DXFレイヤー設定一覧"></ul>',
      '</details>',
      '<details class="cad-print-settings"><summary>印刷設定（PDF）</summary>',
      '<p class="cad-sheet-hint">PDFの線の太さ・線種・色・出力方式をプロジェクトに保存します。ZIPやJSONから再読込しても同じ設定で印刷できます。未選択の項目は出力タブの設定を使います。余白は図枠設定の余白です。</p>',
      ...[
        ['line-width', '線の太さ', PRINT_LINE_WIDTH_PRESETS],
        ['line-pattern', '線種', PRINT_LINE_PATTERNS],
        ['color-mode', '色', PRINT_COLOR_MODES],
        ['export-mode', '出力方式', PRINT_EXPORT_MODES],
      ].flatMap(([key, label, options]) => [
        `<label for="pdf-overlay-sheet-print-${key}">${label}</label>`,
        `<select id="pdf-overlay-sheet-print-${key}" aria-label="印刷設定 ${label}"><option value="">出力タブの設定を使う</option>${Object.entries(
          options,
        )
          .map(([value, text]) => `<option value="${value}">${text}</option>`)
          .join('')}</select>`,
      ]),
      '<button type="button" id="pdf-overlay-sheet-print-apply" class="btn btn-secondary btn-sm">印刷設定を保存</button>',
      '</details>',
      '<div id="pdf-overlay-sheet-preview" aria-label="用紙配置・図形プレビュー"></div>',
      '<p class="cad-sheet-hint">プロジェクトのJSON・ZIP保存と読込は「図面プロジェクト」から行います。</p>',
      '</section>',
    ].join(''),
});

/** ビュー・シート管理のウィンドウ（左パネルから移動）。リボン「ホーム」の「ビュー」「シート」グループに並ぶ。 */
const CAD_SHEET_WINDOWS = Object.freeze([
  {
    key: 'sheetCatalog',
    icon: 'sheetList',
    title: 'シート・ビュー一覧',
    label: 'シート・ビュー一覧',
    tip: 'シートと、各シートに配置したビュー・柱梁スラブリストをツリーで表示・選択',
    ribbon: { tab: 'home', group: 'ビュー' },
  },
  {
    key: 'planCutout',
    icon: 'planCut',
    title: '伏図切り出し',
    label: '伏図切り出し',
    tip: 'STB-Aの階と範囲を指定して伏図ビューを生成・登録',
    ribbon: { tab: 'home', group: 'ビュー' },
  },
  {
    key: 'elevationCutout',
    icon: 'elevationCut',
    title: '軸組図切り出し',
    label: '軸組図切り出し',
    tip: 'STB-Aの通り芯と奥行・範囲を指定して軸組図ビューを生成・登録',
    ribbon: { tab: 'home', group: 'ビュー' },
  },
  {
    key: 'sheetEdit',
    icon: 'sheetInfo',
    title: 'シート情報',
    label: 'シート情報',
    tip: 'シート番号・名称・用紙方向の作成と更新',
    ribbon: { tab: 'home', group: 'シート' },
  },
  {
    key: 'sheetPlacement',
    icon: 'placeView',
    title: 'シート上のビュー配置',
    label: 'ビュー配置',
    tip: '選択ビューの配置・解除と位置・縮尺・回転の更新',
    ribbon: { tab: 'home', group: 'シート' },
  },
  {
    key: 'sheetListPlacement',
    icon: 'placeList',
    title: 'シート上のリスト配置',
    label: 'リスト配置',
    tip: 'RC/S/SRC柱・梁・スラブリストの配置・編集・解除',
    ribbon: { tab: 'home', group: 'シート' },
  },
  {
    key: 'sheetOutput',
    icon: 'sheetExport',
    title: 'シート確認・保存',
    label: 'シート出力',
    tip: 'シートの図面・DXF・PDF・一括ZIP出力（プロジェクトJSON・ZIPは「図面プロジェクト」）',
    ribbon: { tab: 'home', group: 'シート' },
  },
]);
const registeredSheetWindows = CAD_SHEET_WINDOWS.map((def) =>
  registerCadFloatWindow({
    ...def,
    body: def.key === 'sheetCatalog' ? buildCadSheetListMarkup : CAD_SHEET_WINDOW_BODIES[def.key],
  }),
);
const SHEET_PLACEMENT_WINDOW_ID = registeredSheetWindows.find(
  (entry) => entry.key === 'sheetPlacement',
).windowId;

// 図面生成ボタンと同様に、1クリックで空のシートを作る。ビューはその後に配置する。
registerCadRibbonAction({
  key: 'sheetCreate',
  icon: 'sheetNew',
  label: 'シート生成',
  tip: '空のシートを作成し、ビュー配置ウィンドウを開きます',
  ribbon: { tab: 'home', group: 'シート' },
  run: () => {
    const panel = currentDrawingSheetSession();
    try {
      panel.sheetBrowser.createBlankSheet();
    } catch (error) {
      const status = panel?.sheetBrowser?.el('status');
      if (status) status.textContent = error?.message || String(error);
    }
  },
});

/** 左パネル + 全ウィンドウ本文を連結した従来相当のmarkup（単体テスト・デバッグ用）。 */
export function buildCadSheetBrowserMarkup() {
  return [
    buildCadSheetListMarkup(),
    ...CAD_SHEET_WINDOWS.filter((def) => def.key !== 'sheetCatalog').map((def) =>
      CAD_SHEET_WINDOW_BODIES[def.key](),
    ),
  ].join('');
}
/** ビューの表示名。IDそのもの（drawing:...）が名前のときは種別と階/通り芯から組み立てる。 */
export function describeSheetView(view) {
  const spec = view?.view ?? {};
  const kind =
    spec.type === 'plan'
      ? '伏図 ' + spec.storyId
      : spec.type === 'elevation'
        ? '軸組図 ' + spec.axisDirection + spec.axisId
        : '';
  const name = String(view?.name || '');
  return !name || name.startsWith('drawing:') ? kind || view?.id || '' : name + ' [' + kind + ']';
}
/** 現行改訂で登録済みの、ビュー候補に対応するDrawingDocumentを返す（奥行は問わない）。 */
export function findRegisteredView(project, candidate) {
  return (project?.drawingDocuments ?? []).find((document) => {
    const slot = project.modelSlots?.find((entry) => entry.id === document.modelSlotId);
    if (!slot || slot.currentRevisionId !== document.sourceRevisionId) return false;
    // An explicitly bounded cut is not the same as the full-story candidate.
    if (document.view.cutBoundsMm || document.view.type !== candidate.type) return false;
    return candidate.type === 'plan'
      ? String(document.view.storyId) === String(candidate.storyId)
      : document.view.axisDirection === candidate.axisDirection &&
          String(document.view.axisId) === String(candidate.axisId);
  });
}
function id(prefix) {
  return prefix + '-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36));
}
const fieldMap = {
  xMm: 'x',
  yMm: 'y',
  widthMm: 'width',
  heightMm: 'height',
  scaleDenominator: 'scale',
  rotationDeg: 'rotation',
};

/** Layer ids a user can restyle: member types and the annotation layer of the RenderPlan. */
const DXF_LAYER_IDS = Object.freeze([...Object.keys(ELEMENT_TYPE_COLORS), 'Annotation']);

/** Print setting field => control suffix (ids are pdf-overlay-sheet-<suffix>). */
const PRINT_SETTING_CONTROLS = Object.freeze([
  ['lineWidthPreset', 'print-line-width'],
  ['linePattern', 'print-line-pattern'],
  ['colorMode', 'print-color-mode'],
  ['exportMode', 'print-export-mode'],
]);

/** Non-blocking layout diagnostics must remain visible after actual geometry renders. */
function describeSheetLayoutWarnings(sheet) {
  const issues = inspectDrawingSheetPlacements(sheet);
  if (!issues.length) return '';
  return (
    ' 配置警告 ' +
    issues.length +
    '件: ' +
    issues.map((issue) => issue.code).join(', ') +
    '。PDFでは用紙外をトリムします。'
  );
}

/** First nonoverlapping 180x120mm placement inside the sheet's paper (and its frame, if any). */
export function findSheetPlacementOrigin(sheet, w = 180, h = 120) {
  const { widthMm: paperW, heightMm: paperH } = getSheetPaperSize(sheet.paper, sheet.orientation);
  const layout = getSheetFrameLayout(sheet);
  const area = layout?.inner ?? { minX: 10, minY: 10, maxX: paperW - 10, maxY: paperH - 10 };
  const occupied = [
    ...sheet.placements,
    ...(sheet.listPlacements ?? []),
    ...(layout
      ? [
          {
            xMm: layout.titleBlock.minX,
            yMm: layout.titleBlock.minY,
            widthMm: layout.titleBlock.maxX - layout.titleBlock.minX,
            heightMm: layout.titleBlock.maxY - layout.titleBlock.minY,
          },
        ]
      : []),
  ];
  for (let yMm = area.minY; yMm + h <= area.maxY; yMm += 10)
    for (let xMm = area.minX; xMm + w <= area.maxX; xMm += 10)
      if (
        occupied.every(
          (p) =>
            xMm + w <= p.xMm ||
            p.xMm + p.widthMm <= xMm ||
            yMm + h <= p.yMm ||
            p.yMm + p.heightMm <= yMm,
        )
      )
        return { xMm, yMm };
  // Continue outside the paper instead of refusing to place an oversize view.
  if (occupied.length === 0 || (occupied.length === 1 && layout)) return { xMm: 10, yMm: 10 };
  return {
    xMm: 10,
    yMm: Math.max(10, ...occupied.map((item) => item.yMm + item.heightMm + 10)),
  };
}

/**
 * Temporary print surface for a registered ViewSpec. Never mutates or saves the
 * project; the view's persistent paper size and scale govern the export.
 */
export function createStandaloneViewPdfSheetProject(project, viewId) {
  const view = project?.drawingDocuments?.find((item) => item.id === viewId);
  if (!view) throw new Error('PDF出力対象のビューが存在しません。');
  const paper = view.sheet?.paper || 'A3';
  const orientation = view.sheet?.orientation || 'landscape';
  const { widthMm, heightMm } = getSheetPaperSize(paper, orientation);
  let serial = 1;
  while (
    (project.drawingSheets ?? []).some(
      (item) => item.id === 'pdf-temp-' + serial || item.number === 'PDF-TEMP-' + serial,
    )
  )
    serial++;
  const sheetId = 'pdf-temp-' + serial;
  const outputProject = normalizeDrawingProject({
    ...project,
    drawingSheets: [
      ...(project.drawingSheets ?? []),
      {
        id: sheetId,
        number: 'PDF-TEMP-' + serial,
        name: view.name || view.id,
        paper,
        orientation,
        placements: [
          {
            id: 'pdf-placement-' + serial,
            drawingDocumentId: view.id,
            xMm: 10,
            yMm: 10,
            widthMm: widthMm - 20,
            heightMm: heightMm - 20,
            scaleDenominator: view.sheet?.scaleDenominator || 200,
            rotationDeg: 0,
          },
        ],
      },
    ],
  });
  return { project: outputProject, sheetId };
}

export class CadSheetBrowser {
  constructor(panel) {
    this.panel = panel;
    this.root = panel.root;
    this.sheetId = '';
    this.sectionSheetSelection = '';
    this.placementId = '';
    this.previewSources = null;
    this.previewSheetId = '';
    this.previewProject = null;
    this.previewSourceDocument = null;
    this.previewListRefs = {};
    this.listPlacementId = '';
    this.listGrid = null;
    this.previewAbortController = null;
    this.batchAbortController = null;
    /** true の間、選択中シートをメインビューへ表示する（図面選択・図面生成で解除）。 */
    this.mainViewActive = false;
    this.mainViewSeq = 0;
    this.mainViewGeneration = null;
    this.mainViewError = null;
    this.cutoutAbortController = null;
    this.editTagId = '';
    this.editDimensionId = '';
    this.defaultViewsPromise = null;
    this.defaultViewsSource = null;
    this.defaultViewsAbortController = null;
  }
  invalidatePreviewSources() {
    this.previewAbortController?.abort();
    this.batchAbortController?.abort();
    this.previewSources = null;
    this.previewSheetId = '';
    this.previewProject = null;
    this.previewSourceDocument = null;
    this.previewListRefs = {};
    this.mainViewError = null;
    this.panel.updatePdfFeatureAvailability?.();
  }
  /**
   * #650: discard every model-bound cache after an atomic STB-A + DrawingProject
   * replacement. Keep the selected sheet and list placement identifiers so
   * users can return to the same normal sheet after it is regenerated.
   */
  invalidatePublishedModelSources() {
    this.invalidatePreviewSources();
    ++this.mainViewSeq;
    globalThis.clearTimeout(this.mainViewGeneration?.slowTimer);
    this.mainViewGeneration = null;
    this.mainViewError = null;
    this.listGrid = null;
    this.defaultViewsAbortController?.abort();
    this.defaultViewsSource = null;
    this.defaultViewsPromise = null;
    this.cutoutAbortController?.abort();
    this.panel.updatePdfFeatureAvailability?.();
  }

  /** リスト領域が使うSTB-A改訂が、現行モデルのままか再照合する。 */
  async assertListSourcesCurrent(services, project, sheetId) {
    const sheet = project.drawingSheets.find((entry) => entry.id === sheetId);
    for (const source of listRevisionSources(project, sheet))
      await services.assertDrawingSourceCurrent({ source });
  }
  async generateSheetPreview({ onProgress } = {}) {
    // Diagnostic callbacks must not interfere with actual DrawingModel generation.
    const progress = (entry) => {
      try {
        onProgress?.(entry);
      } catch {
        // Observational only.
      }
    };
    const project = this.project();
    const sheetId = this.sheetId;
    if (!project || !this.sheet()) throw new Error('プレビューするシートを選択してください。');
    const source = getState('models.documentA');
    if (source?.nodeType !== 9 && this.sheetOccupancy(this.sheet()) === 0) {
      this.invalidatePreviewSources();
      this.renderPreview();
      this.el('status').textContent =
        '空の' + this.sheet().paper + 'シートを表示しています。ビューを登録してから配置できます。';
      return;
    }
    if (source?.nodeType !== 9) throw new Error('STB-Aを先に読み込んでください。');
    this.panel.services ||= this.panel.getServices?.();
    this.invalidatePreviewSources();
    const abortController = new globalThis.AbortController();
    this.previewAbortController = abortController;
    this.el('preview-generate').disabled = true;
    this.el('status').textContent = 'シート内の伏図・軸組図を生成・照合しています。';
    try {
      const sheet = project.drawingSheets.find((entry) => entry.id === sheetId);
      progress({ phase: 'list-source-preparation' });
      const listRefs = await buildVerifiedListReferencesForSheet({
        sheet,
        sourceDocument: source,
        project,
        Parser: this.root.ownerDocument.defaultView?.DOMParser,
      });
      const drawingsById = await collectDrawingSheetModels({
        project,
        sheetId,
        listReferencesByPlacementId: listRefs,
        services: this.panel.services,
        planViewForStory: (storyId) => storyView(parseStories(source), storyId),
        signal: abortController.signal,
        onProgress: progress,
      });
      if (
        abortController.signal.aborted ||
        this.project() !== project ||
        this.sheetId !== sheetId ||
        getState('models.documentA') !== source
      )
        throw new Error(
          'シート生成中にSTB-Aまたはプロジェクトが変更されました。再生成してください。',
        );
      progress({ phase: 'list-revision-check' });
      await this.assertListSourcesCurrent(this.panel.services, project, sheetId);
      // Source validation may itself await I/O. Recheck after the final await
      // before publishing any drawing generated for the previous context.
      if (
        abortController.signal.aborted ||
        this.project() !== project ||
        this.sheetId !== sheetId ||
        getState('models.documentA') !== source
      )
        throw new Error(
          'シート生成中にSTB-Aまたはプロジェクトが変更されました。再生成してください。',
        );
      this.previewListRefs = listRefs;
      this.previewSources = drawingsById;
      this.previewSheetId = sheetId;
      this.previewProject = project;
      this.previewSourceDocument = source;
      // During generation a composite-render failure is a generation failure,
      // not a silently successful frame-only preview.
      progress({ phase: 'svg-composition' });
      this.renderPreview({ throwOnCompositeError: true });
      this.panel.updatePdfFeatureAvailability?.();
    } finally {
      if (this.previewAbortController === abortController) {
        this.previewAbortController = null;
        this.el('preview-generate').disabled = false;
      }
    }
  }
  /**
   * Register the *generated* ViewSpec, not the user's unverified CAD selection.
   * Source and revision are checked before touching persistent DrawingProject.
   */
  async autoPlaceViews() {
    const project = this.project();
    if (!project) throw new Error('DrawingProjectを先に作成・読込してください。');
    const sourceDocument = getState('models.documentA');
    if (sourceDocument?.nodeType !== 9) throw new Error('STB-Aを先に読み込んでください。');
    if (this.batchAbortController) throw new Error('別の一括処理が進行中です。');
    const used = new Set(
      (project.drawingSheets || [])
        .filter((sheet) => sheet.kind !== 'section-list')
        .flatMap((sheet) => sheet.placements.map((placement) => placement.drawingDocumentId)),
    );
    const unplaced = project.drawingDocuments.filter((document) => !used.has(document.id));
    if (!unplaced.length) {
      this.el('status').textContent = '未配置ビューはありません。';
      return { addedSheets: [], addedPlacements: 0, project };
    }
    this.panel.services ||= this.panel.getServices?.();
    const services = this.panel.services;
    if (
      typeof services?.createDrawing !== 'function' ||
      typeof services?.createAxisElevationDrawing !== 'function' ||
      typeof services?.assertDrawingSourceCurrent !== 'function'
    )
      throw new Error('STB-A図面生成・改訂照合サービスが不足しています。');
    const controller = new globalThis.AbortController();
    this.batchAbortController = controller;
    const button = this.el('auto-place-views');
    button.disabled = true;
    try {
      const stories = parseStories(sourceDocument);
      const drawingsById = Object.create(null);
      const assertUnchanged = () => {
        if (
          controller.signal.aborted ||
          this.project() !== project ||
          getState('models.documentA') !== sourceDocument
        )
          throw new Error('自動配置中にプロジェクトまたはSTB-Aが変更されました。');
      };
      for (const [index, document] of unplaced.entries()) {
        assertUnchanged();
        this.el('status').textContent = '配置用ビュー生成中 ' + (index + 1) + '/' + unplaced.length;
        let drawing;
        if (document.view.type === 'plan') {
          const view = storyView(stories, document.view.storyId);
          drawing = await services.createDrawing({
            modelKey: 'A',
            view,
            signal: controller.signal,
          });
        } else if (document.view.type === 'elevation') {
          const { axisDirection, axisId, depth } = document.view;
          drawing = await services.createAxisElevationDrawing({
            modelKey: 'A',
            axisDirection,
            axisId,
            depth,
            signal: controller.signal,
          });
        } else {
          throw new Error('未対応のViewSpecです: ' + document.id);
        }
        assertUnchanged();
        await services.assertDrawingSourceCurrent({ source: drawing?.source });
        assertUnchanged();
        drawingsById[document.id] = drawing;
      }
      const result = autoPlaceUnplacedCadViews({
        project,
        drawingsById,
        orientation: this.el('orientation').value,
        paper: this.el('paper').value,
        idFactory: (type) => id(type),
      });
      // Validate every candidate once more before committing any placement.
      for (const drawing of Object.values(drawingsById)) {
        await services.assertDrawingSourceCurrent({ source: drawing.source });
        assertUnchanged();
      }
      const session = this.panel.sessionUi;
      session.closeOpenDrawingProject?.();
      session.loadedDrawingProject = result.project;
      session.drawingProjectId = result.project.projectId;
      this.invalidatePreviewSources();
      this.sheetId = result.addedSheets[0] || this.sheetId;
      this.render();
      this.el('status').textContent =
        '未配置' +
        result.addedPlacements +
        'ビューを' +
        this.el('paper').value +
        ' ' +
        result.addedSheets.length +
        'シートに自動配置しました。出力前に全ビューを確認してください。';
      return result;
    } finally {
      if (this.batchAbortController === controller) this.batchAbortController = null;
      button.disabled = false;
    }
  }
  /** 現行STB-Aのビュー候補を、生成済みViewSpecとして登録する（改訂を照合してから確定）。 */
  async registerViews(candidates) {
    const project = this.project();
    if (!project) throw new Error('DrawingProjectを先に作成・読込してください。');
    const sourceDocument = getState('models.documentA');
    if (sourceDocument?.nodeType !== 9) throw new Error('STB-Aを先に読み込んでください。');
    if (!Array.isArray(candidates) || !candidates.length)
      throw new Error('STB-Aの伏図・軸組図候補がありません。');
    const activeDrawing = this.panel.drawing;
    let drawing = activeDrawing;
    const services = this.panel.services || this.panel.getServices?.();
    if (typeof services?.assertDrawingSourceCurrent !== 'function')
      throw new Error('STB改訂検証サービスがありません。');

    // The legacy internal axis-depth and scale are registration inputs.
    // Freeze both before any asynchronous model generation or revision check.
    const inputs = () =>
      JSON.stringify([this.el('axis-depth')?.value ?? null, this.panel.scaleDenominator()]);
    const originalInputs = inputs();
    const depth = Number(this.el('axis-depth').value);
    const scaleDenominator = this.panel.scaleDenominator();
    const assertUnchanged = () => {
      if (
        project !== this.project() ||
        this.panel.drawing !== activeDrawing ||
        getState('models.documentA') !== sourceDocument ||
        inputs() !== originalInputs
      )
        throw new Error('ビュー登録中にプロジェクト・STB-Aまたは登録条件が変更されました。');
    };

    const paperOnly = !project.modelSlots.length && !project.drawingDocuments.length;
    if (paperOnly) {
      // Bulk registration must not depend on an unrelated displayed view (or
      // on any DrawingModel being open). Generate a temporary STB-A source only.
      const first = candidates.find((candidate) => candidate?.type === 'plan') || candidates[0];
      if (first.type === 'plan') {
        if (typeof services.createDrawing !== 'function')
          throw new Error('STB-A伏図生成サービスがありません。');
        drawing = await services.createDrawing({
          modelKey: 'A',
          view: storyView(parseStories(sourceDocument), String(first.storyId)),
        });
      } else if (first.type === 'elevation') {
        if (typeof services.createAxisElevationDrawing !== 'function')
          throw new Error('STB-A軸組図生成サービスがありません。');
        drawing = await services.createAxisElevationDrawing({
          modelKey: 'A',
          axisDirection: first.axisDirection,
          axisId: first.axisId,
          depth,
        });
      } else {
        throw new Error('一括登録に未対応のビュー候補があります。');
      }
    }
    assertUnchanged();
    await services.assertDrawingSourceCurrent({ source: drawing?.source });
    assertUnchanged();
    const result = registerAllCadSheetViews({
      project,
      drawing,
      candidates,
      depth,
      scaleDenominator,
      display: this.panel.drawingDisplaySettings?.() ?? {},
      idFactory: () => id('view'),
    });
    if (result.addedIds.length) {
      const session = this.panel.sessionUi;
      session.closeOpenDrawingProject?.();
      session.loadedDrawingProject = result.project;
      session.drawingProjectId = result.project.projectId;
      this.invalidatePreviewSources();
      this.render();
    }
    return result;
  }
  async registerAllViews() {
    if (!this.project()) throw new Error('DrawingProjectを先に作成・読込してください。');
    const sourceDocument = getState('models.documentA');
    if (sourceDocument?.nodeType !== 9) throw new Error('STB-Aを先に読み込んでください。');
    const result = await this.registerViews(
      listCadDrawingViews({ document: sourceDocument, modelKey: 'A' }),
    );
    this.el('status').textContent =
      'STB-Aの全階・全通り芯を登録しました。新規' +
      result.addedIds.length +
      '件 / 既存' +
      result.reused +
      '件。シートへの配置は個別に行ってください。';
    return result;
  }
  /**
   * First entry into CAD with STB-A: pre-register every story/axis ViewSpec.
   * Existing DrawingProjects, including intentionally empty ones, are never changed.
   * Only the first DrawingModel is generated to obtain a verified source revision.
   */
  async initializeDefaultViewsOnOpen() {
    if (!this.root.classList.contains('visible') || this.project()) return null;
    const sourceDocument = getState('models.documentA');
    if (sourceDocument?.nodeType !== 9) return null;
    if (this.defaultViewsPromise && this.defaultViewsSource === sourceDocument)
      return this.defaultViewsPromise;
    this.defaultViewsAbortController?.abort();
    const controller = new globalThis.AbortController();
    this.defaultViewsAbortController = controller;
    this.defaultViewsSource = sourceDocument;
    const task = (async () => {
      const candidates = listCadDrawingViews({ document: sourceDocument, modelKey: 'A' });
      if (!candidates.length) return null;
      const services = this.panel.services || this.panel.getServices?.();
      if (typeof services?.assertDrawingSourceCurrent !== 'function')
        throw new Error('STB-Aの改訂照合サービスがありません。');
      const first = candidates[0];
      // Automatic ViewSpecs must not mix registration inputs from different moments.
      const inputs = () =>
        JSON.stringify([this.el('axis-depth')?.value ?? null, this.panel.scaleDenominator()]);
      const originalInputs = inputs();
      const depth = Number(this.el('axis-depth').value);
      const scaleDenominator = this.panel.scaleDenominator();
      let drawing;
      if (first.type === 'plan') {
        if (typeof services.createDrawing !== 'function')
          throw new Error('STB-A伏図生成サービスがありません。');
        drawing = await services.createDrawing({
          modelKey: 'A',
          view: storyView(parseStories(sourceDocument), first.storyId),
          signal: controller.signal,
        });
      } else {
        if (typeof services.createAxisElevationDrawing !== 'function')
          throw new Error('STB-A軸組図生成サービスがありません。');
        drawing = await services.createAxisElevationDrawing({
          modelKey: 'A',
          axisDirection: first.axisDirection,
          axisId: first.axisId,
          depth,
          signal: controller.signal,
        });
      }
      const unchanged = () =>
        !controller.signal.aborted &&
        this.root.classList.contains('visible') &&
        this.project() === null &&
        getState('models.documentA') === sourceDocument &&
        inputs() === originalInputs;
      if (!unchanged()) return null;
      await services.assertDrawingSourceCurrent({ source: drawing?.source });
      if (!unchanged()) return null;
      const result = createDefaultCadViewProject({
        drawing,
        candidates,
        projectId: id('project'),
        idFactory: () => id('view'),
        depth,
        scaleDenominator,
        display: this.panel.drawingDisplaySettings?.() ?? {},
      });
      if (!unchanged()) return null;
      const session = this.panel.sessionUi;
      session.closeOpenDrawingProject?.();
      session.loadedDrawingProject = result.project;
      session.drawingProjectId = result.project.projectId;
      this.render();
      this.el('status').textContent =
        'STB-Aの全階・全通り芯のビュー ' +
        result.addedIds.length +
        '件を自動作成しました。シートは必要に応じて生成してください。';
      return result;
    })();
    this.defaultViewsPromise = task;
    try {
      return await task;
    } finally {
      if (this.defaultViewsPromise === task) {
        this.defaultViewsPromise = null;
        this.defaultViewsSource = null;
        this.defaultViewsAbortController = null;
      }
    }
  }
  /** 現行STB-Aのビュー候補一覧（モデルA）。未読込なら空。 */
  currentViewCandidates() {
    const document = getState('models.documentA');
    if (document?.nodeType !== 9) return [];
    try {
      return listCadDrawingViews({ document, modelKey: 'A' });
    } catch {
      return [];
    }
  }
  /** Each cutout dialog gets its own STB-A choices, regardless of the active drawing. */
  refreshCutoutSelectors() {
    const candidates = this.currentViewCandidates();
    for (const [kind, type, field] of [
      ['plan', 'plan', 'story'],
      ['elevation', 'elevation', 'axis'],
    ]) {
      const select = this.el('cut-' + kind + '-' + field);
      if (!select) continue;
      const previous = select.value;
      select.replaceChildren();
      for (const candidate of candidates.filter((item) => item.type === type)) {
        const option = this.root.ownerDocument.createElement('option');
        option.value = candidate.key;
        option.textContent = candidate.label;
        select.append(option);
      }
      if ([...select.options].some((option) => option.value === previous)) select.value = previous;
      else if (!select.options.length) {
        const option = this.root.ownerDocument.createElement('option');
        option.value = '';
        option.textContent = 'STB-Aに対象がありません';
        select.append(option);
      }
      select.disabled = !candidates.some((item) => item.type === type);
    }
  }

  cutoutOptions(kind) {
    const prefix = 'cut-' + kind + '-';
    const key = this.el(prefix + (kind === 'plan' ? 'story' : 'axis')).value;
    const candidate = this.currentViewCandidates().find((entry) => entry.key === key);
    if (!candidate || candidate.type !== (kind === 'plan' ? 'plan' : 'elevation'))
      throw new Error(
        kind === 'plan' ? '切り出す階を指定してください。' : '切り出す通り芯を指定してください。',
      );
    const cutBoundsMm = parseOptionalCadCutBounds(
      (field) => this.el(prefix + field).value,
      '切り出し矩形はX最小・Y最小・X最大・Y最大の4座標を指定してください。',
    );
    const depth = kind === 'elevation' ? Number(this.el(prefix + 'depth').value) : null;
    if (kind === 'elevation' && (!Number.isFinite(depth) || depth <= 0))
      throw new Error('軸組図の奥行は正のmm値を指定してください。');
    return {
      candidate,
      depth,
      cutBoundsMm,
      name: this.el(prefix + 'name').value.trim() || candidate.label,
      createSeparate: this.el(prefix + 'separate').checked,
    };
  }

  /** Generate directly from the selected STB candidate, not the on-screen DrawingModel. */
  async registerCutout(kind) {
    if (!['plan', 'elevation'].includes(kind)) throw new Error('未対応の切り出し種別です。');
    const sourceDocument = getState('models.documentA');
    if (sourceDocument?.nodeType !== 9) throw new Error('STB-Aを先に読み込んでください。');
    const initialProject = this.project();
    const options = this.cutoutOptions(kind);
    const { candidate, depth, cutBoundsMm, name, createSeparate } = options;
    const prefix = 'cut-' + kind + '-';
    const fieldNames = [
      kind === 'plan' ? 'story' : 'axis',
      'name',
      'separate',
      'min-x',
      'min-y',
      'max-x',
      'max-y',
      ...(kind === 'elevation' ? ['depth'] : []),
    ];
    const inputs = () =>
      snapshotCadRegistrationFields(fieldNames, (field) => this.el(prefix + field));
    const originalInputs = inputs();
    this.cutoutAbortController?.abort();
    const controller = new globalThis.AbortController();
    this.cutoutAbortController = controller;
    const services = this.panel.services || this.panel.getServices?.();
    if (typeof services?.assertDrawingSourceCurrent !== 'function')
      throw new Error('STB-A改訂検証サービスがありません。');
    const scaleDenominator = this.panel.scaleDenominator();
    const display = this.panel.drawingDisplaySettings?.() ?? {};
    const assertUnchanged = () => {
      if (
        controller.signal.aborted ||
        this.cutoutAbortController !== controller ||
        this.project() !== initialProject ||
        getState('models.documentA') !== sourceDocument ||
        inputs() !== originalInputs ||
        this.panel.scaleDenominator() !== scaleDenominator
      )
        throw new Error(
          '切り出し中に対象・STB・プロジェクトが変更されました。再実行してください。',
        );
    };
    try {
      const drawing =
        kind === 'plan'
          ? await services.createDrawing({
              modelKey: 'A',
              view: storyView(parseStories(sourceDocument), candidate.storyId),
              signal: controller.signal,
            })
          : await services.createAxisElevationDrawing({
              modelKey: 'A',
              axisDirection: candidate.axisDirection,
              axisId: candidate.axisId,
              depth,
              signal: controller.signal,
            });
      assertUnchanged();
      await services.assertDrawingSourceCurrent({ source: drawing?.source });
      assertUnchanged();
      if (cutBoundsMm) cutDrawingModelToBounds(drawing, cutBoundsMm);
      const sha = drawing?.source?.modelRevision;
      if (drawing?.source?.modelKey !== 'A' || !/^[a-f0-9]{64}$/i.test(sha || ''))
        throw new Error('STB-Aの現行SHA-256付き図面が生成されませんでした。');
      const view =
        kind === 'plan'
          ? { type: 'plan', storyId: String(drawing.view.storyId) }
          : {
              type: 'elevation',
              axisDirection: drawing.view.axisDirection,
              axisId: String(drawing.view.axisId),
              depth: (drawing.view.upperBound - drawing.view.lowerBound) / 2,
            };
      const initializingBlank = Boolean(
        initialProject &&
        !initialProject.modelSlots.length &&
        !initialProject.drawingDocuments.length,
      );
      const project =
        (initializingBlank
          ? seedEmptyDrawingSheetProjectView({
              project: initialProject,
              drawing,
              view,
              drawingDocumentId: id('view'),
              name,
              scaleDenominator,
              display,
              cutBoundsMm,
            })
          : initialProject) ||
        normalizeDrawingProject({
          kind: DRAWING_PROJECT_KIND,
          schemaVersion: DRAWING_PROJECT_SCHEMA_VERSION,
          units: { model: 'mm', paper: 'mm' },
          projectId: id('project'),
          modelSlots: [
            {
              id: 'structure',
              currentRevisionId: sha,
              revisions: [{ id: sha, sha256: sha }],
            },
          ],
          bindings: [],
          drawingDocuments: [
            {
              id: id('view'),
              name,
              modelSlotId: 'structure',
              sourceRevisionId: sha,
              view: cutBoundsMm ? { ...view, cutBoundsMm } : view,
              sheet: { paper: 'A3', orientation: 'landscape', scaleDenominator },
              display,
              tagIntents: [],
              dimensionIntents: [],
              memberReviews: [],
              annotations: [],
            },
          ],
        });
      const result = registerCurrentSheetView({
        project,
        drawing,
        selectedView: candidate,
        id: id('view'),
        name,
        scaleDenominator,
        display,
        tagFamilyState: this.panel.sessionUi?.tagFamilyState,
        cutBoundsMm,
        createSeparate: Boolean(initialProject && !initializingBlank && createSeparate),
      });
      assertUnchanged();
      if (result.added || result.updated || !initialProject || initializingBlank) {
        const session = this.panel.sessionUi;
        session.closeOpenDrawingProject?.();
        session.loadedDrawingProject = result.project;
        session.drawingProjectId = result.project.projectId;
        this.invalidatePreviewSources();
      }
      this.render();
      const registeredList = this.root.querySelector('#pdf-overlay-registered-view-list');
      if (registeredList) registeredList.value = result.drawingDocumentId;
      this.el('view-catalog').value = result.drawingDocumentId;
      // Registration must also publish the selected cut in the main viewport.
      // Reuse navigation so sheet mode, saved bounds and view identity stay in sync.
      await this.openRegisteredView();
      this.el(prefix + 'status').textContent =
        result.added || !initialProject || initializingBlank
          ? name + ' を登録しました。シートへの配置が可能です。'
          : '同一条件のビューは登録済みです。別ビューにする場合は複製を選択してください。';
      return result;
    } finally {
      if (this.cutoutAbortController === controller) this.cutoutAbortController = null;
    }
  }

  /** A sheet can only reference an explicitly registered model view. */
  placeCatalogSelection() {
    return this.placeSelectedView();
  }
  /**
   * Register the currently generated drawing as a persistent ViewSpec.
   * On the ribbon View Generation path, bootstrap a project if none is open.
   * Existing projects remain the single source of truth and are never overwritten.
   */
  async registerCurrentView({ createProjectIfMissing = false } = {}) {
    const session = this.panel.sessionUi;
    const existingProject = this.project();
    const drawing = this.panel.drawing;
    const selectedView = this.panel.selectedCadDrawingView?.();
    if (!drawing || !selectedView) throw new Error('ビューを先に生成してください。');
    if (drawing.source?.modelKey !== 'A')
      throw new Error('ビュー登録にはSTB-Aから生成した伏図・軸組図が必要です。');
    if (!existingProject && !createProjectIfMissing)
      throw new Error('DrawingProjectを先に新規作成・読込してください。');
    const services = this.panel.services || this.panel.getServices?.();
    if (typeof services?.assertDrawingSourceCurrent !== 'function')
      throw new Error('STB-Aの現行改訂検証サービスがありません。');
    const sourceDocument = getState('models.documentA');
    // The legacy registration entry point shares the cutout dialog's
    // fail-closed rule: an edited form must not be committed after await.
    const inputs = () =>
      JSON.stringify([
        snapshotCadRegistrationFields(
          ['cut-min-x', 'cut-min-y', 'cut-max-x', 'cut-max-y', 'create-separate-view'],
          (field) => this.el(field),
        ),
        this.panel.e?.['pdf-overlay-view-name']?.value ?? null,
        this.panel.scaleDenominator(),
      ]);
    const originalInputs = inputs();
    await services.assertDrawingSourceCurrent({ source: drawing.source });
    if (
      this.project() !== existingProject ||
      this.panel.drawing !== drawing ||
      this.panel.selectedCadDrawingView?.()?.key !== selectedView.key ||
      getState('models.documentA') !== sourceDocument ||
      inputs() !== originalInputs
    )
      throw new Error('登録中にビュー・モデル・プロジェクトが変更されました。');

    const name =
      this.panel.e?.['pdf-overlay-view-name']?.value?.trim() ||
      selectedView.label ||
      '構造図ビュー';
    const scaleDenominator = this.panel.scaleDenominator();
    let project = existingProject;
    if (!project) {
      project =
        drawing.view.type === 'elevation'
          ? createInitialCadElevationProject({
              drawing,
              selectedView,
              projectId: id('project'),
              drawingDocumentId: id('view'),
              name,
              scaleDenominator,
            })
          : session.createDrawingProjectSnapshot();
    }
    const cutBoundsMm = parseOptionalCadCutBounds(
      (field) => this.el('cut-' + field)?.value,
      'モデルの切り出し範囲は4座標すべて入力してください。',
    );
    // Fail before touching project state if a cut is unsupported.
    if (cutBoundsMm) cutDrawingModelToBounds(drawing, cutBoundsMm);
    const seedingBlank = Boolean(project && !project.drawingDocuments.length);
    if (seedingBlank) {
      const view =
        drawing.view.type === 'plan'
          ? { type: 'plan', storyId: String(drawing.view.storyId) }
          : {
              type: 'elevation',
              axisDirection: drawing.view.axisDirection,
              axisId: String(drawing.view.axisId),
              depth: (drawing.view.upperBound - drawing.view.lowerBound) / 2,
            };
      project = seedEmptyDrawingSheetProjectView({
        project,
        drawing,
        view,
        drawingDocumentId: id('view'),
        name,
        scaleDenominator,
        display: this.panel.drawingDisplaySettings?.() ?? {},
        cutBoundsMm,
      });
    }
    const registered = registerCurrentSheetView({
      project,
      drawing,
      selectedView,
      id: id('view'),
      name,
      scaleDenominator,
      display: this.panel.drawingDisplaySettings?.() ?? {},
      tagFamilyState: this.panel.sessionUi?.tagFamilyState,
      cutBoundsMm,
      createSeparate: Boolean(!seedingBlank && this.el('create-separate-view')?.checked),
    });
    const initialized = !existingProject || seedingBlank;
    if (registered.added || registered.updated || initialized) {
      // The persistent multi-view project owns metadata; do not flatten it
      // through the legacy single-plan workspace snapshot.
      session.closeOpenDrawingProject?.();
      session.loadedDrawingProject = registered.project;
      session.drawingProjectId = registered.project.projectId;
      this.invalidatePreviewSources();
      if (!existingProject && drawing.view.type === 'plan')
        session.openDrawingProject?.(registered.project);
    }
    this.render();
    this.el('view-catalog').value = registered.drawingDocumentId;
    this.el('status').textContent =
      registered.added || initialized
        ? 'ビューを登録しました。シートへ配置できます。'
        : '同一改訂・同一ViewSpecのビューが登録済みです。';
    return { ...registered, initialized };
  }
  async saveSheetSvg() {
    const project = this.project(),
      sheetId = this.sheetId;
    const sources = this.previewSources;
    if (
      !project ||
      !sheetId ||
      !sources ||
      this.previewSheetId !== sheetId ||
      this.previewProject !== project
    )
      throw new Error('先に「シート内の全ビューを生成・確認」を実施してください。');
    const sourceDocument = getState('models.documentA');
    if (!sourceDocument || sourceDocument !== this.previewSourceDocument)
      throw new Error('STB-Aが変更されています。シートを再生成してください。');
    const services = this.panel.services || this.panel.getServices?.();
    if (typeof services?.assertDrawingSourceCurrent !== 'function')
      throw new Error('STB改訂検証サービスがありません。');
    for (const drawing of Object.values(sources))
      await services.assertDrawingSourceCurrent({ source: drawing.source });
    await this.assertListSourcesCurrent(services, project, sheetId);
    if (
      this.project() !== project ||
      this.sheetId !== sheetId ||
      this.previewSources !== sources ||
      getState('models.documentA') !== sourceDocument
    )
      throw new Error('図面保存中に図面・STB-Aが変更されました。再生成してください。');
    const xml = serializeDrawingSheetCompositeSvg({
      project,
      sheetId,
      drawingsById: sources,
      sourceDocument,
      listReferencesByPlacementId: this.previewListRefs,
      document: this.root.ownerDocument,
      selectedPlacementId:
        this.activeSheetPlacement === 'list' ? this.listPlacementId : this.placementId,
    });
    const sheet = project.drawingSheets.find((entry) => entry.id === sheetId);
    const number = (sheet.number || sheet.id).replace(/[^A-Za-z0-9_-]/g, '_');
    downloadBlob(
      new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }),
      'drawing-sheet-' + number + '.svg',
    );
    this.el('status').textContent = '確認済みシートを保存しました。';
  }
  async saveSheetDxf() {
    const project = this.project();
    const sheetId = this.sheetId;
    const sources = this.previewSources;
    if (
      !project ||
      !sheetId ||
      !sources ||
      this.previewSheetId !== sheetId ||
      this.previewProject !== project
    )
      throw new Error('先に「シート内の全ビューを生成・確認」を実施してください。');
    const sourceDocument = getState('models.documentA');
    if (!sourceDocument || sourceDocument !== this.previewSourceDocument)
      throw new Error('STB-Aが変更されています。シートを再生成してください。');
    const services = this.panel.services || this.panel.getServices?.();
    if (typeof services?.assertDrawingSourceCurrent !== 'function')
      throw new Error('STB改訂検証サービスがありません。');
    const assertBeforeSave = async () => {
      if (
        this.project() !== project ||
        this.sheetId !== sheetId ||
        this.previewSources !== sources ||
        getState('models.documentA') !== sourceDocument
      )
        throw new Error('DXF保存中に図面・STB-Aが変更されました。再生成してください。');
      for (const drawing of Object.values(sources)) {
        await services.assertDrawingSourceCurrent({ source: drawing.source });
        if (
          this.project() !== project ||
          this.sheetId !== sheetId ||
          this.previewSources !== sources ||
          getState('models.documentA') !== sourceDocument
        )
          throw new Error('DXF保存中に図面・STB-Aが変更されました。再生成してください。');
      }
      await this.assertListSourcesCurrent(services, project, sheetId);
    };
    await assertBeforeSave();
    const sheetPlans = createDrawingSheetRenderPlans({
      project,
      sheetId,
      drawingsById: sources,
      sourceDocument,
      listReferencesByPlacementId: this.previewListRefs,
    });
    const sheet = project.drawingSheets.find((entry) => entry.id === sheetId);
    const number = (sheet.number || sheet.id).replace(/[^A-Za-z0-9_-]/g, '_');
    await downloadDrawingSheetDxf(sheetPlans, 'drawing-sheet-' + number + '.dxf', null, {
      assertBeforeSave,
      layerSettings: project.dxfLayerSettings,
    });
    this.el('status').textContent =
      '全ビュー実図形の' + sheetPlans.paper + '紙面mm DXFを保存しました。';
  }
  /**
   * Output a chosen registered view or sheet without changing workspace selection.
   * A transient paper is used only for a standalone view and is never persisted.
   */
  /**
   * Export a registered view/sheet as DXF, using the same revision-checked
   * DrawingProject reconstruction as registered PDF export.
   */
  async exportRegisteredDxfTarget(target) {
    const project = this.project();
    if (!project) throw new Error('DXF出力対象のDrawingProjectがありません。');
    const sourceDocument = getState('models.documentA');
    if (sourceDocument?.nodeType !== 9) throw new Error('STB-Aを先に読み込んでください。');
    const [kind, ...parts] = String(target).split(':');
    const id = parts.join(':');
    const sheet =
      kind === 'sheet'
        ? project.drawingSheets.find((item) => item.id === id && item.kind !== 'section-list')
        : null;
    const view = kind === 'view' ? project.drawingDocuments.find((item) => item.id === id) : null;
    if (!sheet && !view) throw new Error('指定したDXF出力対象は存在しません。');
    if (sheet && !this.sheetOccupancy(sheet))
      throw new Error('シートに配置されたビューがありません。');

    this.panel.services ||= this.panel.getServices?.();
    const services = this.panel.services;
    if (typeof services?.assertDrawingSourceCurrent !== 'function')
      throw new Error('STB改訂検証サービスがありません。');
    let outputProject = project;
    let sheetId = sheet?.id;
    if (view) {
      const transient = createStandaloneViewPdfSheetProject(project, view.id);
      outputProject = transient.project;
      sheetId = transient.sheetId;
    }
    const selectionCurrent = () => {
      if (
        this.project() !== project ||
        getState('models.documentA') !== sourceDocument ||
        this.panel.e?.['pdf-overlay-export-target']?.value !== target
      )
        throw new Error(
          'DXF出力中に対象・DrawingProject・STB-Aが変更されました。再選択してください。',
        );
    };
    selectionCurrent();
    const outputSheet = outputProject.drawingSheets.find((item) => item.id === sheetId);
    const listRefs = await buildVerifiedListReferencesForSheet({
      sheet: outputSheet,
      sourceDocument,
      project: outputProject,
      Parser: this.root.ownerDocument.defaultView?.DOMParser,
    });
    const drawingsById = await collectDrawingSheetModels({
      project: outputProject,
      sheetId,
      services,
      planViewForStory: (storyId) => storyView(parseStories(sourceDocument), storyId),
      listReferencesByPlacementId: listRefs,
    });
    const assertBeforeSave = async () => {
      selectionCurrent();
      for (const drawing of Object.values(drawingsById)) {
        await services.assertDrawingSourceCurrent({ source: drawing.source });
        selectionCurrent();
      }
      for (const source of listRevisionSources(outputProject, outputSheet)) {
        await services.assertDrawingSourceCurrent({ source });
        selectionCurrent();
      }
    };
    await assertBeforeSave();
    const sheetPlans = createDrawingSheetRenderPlans({
      project: outputProject,
      sheetId,
      drawingsById,
      sourceDocument,
      listReferencesByPlacementId: listRefs,
    });
    selectionCurrent();
    const name = String(sheet ? sheet.number || sheet.id : view.name || view.id).replace(
      /[^A-Za-z0-9_-]/g,
      '_',
    );
    const filename = (sheet ? 'drawing-sheet-' : 'drawing-view-') + name + '.dxf';
    const result = await downloadDrawingSheetDxf(sheetPlans, filename, null, {
      assertBeforeSave,
      layerSettings: project.dxfLayerSettings,
    });
    return { filename, paper: sheetPlans.paper, diagnostics: result.diagnostics || [] };
  }

  async exportRegisteredPdfTarget(target) {
    const project = this.project();
    if (!project) throw new Error('PDF出力対象のDrawingProjectがありません。');
    const sourceDocument = getState('models.documentA');
    if (sourceDocument?.nodeType !== 9) throw new Error('STB-Aを先に読み込んでください。');
    const [kind, ...parts] = String(target).split(':');
    const id = parts.join(':');
    const sheet =
      kind === 'sheet'
        ? project.drawingSheets.find((item) => item.id === id && item.kind !== 'section-list')
        : null;
    const view = kind === 'view' ? project.drawingDocuments.find((item) => item.id === id) : null;
    if (!sheet && !view) throw new Error('指定したPDF出力対象は存在しません。');
    if (sheet && !this.sheetOccupancy(sheet))
      throw new Error('シートに配置されたビューがありません。');
    this.panel.services ||= this.panel.getServices?.();
    const services = this.panel.services;
    if (typeof services?.assertDrawingSourceCurrent !== 'function')
      throw new Error('STB改訂検証サービスがありません。');

    let outputProject = project;
    let sheetId = sheet?.id;
    if (view) {
      const transient = createStandaloneViewPdfSheetProject(project, view.id);
      outputProject = transient.project;
      sheetId = transient.sheetId;
    }
    const selectionCurrent = () => {
      if (
        this.project() !== project ||
        getState('models.documentA') !== sourceDocument ||
        this.panel.e?.['pdf-overlay-export-target']?.value !== target
      )
        throw new Error(
          'PDF出力中に対象・DrawingProject・STB-Aが変更されました。再選択してください。',
        );
    };
    selectionCurrent();
    const outputSheet = outputProject.drawingSheets.find((item) => item.id === sheetId);
    const listRefs = await buildVerifiedListReferencesForSheet({
      sheet: outputSheet,
      sourceDocument,
      project: outputProject,
      Parser: this.root.ownerDocument.defaultView?.DOMParser,
    });
    const drawingsById = await collectDrawingSheetModels({
      project: outputProject,
      sheetId,
      services,
      planViewForStory: (storyId) => storyView(parseStories(sourceDocument), storyId),
      listReferencesByPlacementId: listRefs,
    });
    selectionCurrent();
    const assertBeforeSave = async () => {
      selectionCurrent();
      for (const drawing of Object.values(drawingsById)) {
        await services.assertDrawingSourceCurrent({ source: drawing.source });
        selectionCurrent();
      }
      for (const source of listRevisionSources(outputProject, outputSheet)) {
        await services.assertDrawingSourceCurrent({ source });
        selectionCurrent();
      }
    };
    await assertBeforeSave();
    const name = String(sheet ? sheet.number || sheet.id : view.name || view.id).replace(
      /[^A-Za-z0-9_-]/g,
      '_',
    );
    return exportCompositeCadSheetPdf({
      project: outputProject,
      sheetId,
      drawingsById,
      sourceDocument,
      listReferencesByPlacementId: listRefs,
      document: this.root.ownerDocument,
      filename: (sheet ? 'drawing-sheet-' : 'drawing-view-') + name + '.pdf',
      fontFile:
        this.panel.e?.['pdf-overlay-vector-font']?.files?.[0] ||
        this.panel.sessionUi?.archivedPdfFontFile ||
        null,
      ...this.sheetPrintOptions(project),
      assertBeforeSave,
    });
  }

  async saveSheetPdf() {
    const project = this.project();
    const sheetId = this.sheetId;
    const sources = this.previewSources;
    if (
      !project ||
      !sheetId ||
      !sources ||
      this.previewSheetId !== sheetId ||
      this.previewProject !== project
    )
      throw new Error('先に「シート内の全ビューを生成・確認」を実施してください。');
    const sourceDocument = getState('models.documentA');
    if (!sourceDocument || sourceDocument !== this.previewSourceDocument)
      throw new Error('STB-Aが変更されています。シートを再生成してください。');
    const services = this.panel.services || this.panel.getServices?.();
    if (typeof services?.assertDrawingSourceCurrent !== 'function')
      throw new Error('STB改訂検証サービスがありません。');
    const assertBeforeSave = async () => {
      if (
        this.project() !== project ||
        this.sheetId !== sheetId ||
        this.previewSources !== sources ||
        getState('models.documentA') !== sourceDocument
      )
        throw new Error('PDF保存中に図面・STB-Aが変更されました。再生成してください。');
      for (const drawing of Object.values(sources))
        await services.assertDrawingSourceCurrent({ source: drawing.source });
      await this.assertListSourcesCurrent(services, project, sheetId);
      if (
        this.project() !== project ||
        this.sheetId !== sheetId ||
        this.previewSources !== sources ||
        getState('models.documentA') !== sourceDocument
      )
        throw new Error('PDF保存中に図面・STB-Aが変更されました。再生成してください。');
    };
    await assertBeforeSave();
    const sheet = project.drawingSheets.find((entry) => entry.id === sheetId);
    if (!sheet) throw new Error('保存するシートが存在しません。');
    const number = (sheet.number || sheet.id).replace(/[^A-Za-z0-9_-]/g, '_');
    const result = await exportCompositeCadSheetPdf({
      project,
      sheetId,
      drawingsById: sources,
      sourceDocument,
      listReferencesByPlacementId: this.previewListRefs,
      document: this.root.ownerDocument,
      filename: 'drawing-sheet-' + number + '.pdf',
      fontFile:
        this.panel.e?.['pdf-overlay-vector-font']?.files?.[0] ||
        this.panel.sessionUi?.archivedPdfFontFile ||
        null,
      ...this.sheetPrintOptions(project),
      assertBeforeSave,
    });
    this.el('status').textContent =
      '全ビュー実図形の' +
      sheet.paper +
      ' PDFを保存しました（' +
      result.views +
      'ビュー / ' +
      (result.mode === 'vector' ? 'ベクター' : 'ラスタ互換') +
      '）。';
    return result;
  }
  async saveAllSheetsZip() {
    const project = this.project();
    if (!(project?.drawingSheets ?? []).some((sheet) => sheet.kind !== 'section-list'))
      throw new Error('一括出力するDrawingProjectシートがありません。');
    const sourceDocument = getState('models.documentA');
    if (sourceDocument?.nodeType !== 9) throw new Error('STB-Aを先に読み込んでください。');
    if (this.batchAbortController) throw new Error('シートの一括出力が進行中です。');
    this.panel.services ||= this.panel.getServices?.();
    const services = this.panel.services;
    const controller = new globalThis.AbortController();
    this.batchAbortController = controller;
    const button = this.el('save-all-zip');
    button.disabled = true;
    try {
      const sourcesBySheetId = Object.create(null);
      const listReferencesBySheetId = Object.create(null);
      // Per-export only; the cache is discarded on completion, cancellation
      // or any failure and cannot cross STB/project loading boundaries.
      const drawingCache = new Map();
      const stories = parseStories(sourceDocument);
      const assertSameProject = () => {
        if (
          controller.signal.aborted ||
          this.project() !== project ||
          getState('models.documentA') !== sourceDocument
        )
          throw new Error('一括出力中にプロジェクトまたはSTB-Aが変更されました。');
      };
      // Do not publish partial exports: first generate and preflight every
      // placed ViewSpec. Each source is STB revision checked by the collector.
      const cadSheets = project.drawingSheets.filter((sheet) => sheet.kind !== 'section-list');
      for (const [index, sheet] of cadSheets.entries()) {
        assertSameProject();
        this.el('status').textContent =
          'シートを生成・照合中 ' + (index + 1) + '/' + cadSheets.length;
        listReferencesBySheetId[sheet.id] = await buildVerifiedListReferencesForSheet({
          sheet,
          sourceDocument,
          project,
          Parser: this.root.ownerDocument.defaultView?.DOMParser,
        });
        sourcesBySheetId[sheet.id] = await collectDrawingSheetModels({
          project,
          sheetId: sheet.id,
          listReferencesByPlacementId: listReferencesBySheetId[sheet.id],
          services,
          planViewForStory: (storyId) => storyView(stories, storyId),
          signal: controller.signal,
          drawingCache,
        });
        assertSameProject();
      }
      const assertBeforeSave = async () => {
        assertSameProject();
        // One STB-A canonical revision backs all generated plan/elevation
        // DrawingModels. Rehash each distinct source only once per gate call,
        // never across calls: every asynchronous PDF boundary must revalidate.
        const checked = new Set();
        for (const sources of Object.values(sourcesBySheetId)) {
          for (const drawing of Object.values(sources)) {
            const source = drawing?.source;
            if (source?.modelKey !== 'A' || !/^[a-f0-9]{64}$/i.test(source?.modelRevision || ''))
              throw new Error('一括出力のSTB-A改訂識別子が不正です。');
            const key = source.modelKey + ':' + source.modelRevision.toLowerCase();
            if (checked.has(key)) continue;
            await services.assertDrawingSourceCurrent({ source });
            assertSameProject();
            checked.add(key);
          }
        }
        for (const sheet of cadSheets) {
          await this.assertListSourcesCurrent(services, project, sheet.id);
          assertSameProject();
        }
        assertSameProject();
      };
      const archive = await buildCadSheetBatchArchive({
        project,
        sourcesBySheetId,
        sourceDocument,
        listReferencesBySheetId,
        document: this.root.ownerDocument,
        fontFile:
          this.panel.e?.['pdf-overlay-vector-font']?.files?.[0] ||
          this.panel.sessionUi?.archivedPdfFontFile ||
          null,
        ...this.sheetPrintOptions(project),
        assertBeforeSave,
      });
      await assertBeforeSave();
      downloadBlob(
        new Blob([archive.bytes], { type: 'application/zip' }),
        'drawing-sheets-' +
          String(project.projectId || 'project').replace(/[^A-Za-z0-9_-]/g, '_') +
          '.zip',
      );
      this.el('status').textContent =
        archive.sheets + 'シート / ' + archive.files.length + 'ファイルをZIP保存しました。';
      return archive;
    } finally {
      if (this.batchAbortController === controller) this.batchAbortController = null;
      button.disabled = false;
    }
  }
  el(suffix) {
    return this.root.querySelector('#pdf-overlay-sheet-' + suffix);
  }
  project() {
    return this.panel.sessionUi?.loadedDrawingProject ?? null;
  }
  sheet() {
    return (
      this.project()?.drawingSheets?.find(
        (s) => s.id === this.sheetId && s.kind !== 'section-list',
      ) ?? null
    );
  }
  placement() {
    return this.sheet()?.placements.find((p) => p.id === this.placementId) ?? null;
  }
  showCadCandidateProperties(candidate, options = {}, { reveal = true } = {}) {
    const shown = displayCadCandidateInfo(candidate, options, this.root.ownerDocument);
    if (shown && reveal) {
      try {
        floatingWindowManager.showWindow('component-info');
      } catch {
        // Isolated tests and early initialization do not own the floating window.
      }
    }
    return shown;
  }
  showCadProperties(selection, { reveal = true } = {}) {
    const shown = displayCadSelectionInfo(this.project(), selection, this.root.ownerDocument);
    if (shown && reveal) {
      try {
        floatingWindowManager.showWindow('component-info');
      } catch {
        // Optional in isolated tests or before floating windows are initialized.
      }
    }
    return shown;
  }

  commit(edit, { preservePreview = false } = {}) {
    const session = this.panel.sessionUi;
    const old = session.loadedDrawingProject;
    const keepPreview =
      preservePreview &&
      old &&
      this.previewProject === old &&
      this.previewSheetId === this.sheetId &&
      this.previewSourceDocument === getState('models.documentA');
    let project = old;
    if (!project) {
      // Backward-compatible first sheet creation. Once the project is open,
      // changing views or clearing the viewport never affects sheet editing.
      const drawing = this.panel.drawing;
      if (drawing?.source?.modelKey !== 'A' || !['plan', 'elevation'].includes(drawing?.view?.type))
        throw new Error('初回DrawingProject作成にはSTB-Aで生成したビューが必要です。');
      const selected = this.panel.selectedCadDrawingView?.();
      if (selected) {
        const same =
          selected.type === drawing.view.type &&
          (selected.type === 'plan'
            ? String(selected.storyId) === String(drawing.view.storyId)
            : selected.axisDirection === drawing.view.axisDirection &&
              String(selected.axisId) === String(drawing.view.axisId));
        if (!same) throw new Error('選択ビューと現在の図面が一致しません。');
      }
      project = session.createDrawingProjectSnapshot();
    }
    const updated = editDrawingSheetMetadata({
      project,
      edit,
      normalizeProject: normalizeDrawingProject,
    });
    const oldId = session.drawingProjectId;
    session.loadedDrawingProject = updated;
    session.drawingProjectId = updated.projectId;
    try {
      if (!old) session.openDrawingProject?.(updated);
      else if (old.drawingDocuments.length === 1 && old.drawingDocuments[0].view.type === 'plan')
        session.reviseOpenDrawingProject?.();
    } catch (error) {
      session.loadedDrawingProject = old;
      session.drawingProjectId = oldId;
      throw error;
    }
    // A placement-only edit can recompile RenderPlans from the same DrawingModels.
    // Keep the verified STB geometry, but never reuse it across source/project changes.
    if (keepPreview) this.previewProject = updated;
    this.render();
    return updated;
  }
  /** Current frame inputs as a sheet change: null removes the frame and title block. */
  frameFromInputs() {
    if (!this.el('frame-enabled').checked) return null;
    return {
      marginMm: this.sheet()?.frame?.marginMm,
      titleBlock: {
        projectName: this.el('frame-project').value,
        drawnBy: this.el('frame-drawn-by').value,
        date: this.el('frame-date').value,
      },
    };
  }
  /** Insert, replace or (with remove) delete the DXF layer setting of the selected layer id. */
  editDxfLayerSetting({ remove = false } = {}) {
    const layerId = this.el('dxf-layer-id').value;
    const name = this.el('dxf-layer-name').value.trim();
    const colorText = this.el('dxf-layer-color').value.trim();
    const lineType = this.el('dxf-layer-linetype').value;
    const entry = {
      layerId,
      ...(name ? { name } : {}),
      ...(colorText ? { colorIndex: Number(colorText) } : {}),
      ...(lineType ? { lineType } : {}),
    };
    const old = this.project();
    // Layer settings never change the sheet plans, so a confirmed preview stays valid.
    const previewWasCurrent = Boolean(old) && this.previewProject === old;
    const updated = this.commit((p) => {
      const rest = (p.dxfLayerSettings ?? []).filter((item) => item.layerId !== layerId);
      const next = remove ? rest : [...rest, entry];
      const base = { ...p };
      delete base.dxfLayerSettings;
      return next.length ? { ...base, dxfLayerSettings: next } : base;
    });
    if (previewWasCurrent) this.previewProject = updated;
    this.el('status').textContent = remove
      ? layerId + ' のDXFレイヤー設定を解除しました。'
      : layerId + ' のDXFレイヤー設定を保存しました。';
  }
  renderDxfLayerSettings() {
    const list = this.el('dxf-layer-list');
    if (!list) return;
    const doc = this.root.ownerDocument;
    list.replaceChildren(
      ...(this.project()?.dxfLayerSettings ?? []).map((item) => {
        const li = doc.createElement('li');
        li.textContent = [
          item.layerId,
          '→',
          item.name ?? '(名前そのまま)',
          item.colorIndex === undefined ? '' : '色' + item.colorIndex,
          item.lineType ? DXF_LAYER_LINE_TYPES[item.lineType].label : '',
        ]
          .filter(Boolean)
          .join(' ');
        return li;
      }),
    );
  }
  /** {mode, printOptions}: saved project print settings win over the output tab's controls. */
  sheetPrintOptions(project = this.project()) {
    const control = (id) => this.panel.e?.[id]?.value || undefined;
    return resolveSheetPrintOptions(project?.printSettings, {
      lineWidthPreset: control('pdf-overlay-print-line-width'),
      linePattern: control('pdf-overlay-print-line-pattern'),
      exportMode: control('pdf-overlay-export-mode'),
    });
  }
  /** Save the print setting controls; an empty choice clears that field. */
  savePrintSettings() {
    const next = {};
    for (const [key, id] of PRINT_SETTING_CONTROLS) {
      const value = this.el(id).value;
      if (value) next[key] = value;
    }
    const old = this.project();
    // Print settings never change the sheet plans, so a confirmed preview stays valid.
    const previewWasCurrent = Boolean(old) && this.previewProject === old;
    const updated = this.commit((p) => {
      const base = { ...p };
      delete base.printSettings;
      return Object.keys(next).length ? { ...base, printSettings: next } : base;
    });
    if (previewWasCurrent) this.previewProject = updated;
    this.el('status').textContent = Object.keys(next).length
      ? '印刷設定を保存しました。'
      : '印刷設定を解除しました（出力タブの設定を使います）。';
  }
  renderPrintSettings() {
    const settings = this.project()?.printSettings ?? {};
    for (const [key, id] of PRINT_SETTING_CONTROLS) {
      const select = this.el(id);
      if (select) select.value = settings[key] ?? '';
    }
  }
  bindEvents() {
    this.refreshCutoutSelectors();
    this.el('print-apply').addEventListener('click', () => {
      try {
        this.savePrintSettings();
      } catch (error) {
        this.el('status').textContent = error?.message || String(error);
      }
    });
    this.el('dxf-layer-apply').addEventListener('click', () => {
      try {
        this.editDxfLayerSetting();
      } catch (error) {
        this.el('status').textContent = error?.message || String(error);
      }
    });
    this.el('dxf-layer-remove').addEventListener('click', () => {
      try {
        this.editDxfLayerSetting({ remove: true });
      } catch (error) {
        this.el('status').textContent = error?.message || String(error);
      }
    });
    for (const kind of ['plan', 'elevation']) {
      this.el('cut-' + kind + '-register').addEventListener('click', async () => {
        const button = this.el('cut-' + kind + '-register');
        button.disabled = true;
        try {
          await this.registerCutout(kind);
        } catch (error) {
          this.el('cut-' + kind + '-status').textContent = error?.message || String(error);
        } finally {
          button.disabled = false;
        }
      });
    }
    const action = (fn) => () => {
      try {
        fn();
      } catch (error) {
        this.el('status').textContent = error?.message || String(error);
      }
    };
    const registeredViewList = this.root.querySelector('#pdf-overlay-registered-view-list');
    let pendingViewNavigation = null;
    const navigateToRegisteredView = () => {
      const viewId = registeredViewList?.value;
      const selected = this.project()?.drawingDocuments?.find((entry) => entry.id === viewId);
      if (!selected) return;
      this.showCadProperties({ viewId });
      this.closeRegisteredViewMenu();
      this.closeRegisteredViewEditor();
      // A click and a change can be fired by the same user selection. Never
      // start two asynchronous drawing builds for that single interaction.
      if (pendingViewNavigation?.viewId === viewId && !this.mainViewActive) return;
      const navigation = { viewId };
      pendingViewNavigation = navigation;
      this.openRegisteredView()
        .catch((error) => {
          if (pendingViewNavigation !== navigation) return;
          const status = this.root.querySelector('#pdf-overlay-registered-view-status');
          if (status) status.textContent = error?.message || String(error);
        })
        .finally(() => {
          if (pendingViewNavigation === navigation) pendingViewNavigation = null;
          this.syncCatalogTreeSelection();
        });
    };
    registeredViewList?.addEventListener('change', navigateToRegisteredView);
    registeredViewList?.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const option = event.target?.closest?.('option');
      if (option?.value) registeredViewList.value = option.value;
      this.showCadProperties({ viewId: registeredViewList.value });
      this.openRegisteredViewMenu(event.clientX, event.clientY);
    });
    registeredViewList?.addEventListener('keydown', (event) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault();
      const bounds = registeredViewList.getBoundingClientRect();
      this.openRegisteredViewMenu(bounds.left + 20, bounds.top + 20);
    });
    this.root.addEventListener('click', (event) => {
      if (!event.target.closest?.('#pdf-overlay-registered-view-menu'))
        this.closeRegisteredViewMenu();
    });
    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      this.closeRegisteredViewMenu();
      this.closeRegisteredViewEditor();
    });
    // A sheet can leave the previously selected view highlighted in the list.
    // Clicking that same option emits no change event, yet must open its view.
    registeredViewList?.addEventListener('click', () => {
      if (this.mainViewActive) navigateToRegisteredView();
    });
    registeredViewList?.addEventListener('keydown', (event) => {
      if (this.mainViewActive && event.key === 'Enter') navigateToRegisteredView();
    });
    const openSheetFromCatalog = () => {
      const value = this.el('list').value;
      const selection = resolveCadSheetCatalogSelection(this.project(), value);
      if (!selection) return;
      if (selection.kind !== 'sheet') {
        this.sectionSheetSelection = value;
        this.renderSectionListSummary(
          this.project()?.drawingSheets?.filter((sheet) => sheet.kind === 'section-list') ?? [],
        );
        openCadSectionListWindow(selection.listType);
        return;
      }
      this.sectionSheetSelection = '';
      this.sheetId = selection.sheetId;
      this.placementId = '';
      this.render();
      this.showSheetInMainView();
      this.showCadProperties({ sheetId: this.sheetId });
    };
    this.el('list').addEventListener('change', () => {
      openSheetFromCatalog();
      this.syncCatalogTreeSelection();
    });
    registeredViewList?.addEventListener('change', () => this.syncCatalogTreeSelection());
    const catalogTree = this.root.querySelector('#pdf-overlay-sheet-tree');
    catalogTree?.addEventListener('click', (event) => {
      const button = event.target.closest?.('.cad-tree-node');
      const { kind, value } = button?.dataset ?? {};
      if (kind === 'view' && registeredViewList) {
        registeredViewList.value = value;
        registeredViewList.dispatchEvent(new Event('change'));
      } else if (kind === 'sheet' || kind === 'list') {
        this.el('list').value = value;
        this.el('list').dispatchEvent(new Event('change'));
      }
    });
    catalogTree?.addEventListener('contextmenu', (event) => {
      const button = event.target.closest?.('.cad-tree-view');
      if (!button || !registeredViewList) return;
      event.preventDefault();
      registeredViewList.value = button.dataset.value;
      this.showCadProperties({ viewId: registeredViewList.value });
      this.openRegisteredViewMenu(event.clientX, event.clientY);
    });
    this.el('list').addEventListener('dblclick', () => {
      const selection = resolveCadSheetCatalogSelection(this.project(), this.el('list').value);
      // A double-click can re-open a list that was already selected by change.
      if (selection && selection.kind !== 'sheet') openSheetFromCatalog();
    });
    this.el('placements').addEventListener('change', () => {
      this.placementId = this.el('placements').value;
      this.activeSheetPlacement = 'view';
      this.showCadProperties({ sheetId: this.sheetId, placementId: this.placementId });
      this.renderPlacement();
      this.renderPreview();
      this.panel.renderOverlay?.();
    });
    this.el('edit-tag').addEventListener('change', () => {
      this.editTagId = this.el('edit-tag').value;
      this.renderViewportAnnotationEditor();
    });
    this.el('edit-dimension').addEventListener('change', () => {
      this.editDimensionId = this.el('edit-dimension').value;
      this.renderViewportAnnotationEditor();
    });
    this.el('tag-save').addEventListener(
      'click',
      action(() => this.saveViewportAnnotation('tag')),
    );
    this.el('dimension-save').addEventListener(
      'click',
      action(() => this.saveViewportAnnotation('dimension')),
    );
    this.el('list-type').addEventListener(
      'change',
      action(() => this.refreshListChoices()),
    );
    this.el('list-refresh').addEventListener(
      'click',
      action(() => this.refreshListChoices()),
    );
    this.el('list-placements').addEventListener('change', () => {
      this.listPlacementId = this.el('list-placements').value;
      this.activeSheetPlacement = 'list';
      this.showCadProperties({ sheetId: this.sheetId });
      this.renderListPlacements();
      this.renderViewportAnnotationEditor();
      this.renderPreview();
    });
    this.el('list-place').addEventListener('click', async () => {
      try {
        await this.placeListRegion();
      } catch (error) {
        this.el('status').textContent = error?.message || String(error);
      }
    });
    this.el('list-apply').addEventListener(
      'click',
      action(() => this.applyListPlacement()),
    );
    this.el('list-unplace').addEventListener(
      'click',
      action(() => {
        this.commit((p) => removeSectionListRegionFromSheet(p, this.sheetId, this.listPlacementId));
        this.listPlacementId = '';
        this.invalidatePreviewSources();
        this.render();
      }),
    );
    this.el('auto-place-views').addEventListener('click', async () => {
      try {
        await this.autoPlaceViews();
      } catch (error) {
        this.el('status').textContent = error?.message || String(error);
      }
    });
    this.el('rename-view').addEventListener('click', () => this.openRegisteredViewEditor());
    this.el('delete-view').addEventListener('click', () => {
      try {
        this.changeRegisteredView('delete');
      } catch (error) {
        this.showRegisteredViewMessage(error?.message || String(error));
      }
      this.closeRegisteredViewMenu();
    });
    this.root.querySelector('#pdf-overlay-registered-view-save')?.addEventListener('click', () => {
      try {
        this.changeRegisteredView('rename');
        this.closeRegisteredViewEditor();
      } catch (error) {
        this.showRegisteredViewMessage(error?.message || String(error));
      }
    });
    this.root
      .querySelector('#pdf-overlay-registered-view-cancel')
      ?.addEventListener('click', () => this.closeRegisteredViewEditor());
    this.el('edit-view-name').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.root.querySelector('#pdf-overlay-registered-view-save')?.click();
    });
    this.el('preview-generate').addEventListener('click', async () => {
      // An explicit retry supersedes the automatic preview task.
      this.mainViewSeq++;
      globalThis.clearTimeout(this.mainViewGeneration?.slowTimer);
      this.mainViewGeneration = null;
      const context = this.mainViewContext();
      // A retry from the active sheet must use the same progress watchdog as
      // automatic generation; otherwise the second hung attempt is invisible.
      if (this.mainViewActive) {
        this.invalidatePreviewSources();
        this.refreshMainView();
        return;
      }
      try {
        await this.generateSheetPreview();
        if (this.mainViewActive && this.matchesMainViewContext(context))
          this.panel.renderOverlay?.();
      } catch (error) {
        if (this.mainViewActive && this.matchesMainViewContext(context)) {
          this.mainViewError = { ...context, message: error?.message || String(error) };
          this.panel.renderOverlay?.();
        }
        this.el('status').textContent = error?.message || String(error);
      }
    });
    bindCadSheetExportActions({
      getButton: (suffix) => this.el(suffix),
      runExport: (method) => this[method](),
      onError: (message) => {
        this.el('status').textContent = message;
      },
    });
    this.el('create').addEventListener(
      'click',
      action(() => {
        // The editing fields mirror the selected sheet. Do not accidentally
        // reuse its number/name when the user clicks New without changing them.
        const selected = this.sheet();
        const enteredNumber = this.el('number').value;
        const enteredName = this.el('name').value;
        this.createBlankSheet({
          number: enteredNumber === selected?.number ? '' : enteredNumber,
          name: enteredName === selected?.name ? '' : enteredName,
          orientation: this.el('orientation').value,
          paper: this.el('paper').value,
        });
      }),
    );
    this.el('rename').addEventListener(
      'click',
      action(() => {
        this.commit((p) =>
          updateDrawingSheet(p, this.sheetId, {
            number: this.el('number').value,
            name: this.el('name').value,
            orientation: this.el('orientation').value,
            paper: this.el('paper').value,
            frame: this.frameFromInputs(),
          }),
        );
      }),
    );
    this.el('delete').addEventListener(
      'click',
      action(() => {
        if (
          !this.project()?.drawingDocuments.length &&
          (this.project()?.drawingSheets?.length ?? 0) <= 1
        )
          throw new Error('モデル未登録プロジェクトでは最後のシートを削除できません。');
        this.commit((p) => removeDrawingSheet(p, this.sheetId));
        this.sheetId = '';
        this.render();
      }),
    );
    const placeFromCatalog = async () => {
      try {
        await this.placeCatalogSelection();
      } catch (error) {
        this.el('status').textContent = error?.message || String(error);
      }
    };
    this.el('place').addEventListener('click', placeFromCatalog);
    this.el('view-catalog').addEventListener('dblclick', placeFromCatalog);
    this.el('view-catalog').addEventListener('change', () => {
      this.showCadProperties({ viewId: this.el('view-catalog').value });
    });
    this.el('unplace').addEventListener(
      'click',
      action(() => {
        this.commit((p) => removeDrawingSheetPlacement(p, this.sheetId, this.placementId));
        this.placementId = '';
        this.render();
      }),
    );
    this.el('apply').addEventListener(
      'click',
      action(() => {
        const original = this.placement();
        if (!original) throw new Error('配置を選択してください。');
        const changes = Object.fromEntries(
          Object.entries(fieldMap).map(([key, field]) => [key, Number(this.el(field).value)]),
        );
        this.commit(
          (p) =>
            updateDrawingSheetPlacement(
              p,
              this.sheetId,
              this.placementId,
              preserveSheetViewportContentCenter(original, changes),
            ),
          { preservePreview: true },
        );
        this.panel.renderOverlay?.();
      }),
    );
    this.render();
  }
  /** Place an existing view without generating/registering a new model cut. */
  placeSelectedView() {
    const sheet = this.sheet();
    if (!sheet) throw new Error('シートを選択してください。');
    const current = this.project();
    if (!current) throw new Error('DrawingProjectを先に作成してください。');
    const drawingId = this.el('view-catalog').value;
    const target = current.drawingDocuments.find((d) => d.id === drawingId);
    if (!target) throw new Error('登録済みのビューを選択してください。');
    const slot = current.modelSlots.find((s) => s.id === target.modelSlotId);
    if (!slot || slot.currentRevisionId !== target.sourceRevisionId)
      throw new Error('配置するビューのSTB改訂が古いため配置できません。');
    const placementId = id('placement');
    const origin = findSheetPlacementOrigin(sheet);
    this.commit((p) =>
      placeDrawingDocumentOnSheet(p, this.sheetId, {
        id: placementId,
        drawingDocumentId: drawingId,
        ...origin,
        widthMm: 180,
        heightMm: 120,
        scaleDenominator: target.sheet?.scaleDenominator ?? 200,
        rotationDeg: 0,
      }),
    );
    this.placementId = placementId;
    this.render();
    this.showCadProperties({ sheetId: this.sheetId, placementId });
  }
  /**
   * 「シート生成」: STB・ビュー未読込でも空のシート（既定A3）を作成する。
   * 既存のビューとシートには触れず、番号・名称は連番で自動付与する。
   */
  createBlankSheet({
    number: requestedNumber,
    name: requestedName,
    orientation: requestedOrientation,
    paper: requestedPaper,
  } = {}) {
    const existingProject = this.project();
    const sheets = existingProject?.drawingSheets ?? [];
    const used = new Set(sheets.map((sheet) => sheet.number));
    let serial = sheets.length + 1;
    while (used.has('S-' + String(serial).padStart(2, '0'))) serial++;
    const number = requestedNumber || 'S-' + String(serial).padStart(2, '0');
    const newId = id('sheet');
    const newSheet = {
      id: newId,
      number,
      name: requestedName || 'シート' + serial,
      paper: requestedPaper || this.el('paper').value || 'A3',
      orientation: requestedOrientation || this.el('orientation').value || 'landscape',
      placements: [],
    };
    if (existingProject) {
      this.commit((p) => addDrawingSheet(p, newSheet));
    } else {
      const project = createEmptyDrawingSheetProject({ projectId: id('project'), sheet: newSheet });
      const session = this.panel.sessionUi;
      session.loadedDrawingProject = project;
      session.drawingProjectId = project.projectId;
    }
    this.sheetId = newId;
    this.sectionSheetSelection = '';
    this.placementId = '';
    this.invalidatePreviewSources();
    this.render();
    this.panel.updatePdfFeatureAvailability?.();
    this.el('status').textContent =
      '空のシート ' +
      number +
      ' を生成しました。「配置するビュー」をダブルクリックして配置してください。';
    this.showSheetInMainView();
    this.showCadProperties({ sheetId: this.sheetId }, { reveal: false });
    try {
      floatingWindowManager.showWindow(SHEET_PLACEMENT_WINDOW_ID);
    } catch {
      // ウィンドウ未構築の環境（単体テスト等）ではシート生成のみ行う。
    }
    return newId;
  }
  /** 選択中シートをメインビューへ表示する。実図形が未生成なら生成して再描画する。 */
  showSheetInMainView() {
    if (!this.sheet()) return;
    this.mainViewActive = true;
    this.refreshMainView();
  }
  /** メインビューをシート表示から図面表示へ戻す（呼び出し側が図面を再描画する）。 */
  leaveMainViewSheet() {
    if (!this.mainViewActive) return;
    this.mainViewActive = false;
    this.panel.updatePdfFeatureAvailability?.();
    this.mainViewSeq++;
    globalThis.clearTimeout(this.mainViewGeneration?.slowTimer);
    // Re-entering while the old task is pending must start a fresh generation
    // rather than reusing a task whose repaint was invalidated on leaving.
    this.mainViewGeneration = null;
  }
  isMainViewSheetCurrent() {
    const project = this.project();
    const sheet = this.sheet();
    return Boolean(
      sheet &&
      this.previewSources &&
      this.previewSheetId === sheet.id &&
      this.previewProject === project &&
      this.previewSourceDocument === getState('models.documentA'),
    );
  }
  sheetOccupancy(sheet = this.sheet()) {
    return (sheet?.placements.length ?? 0) + (sheet?.listPlacements?.length ?? 0);
  }
  /** Capture object identities, not only IDs: an edited project is a different source. */
  mainViewContext() {
    return {
      project: this.project(),
      sheetId: this.sheetId,
      source: getState('models.documentA'),
    };
  }
  matchesMainViewContext(context) {
    return (
      context &&
      context.project === this.project() &&
      context.sheetId === this.sheetId &&
      context.source === getState('models.documentA')
    );
  }
  markMainViewGenerationSlow(generation) {
    if (
      !this.mainViewActive ||
      this.mainViewGeneration !== generation ||
      !this.matchesMainViewContext(generation)
    )
      return;
    generation.slow = true;
    // The button is normally disabled while generating. Restore an explicit
    // retry path if an upstream producer never settles; retry aborts the old task.
    this.el('preview-generate').disabled = false;
    const seconds = Math.floor((Date.now() - generation.startedAt) / 1000);
    this.el('status').textContent =
      'シート図形生成が継続中（' +
      seconds +
      '秒経過）: ' +
      describeSheetGenerationStage(generation.progress) +
      '。長時間変わらない場合は「シート出力」から再生成してください。';
    this.panel.renderOverlay?.();
  }
  refreshMainView() {
    if (!this.mainViewActive) return;
    const sheet = this.sheet();
    if (!sheet) {
      this.mainViewActive = false;
      this.panel.renderOverlay?.();
      return;
    }
    if (!this.sheetOccupancy(sheet) || this.isMainViewSheetCurrent()) {
      this.panel.renderOverlay?.();
      return;
    }
    // Never abort/restart the same sheet merely because the viewport rerendered.
    const context = this.mainViewContext();
    if (
      this.matchesMainViewContext(this.mainViewGeneration) &&
      this.mainViewGeneration?.project === context.project
    ) {
      this.panel.renderOverlay?.();
      return;
    }
    // Fail visibly, without a tight retry loop. Project/sheet/source changes
    // naturally permit a new attempt; the output window offers an explicit retry.
    if (this.matchesMainViewContext(this.mainViewError)) {
      this.panel.renderOverlay?.();
      return;
    }
    const seq = ++this.mainViewSeq;
    globalThis.clearTimeout(this.mainViewGeneration?.slowTimer);
    const generation = {
      ...context,
      progress: { phase: 'initializing' },
      startedAt: Date.now(),
      slow: false,
      slowTimer: null,
    };
    this.mainViewGeneration = generation;
    // An advisory, non-failing watchdog: a large STB must not be aborted solely
    // because a producer or revision check exceeds an arbitrary time budget.
    generation.slowTimer = globalThis.setTimeout(
      () => this.markMainViewGenerationSlow(generation),
      20000,
    );
    generation.slowTimer?.unref?.();
    // The paper/frame is usable immediately while generating its real vectors.
    this.panel.renderOverlay?.();
    this.generateSheetPreview({
      onProgress: (progress) => {
        if (
          this.mainViewGeneration !== generation ||
          !this.mainViewActive ||
          !this.matchesMainViewContext(generation)
        )
          return;
        generation.progress = progress;
        if (generation.slow) this.markMainViewGenerationSlow(generation);
        else
          this.el('status').textContent =
            'シート図形生成中: ' + describeSheetGenerationStage(progress);
      },
    })
      .catch((error) => {
        if (
          seq !== this.mainViewSeq ||
          this.mainViewGeneration !== generation ||
          !this.mainViewActive ||
          !this.matchesMainViewContext(generation)
        )
          return;
        const stage = describeSheetGenerationStage(generation.progress);
        const elapsedSeconds = Math.floor((Date.now() - generation.startedAt) / 1000);
        this.mainViewError = { ...generation, message: error?.message || String(error) };
        this.el('status').textContent =
          'シート図形生成失敗（' +
          stage +
          '、' +
          elapsedSeconds +
          '秒）: ' +
          this.mainViewError.message +
          '。シート出力から再生成できます。';
      })
      .finally(() => {
        globalThis.clearTimeout(generation.slowTimer);
        // Clear the pending state before painting: a finished attempt must
        // never leave the fallback sheet showing "generating" indefinitely.
        if (this.mainViewGeneration === generation) this.mainViewGeneration = null;
        if (
          seq === this.mainViewSeq &&
          this.mainViewActive &&
          this.matchesMainViewContext(generation)
        )
          this.panel.renderOverlay?.();
      });
  }
  /**
   * メインビュー用のシートSVGを layer へ描く。描画したとき用紙サイズ(mm)を返し、
   * シート表示でなければ null（呼び出し側が通常の図面を描く）。
   */
  renderMainViewSheet(layer, pxPerMm) {
    if (!this.mainViewActive) return null;
    const project = this.project();
    const sheet = this.sheet();
    if (!sheet) return null;
    const { widthMm, heightMm } = getSheetPaperSize(sheet.paper, sheet.orientation);
    const doc = layer.ownerDocument;
    let svg = null;
    if (this.sheetOccupancy(sheet) && this.isMainViewSheetCurrent() && this.previewSources) {
      try {
        svg = renderDrawingSheetCompositeSvg({
          project,
          sheetId: sheet.id,
          drawingsById: this.previewSources,
          sourceDocument: this.previewSourceDocument,
          listReferencesByPlacementId: this.previewListRefs,
          document: doc,
          selectedPlacementId:
            this.activeSheetPlacement === 'list' ? this.listPlacementId : this.placementId,
          onTagPointerDown: (event, context) => this.handleViewportTagPointerDown(event, context),
          onPersistedDimensionSelect: (event, context) =>
            this.handleViewportDimensionSelect(event, context),
        });
        this.el('status').textContent =
          'シート ' +
          sheet.number +
          ' ' +
          sheet.name +
          ' を表示中（' +
          this.sheetOccupancy(sheet) +
          '件）。図面に戻るにはビュー一覧でビューを選ぶか「図面生成」を押します。' +
          describeSheetLayoutWarnings(sheet);
      } catch (error) {
        this.invalidatePreviewSources();
        this.mainViewError = {
          ...this.mainViewContext(),
          message: error?.message || String(error),
        };
        svg = null;
        this.el('status').textContent = '再生成が必要です: ' + this.mainViewError.message;
      }
    }
    svg ||= this.buildSheetFrameSvg(doc, sheet, widthMm, heightMm);
    const workspace = getDrawingSheetWorkspaceBounds(sheet);
    svg.setAttribute('width', String(workspace.widthMm * pxPerMm));
    svg.setAttribute('height', String(workspace.heightMm * pxPerMm));
    this.bindViewportSelection(svg);
    layer.append(svg);
    return { widthMm: workspace.widthMm, heightMm: workspace.heightMm };
  }
  /** 用紙と配置枠だけのSVG（実図形の生成前・失敗時の表示）。 */
  buildSheetFrameSvg(doc, sheet, widthMm, heightMm) {
    const ns = 'http://www.w3.org/2000/svg';
    const elem = (name, attrs, text) => {
      const node = doc.createElementNS(ns, name);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const workspace = getDrawingSheetWorkspaceBounds(sheet);
    const svg = elem('svg', {
      viewBox: [workspace.minX, workspace.minY, workspace.widthMm, workspace.heightMm].join(' '),
      role: 'img',
      'aria-label': sheet.paper + 'シート ' + sheet.number,
    });
    svg.append(
      elem('rect', {
        x: 0,
        y: 0,
        width: widthMm,
        height: heightMm,
        fill: '#fff',
        stroke: '#777',
      }),
    );
    for (const p of [...sheet.placements, ...(sheet.listPlacements ?? [])]) {
      svg.append(
        elem('rect', {
          x: p.xMm,
          y: p.yMm,
          width: p.widthMm,
          height: p.heightMm,
          fill: 'none',
          stroke: '#2465a5',
          'stroke-dasharray': '4 2',
          ...(p.drawingDocumentId
            ? { 'data-placement-id': p.id, 'pointer-events': 'all', cursor: 'move' }
            : {}),
        }),
      );
    }
    const failed = this.matchesMainViewContext(this.mainViewError);
    const note = !this.sheetOccupancy(sheet)
      ? '空のシートです。「ビュー配置」からビューを配置してください。'
      : failed
        ? '図形生成に失敗しました。「シート出力」から再生成してください。'
        : this.matchesMainViewContext(this.mainViewGeneration)
          ? this.mainViewGeneration.slow
            ? '図形生成が長時間継続中: ' +
              describeSheetGenerationStage(this.mainViewGeneration.progress)
            : '図形を生成中…（' +
              describeSheetGenerationStage(this.mainViewGeneration.progress) +
              '）'
          : '図形は未生成です。「シート出力」から生成・確認してください。';
    svg.append(
      elem('text', { x: 12, y: 16, 'font-size': 8, fill: failed ? '#a33' : '#555' }, note),
    );
    if (failed)
      svg.append(
        elem(
          'text',
          { x: 12, y: 25, 'font-size': 6, fill: '#a33' },
          this.mainViewError.message.slice(0, 100),
        ),
      );
    return svg;
  }
  /** 現行STB-Aの断面リストから、選択した種別の階・符号の候補を読み込む。 */
  refreshListChoices() {
    const listType = this.el('list-type').value;
    const sourceDocument = getState('models.documentA');
    if (listType === 'slab') return this.refreshSlabListChoices(sourceDocument);
    const grid = extractCadListGrid(listType, sourceDocument);
    this.listGrid = { listType, grid, sourceDocument };
    const symbolLabel = this.root.querySelector('label[for="pdf-overlay-sheet-list-symbols"]');
    if (symbolLabel) symbolLabel.textContent = '符号（複数選択可）';
    this.el('list-symbols').setAttribute('aria-label', 'リスト領域の符号');
    const fill = (select, items) => {
      select.replaceChildren();
      for (const item of items) {
        const option = this.root.ownerDocument.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        select.append(option);
      }
    };
    fill(
      this.el('list-stories'),
      grid.stories.map((story) => ({ value: story.id, label: story.name || story.id })),
    );
    fill(
      this.el('list-symbols'),
      grid.symbols.map((symbol) => ({ value: symbol, label: symbol })),
    );
    this.el('status').textContent =
      CAD_SHEET_LIST_TYPES[listType].label +
      ': ' +
      grid.stories.length +
      '階 / ' +
      grid.symbols.length +
      '符号を読み込みました。';
  }
  /** スラブ専用シート内の各領域を独立候補とする。旧ページの先頭領域のみを採用しない。 */
  savedSlabRegions(project = this.project()) {
    return listCurrentSlabListRegions(project);
  }
  refreshSlabListChoices(sourceDocument) {
    if (sourceDocument?.nodeType !== 9) throw new Error('STB-Aを先に読み込んでください。');
    this.listGrid = { listType: 'slab', grid: null, sourceDocument };
    this.el('list-stories').replaceChildren();
    const select = this.el('list-symbols');
    select.replaceChildren();
    const regions = this.savedSlabRegions();
    for (const { sheet, region, index } of regions) {
      const option = this.root.ownerDocument.createElement('option');
      // JSON tuple avoids ambiguous separators in user-defined sheet/region IDs.
      option.value = JSON.stringify([sheet.id, region.id]);
      option.textContent =
        sheet.number +
        ' ' +
        sheet.name +
        ' / ' +
        (region.label || '領域 ' + (index + 1)) +
        ' (' +
        (sheet.viewSpec.zone === 'END' ? '端部' : '中央') +
        ' / ' +
        region.symbols.length +
        '行)';
      select.append(option);
    }
    const symbolLabel = this.root.querySelector('label[for="pdf-overlay-sheet-list-symbols"]');
    if (symbolLabel) symbolLabel.textContent = '保存済みスラブリスト領域（1件選択）';
    select.setAttribute('aria-label', '保存済みスラブリスト領域');
    this.el('status').textContent = regions.length
      ? 'スラブリスト: 配置可能な領域 ' + regions.length + '件（1領域ずつ配置）。'
      : '保存済みのスラブリスト領域がありません。スラブリストからシート登録してください。';
  }
  async placeSlabRegion(sheet) {
    const selected = [...this.el('list-symbols').options].filter((option) => option.selected);
    if (selected.length !== 1) throw new Error('配置するスラブリストの領域を1つ選択してください。');
    const project = this.project();
    // Selection must still correspond to a current-revision region at commit time.
    const choice = this.savedSlabRegions(project).find(
      ({ sheet: source, region }) => JSON.stringify([source.id, region.id]) === selected[0].value,
    );
    if (!choice)
      throw new Error('保存済みスラブリストの領域が見つかりません。再読込してください。');
    const { sheet: source, region } = choice;
    const slot = project.modelSlots.find((entry) => entry.id === source.modelSlotId);
    const scaleDenominator = Number(this.el('list-scale').value);
    if (!(scaleDenominator >= 1)) throw new Error('縮尺は1以上で指定してください。');
    const base = {
      id: id('list'),
      listType: 'slab',
      modelSlotId: slot.id,
      sourceRevisionId: source.sourceRevisionId,
      storyIds: [...region.storyIds],
      symbols: [...region.symbols],
      zone: source.viewSpec.zone,
      label: region.label,
      autoLabel: region.autoLabel,
      scaleDenominator,
    };
    const size = await measureVerifiedSlabRegion({
      placement: base,
      project,
      sourceDocument: this.listGrid.sourceDocument,
      scaleDenominator,
      Parser: this.root.ownerDocument.defaultView?.DOMParser,
    });
    if (
      this.project() !== project ||
      this.sheetId !== sheet.id ||
      this.listGrid?.sourceDocument !== getState('models.documentA') ||
      this.el('list-type').value !== 'slab' ||
      this.el('list-symbols').selectedOptions.length !== 1 ||
      this.el('list-symbols').selectedOptions[0]?.value !== selected[0].value ||
      Number(this.el('list-scale').value) !== scaleDenominator
    )
      throw new Error('配置計測中に対象リストまたはシートが変更されました。再選択してください。');
    const widthMm = Math.ceil(size.widthMm + 2);
    const heightMm = Math.ceil(size.heightMm + 2);
    // A wide A3 slab list may exceed the preferred 10 mm inset but still fit
    // inside the paper. Never persist the generic overflow fallback off-sheet.
    const origin = findContainedSlabListOrigin(sheet, widthMm, heightMm);
    this.commit((p) =>
      placeSectionListRegionOnSheet(p, this.sheetId, { ...base, ...origin, widthMm, heightMm }),
    );
    this.listPlacementId = base.id;
    this.activeSheetPlacement = 'list';
    this.invalidatePreviewSources();
    this.render();
  }
  /** 選択した階×符号をリスト領域としてシートに配置する（図形は出力時に現行STB-Aから再生成）。 */
  async placeListRegion() {
    const sheet = this.sheet();
    if (!sheet) throw new Error('シートを選択してください。');
    const listType = this.el('list-type').value;
    if (this.listGrid?.listType !== listType) this.refreshListChoices();
    if (this.listGrid.sourceDocument !== getState('models.documentA'))
      throw new Error('STB-Aが変更されました。階・符号を再読込してください。');
    if (listType === 'slab') return this.placeSlabRegion(sheet);
    const selected = (select) =>
      [...select.options].filter((option) => option.selected).map((option) => option.value);
    const storyIds = selected(this.el('list-stories'));
    const symbols = selected(this.el('list-symbols'));
    if (!storyIds.length || !symbols.length)
      throw new Error('リスト領域の階と符号を1つ以上選択してください。');
    const initialProject = this.project();
    if (!initialProject) throw new Error('リストの配置先シートがありません。');
    // Empty paper-only projects can receive an STB-backed list without an
    // unrelated drawing document. Bind the model slot to a verified revision.
    let project = initialProject;
    if (!project.modelSlots.length) {
      const Serializer =
        this.root.ownerDocument.defaultView?.XMLSerializer ?? globalThis.XMLSerializer;
      if (!Serializer) throw new Error('STBのXML改訂を検証できません。');
      const xml = new Serializer().serializeToString(this.listGrid.sourceDocument);
      const hash = await sha256(new TextEncoder().encode(xml));
      const services = this.panel.services || this.panel.getServices?.();
      if (typeof services?.assertDrawingSourceCurrent !== 'function')
        throw new Error('STB改訂検証サービスがありません。');
      await services.assertDrawingSourceCurrent({
        source: { modelKey: 'A', modelRevision: hash },
      });
      if (
        this.project() !== initialProject ||
        this.sheetId !== sheet.id ||
        this.listGrid.sourceDocument !== getState('models.documentA')
      )
        throw new Error('配置中にSTBまたはシートが変更されました。再実行してください。');
      project = {
        ...project,
        modelSlots: [
          { id: 'structure', currentRevisionId: hash, revisions: [{ id: hash, sha256: hash }] },
        ],
      };
    }
    const currentViewSlotId = project.drawingDocuments[0]?.modelSlotId;
    const slot =
      project.modelSlots.find((entry) => entry.id === currentViewSlotId) ??
      (project.modelSlots.length === 1 ? project.modelSlots[0] : null);
    if (!slot) throw new Error('STB-Aのモデルスロットを一意に特定できません。');
    const scaleDenominator = Number(this.el('list-scale').value);
    if (!(scaleDenominator >= 1)) throw new Error('縮尺は1以上で指定してください。');
    const size = measureListRegion({
      listType,
      gridData: this.listGrid.grid,
      storyIds,
      symbols,
      scaleDenominator,
    });
    // 文字の外接分として余白を足し、1mm単位に切り上げる。
    const widthMm = Math.ceil(size.widthMm + 2);
    const heightMm = Math.ceil(size.heightMm + 2);
    const origin = findSheetPlacementOrigin(sheet, widthMm, heightMm);
    const placementId = id('list');
    this.commit((p) =>
      placeSectionListRegionOnSheet(
        project === initialProject ? p : { ...p, modelSlots: project.modelSlots },
        this.sheetId,
        {
          id: placementId,
          listType,
          modelSlotId: slot.id,
          sourceRevisionId: slot.currentRevisionId,
          storyIds,
          symbols,
          ...origin,
          widthMm,
          heightMm,
          scaleDenominator,
        },
      ),
    );
    this.listPlacementId = placementId;
    this.activeSheetPlacement = 'list';
    this.invalidatePreviewSources();
    this.render();
  }
  /** 読込済みの断面リストがあれば階名、なければ階IDを返す。 */
  listStoryName(listType, storyId) {
    const stories = this.listGrid?.listType === listType ? this.listGrid.grid.stories : [];
    return stories.find((story) => story.id === storyId)?.name || storyId;
  }
  renderListPlacements() {
    const sheet = this.sheet();
    const select = this.el('list-placements');
    select.replaceChildren();
    for (const p of sheet?.listPlacements ?? []) {
      const option = this.root.ownerDocument.createElement('option');
      option.value = p.id;
      option.textContent =
        CAD_SHEET_LIST_TYPES[p.listType].label +
        ' ' +
        (p.listType === 'slab'
          ? p.symbols.length + '行 / ' + (p.zone === 'END' ? '端部' : '中央')
          : p.symbols.join(',') +
            ' / ' +
            p.storyIds.map((storyId) => this.listStoryName(p.listType, storyId)).join(',')) +
        ' 1/' +
        p.scaleDenominator;
      select.append(option);
    }
    if (!sheet?.listPlacements?.some((p) => p.id === this.listPlacementId))
      this.listPlacementId = sheet?.listPlacements?.[0]?.id ?? '';
    select.value = this.listPlacementId;
    const placement = sheet?.listPlacements?.find((p) => p.id === this.listPlacementId);
    for (const [key, field] of [
      ['xMm', 'x'],
      ['yMm', 'y'],
      ['widthMm', 'width'],
      ['heightMm', 'height'],
      ['scaleDenominator', 'scale'],
      ['label', 'label'],
    ]) {
      const input = this.el('list-edit-' + field);
      input.disabled = !placement;
      input.value = placement ? String(placement[key] ?? '') : '';
    }
    this.el('list-unplace').disabled = !placement;
    this.el('list-apply').disabled = !placement;
    this.el('list-place').disabled = !sheet;
    this.el('list-target').textContent = sheet
      ? '配置先: ' + sheet.number + ' ' + sheet.name
      : '先に「シート生成」で配置先を作成してください。';
  }
  /** Edit only paper-space attributes; retain list source revision and row selection. */
  applyListPlacement() {
    if (!this.listPlacementId) throw new Error('更新するリストを選択してください。');
    const fields = [
      ['xMm', 'x'],
      ['yMm', 'y'],
      ['widthMm', 'width'],
      ['heightMm', 'height'],
      ['scaleDenominator', 'scale'],
    ];
    const changes = Object.fromEntries(
      fields.map(([key, field]) => [key, Number(this.el('list-edit-' + field).value)]),
    );
    changes.label = this.el('list-edit-label').value;
    if (
      fields.some(
        ([key, field]) =>
          !this.el('list-edit-' + field).value.trim() || !Number.isFinite(changes[key]),
      )
    )
      throw new Error('リストの位置・寸法・縮尺には有限な数値を入力してください。');
    this.commit((p) =>
      updateSectionListRegionOnSheet(p, this.sheetId, this.listPlacementId, changes),
    );
    this.activeSheetPlacement = 'list';
    this.invalidatePreviewSources();
    this.render();
    this.el('status').textContent =
      'リストの配置位置・縮尺を更新しました。シート出力で再生成してください。';
  }
  /** 旧リスト専用シートのレイアウト全ページを通常シートの配置へ変換する（#565 P3）。 */
  createConvertButton(sheet) {
    const button = this.root.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary btn-sm cad-section-list-convert';
    button.dataset.layoutId = sheet.layoutId;
    button.textContent = '専用シートを通常シート化（別紙）';
    button.title =
      '専用リストの全ページをそれぞれ別の通常シートへ置換します。既存の伏図・軸組図シートへ追加する場合は「リスト配置」を使用してください。';
    button.addEventListener('click', () => {
      try {
        const confirm = this.root.ownerDocument.defaultView?.confirm;
        if (typeof confirm !== 'function') throw new Error('変換確認ダイアログが利用できません。');
        if (
          !confirm.call(
            this.root.ownerDocument.defaultView,
            '専用リストシートを独立した通常シートへ置換します（既存シートへの追加ではありません）。元に戻せません。事前にプロジェクトを保存しましたか？',
          )
        )
          return;
        this.commit((p) => convertSectionListLayoutToCadSheets(p, sheet.layoutId));
        this.el('status').textContent = '専用リストを独立した通常シートへ変換しました。';
      } catch (error) {
        this.el('status').textContent = error?.message || String(error);
      }
    });
    return button;
  }
  /** 旧リストの通常シート変換はナビゲーションとは分離した明示操作とする。 */
  renderSectionListSummary(sectionSheets) {
    const box = this.el('section-list-summary');
    const doc = this.root.ownerDocument;
    box.replaceChildren();
    const selectedId = this.sectionSheetSelection.startsWith('section:')
      ? this.sectionSheetSelection.slice('section:'.length)
      : '';
    const selected = sectionSheets.find((sheet) => sheet.id === selectedId);
    const title = doc.createElement('div');
    title.textContent = selected
      ? `選択中: ${selected.number} [${CAD_SECTION_LIST_WINDOWS[selected.listType]?.label ?? '断面リスト'}]。リスト編集は専用ウィンドウから行います。`
      : sectionSheets.length
        ? '一覧で断面リストを選択すると編集ウィンドウを開きます。'
        : 'リスト未登録：一覧の「新規」から作成できます。';
    box.append(title);
    if (selected?.listType === 'slab') {
      const hint = doc.createElement('p');
      hint.textContent =
        '伏図・軸組図のある既存シートに追加するには、先に通常シートを選択し、シートの「リスト配置」で保存済みスラブ領域を選んでください。';
      box.append(hint);
    }
    // A multi-page legacy layout can have several sheet entries, but
    // conversion is a single destructive operation on the chosen layout.
    // Do not expose a separate conversion button for every stored layout.
    if (selected?.layoutId) box.append(this.createConvertButton(selected));
  }
  render() {
    const project = this.project();
    // Auto-created/edited ViewSpecs also publish DrawingProject ownership. The
    // explicit unload button must follow these paths, not just ZIP/JSON status.
    this.panel.sessionUi?.syncDrawingProjectUnloadControl?.();
    const sheets = (project?.drawingSheets ?? []).filter((sheet) => sheet.kind !== 'section-list');
    const sectionSheets = (project?.drawingSheets ?? []).filter(
      (sheet) => sheet.kind === 'section-list',
    );
    this.renderDxfLayerSettings();
    this.renderPrintSettings();
    const select = this.el('list');
    select.replaceChildren();
    const normalGroup = this.root.ownerDocument.createElement('optgroup');
    normalGroup.label = '通常シート';
    for (const sheet of sheets) {
      const option = this.root.ownerDocument.createElement('option');
      option.value = sheet.id;
      option.textContent = sheet.number + ' ' + sheet.name;
      normalGroup.append(option);
    }
    select.append(normalGroup);
    const listGroup = this.root.ownerDocument.createElement('optgroup');
    listGroup.label = '断面リスト';
    for (const [type, def] of Object.entries(CAD_SECTION_LIST_WINDOWS)) {
      const matching = sectionSheets.filter((sheet) => sheet.listType === type);
      if (!matching.length) {
        const option = this.root.ownerDocument.createElement('option');
        option.value = 'new-list:' + type;
        option.textContent = def.label + '（新規）';
        listGroup.append(option);
      }
      for (const sheet of matching) {
        const option = this.root.ownerDocument.createElement('option');
        option.value = 'section:' + sheet.id;
        option.textContent =
          sheet.number +
          ' [' +
          def.label +
          '] ' +
          describeSheetPaper('A3', sheet.orientation) +
          ' 1/' +
          sheet.scaleDenominator;
        listGroup.append(option);
      }
    }
    select.append(listGroup);
    if (!sheets.some((s) => s.id === this.sheetId)) this.sheetId = sheets[0]?.id ?? '';
    const selected = this.sectionSheetSelection || this.sheetId;
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
    else {
      this.sectionSheetSelection = '';
      select.value = this.sheetId;
    }
    // Reconcile stale list IDs before exposing legacy conversion controls.
    this.renderSectionListSummary(sectionSheets);
    const sheet = this.sheet();
    if (sheet) {
      this.el('number').value = sheet.number;
      this.el('name').value = sheet.name;
      this.el('orientation').value = sheet.orientation;
      this.el('paper').value = sheet.paper;
      this.el('frame-enabled').checked = Boolean(sheet.frame);
      this.el('frame-project').value = sheet.frame?.titleBlock.projectName ?? '';
      this.el('frame-drawn-by').value = sheet.frame?.titleBlock.drawnBy ?? '';
      this.el('frame-date').value = sheet.frame?.titleBlock.date ?? '';
    }
    const viewCatalog = this.el('view-catalog');
    const previousViewId = viewCatalog.value;
    viewCatalog.replaceChildren();
    const placedHere = new Set((sheet?.placements ?? []).map((p) => p.drawingDocumentId));
    const placedAnywhere = new Set(
      (project?.drawingSheets ?? [])
        .filter((entry) => entry.kind !== 'section-list')
        .flatMap((entry) => entry.placements.map((p) => p.drawingDocumentId)),
    );
    const addOption = (value, text) => {
      const option = this.root.ownerDocument.createElement('option');
      option.value = value;
      option.textContent = text;
      viewCatalog.append(option);
    };
    for (const view of project?.drawingDocuments ?? []) {
      const state = placedHere.has(view.id)
        ? '✓このシートに配置済み'
        : placedAnywhere.has(view.id)
          ? '他のシートに配置済み'
          : '登録済み・未配置';
      addOption(view.id, describeSheetView(view) + '  [' + state + ']');
    }
    viewCatalog.value = [...viewCatalog.options].some((o) => o.value === previousViewId)
      ? previousViewId
      : (viewCatalog.options[0]?.value ?? '');
    this.renderViewListMarks(project);
    this.renderPlacementGuide(project, sheet);
    const placements = this.el('placements');
    placements.replaceChildren();
    for (const p of sheet?.placements ?? []) {
      const option = this.root.ownerDocument.createElement('option');
      option.value = p.id;
      const view = project.drawingDocuments.find((d) => d.id === p.drawingDocumentId);
      option.textContent = describeSheetView(view);
      placements.append(option);
    }
    if (!sheet?.placements.some((p) => p.id === this.placementId))
      this.placementId = sheet?.placements[0]?.id ?? '';
    placements.value = this.placementId;
    this.renderPlacement();
    this.renderListPlacements();
    this.renderPreview();
    this.refreshMainView();
    if (this.activeSheetPlacement === 'list' && this.listPlacementId && this.sheet()) {
      // A section-list placement is not a drawing viewport. Clear its stale context.
      const info = this.root.ownerDocument.getElementById('element-info-content');
      if (info?.dataset.infoOwner === 'cad')
        this.showCadProperties({ sheetId: this.sheetId }, { reveal: false });
    } else {
      refreshCadSelectionInfo(project, this.root.ownerDocument);
    }
  }
  /**
   * Open a persistent view through the existing model-view drawing pipeline.
   * Paper/placement settings are never used to select the model cut.
   */
  async openRegisteredView() {
    const list = this.root.querySelector('#pdf-overlay-registered-view-list');
    const project = this.project();
    const registered = project?.drawingDocuments?.find((entry) => entry.id === list?.value);
    if (!registered) throw new Error('登録済みビューを選択してください。');
    const slot = project.modelSlots?.find((entry) => entry.id === registered.modelSlotId);
    if (!slot || slot.currentRevisionId !== registered.sourceRevisionId)
      throw new Error('ビューのSTB改訂が現在のプロジェクトと一致しません。');
    const panel = this.panel;
    panel.e['pdf-overlay-model'].value = 'A';
    panel.refreshModelAndStories();
    const candidate = panel.cadDrawingViews.find(
      (item) =>
        item.type === registered.view.type &&
        (item.type === 'plan'
          ? String(item.storyId) === String(registered.view.storyId)
          : item.type === 'elevation' &&
            item.axisDirection === registered.view.axisDirection &&
            String(item.axisId) === String(registered.view.axisId)),
    );
    if (!candidate)
      throw new Error('現行STBに該当する切り出し候補がありません。モデルを確認してください。');
    panel.e['pdf-overlay-view-list'].value = candidate.key;
    if (candidate.type === 'plan') panel.e['pdf-overlay-story'].value = candidate.storyId;
    if (candidate.type === 'elevation') {
      panel.e['pdf-overlay-elevation-depth'].disabled = false;
      panel.e['pdf-overlay-elevation-depth'].value = String(registered.view.depth);
    }
    panel.syncCadCutoutControls?.(candidate);
    this.leaveMainViewSheet();
    panel.e['pdf-overlay-display-mode'].value = 'stb';
    panel.invalidateDrawing('登録ビューのモデル切り出しを生成します。');
    const sequence = panel.cadViewImportSequence;
    const sourceDocument = getState('models.documentA');
    await panel.buildDrawing();
    // A newer user selection, source import or project edit invalidates this
    // asynchronous result; never publish an old cut over the newer drawing.
    if (
      this.mainViewActive ||
      panel.cadViewImportSequence !== sequence ||
      this.project() !== project ||
      list.value !== registered.id ||
      getState('models.documentA') !== sourceDocument ||
      panel.e['pdf-overlay-model'].value !== 'A' ||
      panel.selectedCadDrawingView?.()?.key !== candidate.key ||
      // Hidden depth is an input to the elevation cut, not a sheet-owned value.
      // An edit while buildDrawing is pending must not publish the saved view.
      (candidate.type === 'elevation' &&
        String(panel.e['pdf-overlay-elevation-depth'].value) !== String(registered.view.depth))
    )
      return null;
    // The current STB and generated model must reproduce the saved ViewSpec.
    // Do not present a similarly named cut from another revision as this view.
    resolveCurrentSheetDrawingDocument(this.project(), panel.drawing, candidate, registered.id);
    if (registered.view.cutBoundsMm) {
      panel.drawing = cutDrawingModelToBounds(panel.drawing, registered.view.cutBoundsMm);
      panel.renderOverlay?.();
    }
    // Copies and bounded views may share a story/axis. Keep the explicit
    // registered ID for ZIP export instead of resolving that shared view again.
    const session = panel.sessionUi;
    session.activeDrawingDocumentId = registered.id;
    // A new or changed ViewSpec closes the previous Document Control grant
    // before regenerating its DrawingModel. Reopen only after the async
    // generated view passed the stale-source, identity and cutout checks.
    // Without this, the visible CAD view has no registered descriptor and
    // the SHA-verified multi-view STB-A direct commit remains disabled.
    session.openDrawingProject?.(project);
    this.showCadProperties({ viewId: registered.id }, { reveal: false });
    const status = this.root.querySelector('#pdf-overlay-registered-view-status');
    if (status) status.textContent = describeSheetView(registered) + ' を表示しています。';
  }
  /**
   * A ViewSpec is edited in the view registry, not through any sheet placement.
   * Reject all invalid operations before publishing an updated project.
   */
  showRegisteredViewMessage(message) {
    const status = this.root.querySelector('#pdf-overlay-registered-view-status');
    if (status) status.textContent = message;
  }
  closeRegisteredViewMenu() {
    const menu = this.root.querySelector('#pdf-overlay-registered-view-menu');
    if (menu) menu.hidden = true;
  }
  closeRegisteredViewEditor() {
    const editor = this.root.querySelector('#pdf-overlay-registered-view-editor');
    if (editor) editor.hidden = true;
  }
  openRegisteredViewMenu(clientX = 0, clientY = 0) {
    const list = this.root.querySelector('#pdf-overlay-registered-view-list');
    const menu = this.root.querySelector('#pdf-overlay-registered-view-menu');
    const browser = this.root.querySelector('#pdf-overlay-view-browser');
    if (
      !menu ||
      !browser ||
      !this.project()?.drawingDocuments?.some((view) => view.id === list?.value)
    ) {
      this.closeRegisteredViewMenu();
      return;
    }
    this.closeRegisteredViewEditor();
    menu.hidden = false;
    const rect = browser.getBoundingClientRect();
    // Keep the menu inside the resizable floating view-list window.
    menu.style.left =
      Math.max(0, Math.min(clientX - rect.left, browser.clientWidth - menu.offsetWidth)) + 'px';
    menu.style.top =
      Math.max(0, Math.min(clientY - rect.top, browser.clientHeight - menu.offsetHeight)) + 'px';
    menu.querySelector('button')?.focus();
  }
  openRegisteredViewEditor() {
    const list = this.root.querySelector('#pdf-overlay-registered-view-list');
    const selected = this.project()?.drawingDocuments?.find((entry) => entry.id === list?.value);
    this.closeRegisteredViewMenu();
    if (!selected) {
      this.showRegisteredViewMessage('ビュー一覧から編集対象を選択してください。');
      return;
    }
    const editor = this.root.querySelector('#pdf-overlay-registered-view-editor');
    editor.hidden = false;
    const input = this.el('edit-view-name');
    input.value = selected.name ?? '';
    input.focus();
    input.select();
  }
  changeRegisteredView(operation) {
    const session = this.panel.sessionUi;
    const project = this.project();
    const list = this.root.querySelector('#pdf-overlay-registered-view-list');
    const viewId = list?.value;
    if (!project || !project.drawingDocuments.some((entry) => entry.id === viewId))
      throw new Error('ビュー一覧から編集対象を選択してください。');
    const updated =
      operation === 'rename'
        ? renameSheetDrawingView(project, viewId, this.el('edit-view-name').value.trim())
        : operation === 'delete'
          ? removeSheetDrawingView(project, viewId)
          : null;
    if (!updated) throw new Error('未対応のビュー編集操作です。');
    session.closeOpenDrawingProject?.();
    session.loadedDrawingProject = updated;
    session.drawingProjectId = updated.projectId;
    if (operation === 'delete' && session.activeDrawingDocumentId === viewId)
      session.activeDrawingDocumentId = null;
    this.invalidatePreviewSources();
    this.render();
    if (operation === 'delete') {
      list.selectedIndex = -1;
      this.closeRegisteredViewEditor();
    }
    const message =
      operation === 'rename' ? 'ビュー名を変更しました。' : '未配置のビューを削除しました。';
    this.el('status').textContent = message;
    this.showRegisteredViewMessage(message);
    return updated;
  }
  /** Render only persistent ViewSpecs in the left navigation. */
  renderViewListMarks(project = this.project()) {
    this.refreshCutoutSelectors();
    const list = this.root.querySelector('#pdf-overlay-registered-view-list');
    if (!list) return;
    const status = this.root.querySelector('#pdf-overlay-registered-view-status');
    const previous = list.value;
    list.replaceChildren();
    for (const view of project?.drawingDocuments ?? []) {
      const option = this.root.ownerDocument.createElement('option');
      option.value = view.id;
      option.textContent = describeSheetView(view);
      list.append(option);
    }
    if ([...list.options].some((option) => option.value === previous)) list.value = previous;
    else list.selectedIndex = -1;
    const selected = project?.drawingDocuments?.find((entry) => entry.id === list.value);
    if (!selected) {
      this.closeRegisteredViewMenu();
      this.closeRegisteredViewEditor();
    }
    if (status)
      status.textContent = list.options.length
        ? list.options.length + '件の登録済みビュー（選択すると切り出して表示）'
        : '登録済みビューなし。リボン「伏図切り出し」「軸組図切り出し」から登録してください。';
    this.renderCatalogTree(project);
  }
  /** シートを親、配置済みビューを子とするツリー。選択値は隠しselectが保持する。 */
  renderCatalogTree(project = this.project()) {
    const tree = this.root.querySelector('#pdf-overlay-sheet-tree');
    if (!tree) return;
    const doc = this.root.ownerDocument;
    const node = (kind, value, text, children = []) => {
      const item = doc.createElement('li');
      item.setAttribute('role', 'treeitem');
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'cad-tree-node cad-tree-' + kind;
      button.dataset.kind = kind;
      if (value) button.dataset.value = value;
      button.textContent = text;
      item.append(button);
      if (children.length) {
        item.setAttribute('aria-expanded', 'true');
        const group = doc.createElement('ul');
        group.setAttribute('role', 'group');
        group.append(...children);
        item.append(group);
      }
      return item;
    };
    const views = project?.drawingDocuments ?? [];
    const allSheets = project?.drawingSheets ?? [];
    const sheets = allSheets.filter((sheet) => sheet.kind !== 'section-list');
    const placed = new Set(
      sheets.flatMap((sheet) => sheet.placements.map((p) => p.drawingDocumentId)),
    );
    const viewNode = (view) => node('view', view.id, describeSheetView(view));
    const sheetNodes = sheets.map((sheet) =>
      node(
        'sheet',
        sheet.id,
        sheet.number + ' - ' + sheet.name,
        sheet.placements
          .map((p) => views.find((view) => view.id === p.drawingDocumentId))
          .filter(Boolean)
          .map(viewNode),
      ),
    );
    const listNodes = [];
    for (const [type, def] of Object.entries(CAD_SECTION_LIST_WINDOWS)) {
      const matching = allSheets.filter((s) => s.kind === 'section-list' && s.listType === type);
      if (!matching.length)
        listNodes.push(node('list', 'new-list:' + type, def.label + '（新規）'));
      for (const sheet of matching)
        listNodes.push(node('list', 'section:' + sheet.id, sheet.number + ' [' + def.label + ']'));
    }
    const unplaced = views.filter((view) => !placed.has(view.id)).map(viewNode);
    const root = [
      node('group', '', 'シート', sheetNodes),
      node('group', '', '断面リスト', listNodes),
    ];
    if (unplaced.length) root.push(node('group', '', '未配置のビュー', unplaced));
    const list = doc.createElement('ul');
    list.setAttribute('role', 'group');
    list.append(...root);
    tree.replaceChildren(list);
    this.syncCatalogTreeSelection();
  }
  syncCatalogTreeSelection() {
    const tree = this.root.querySelector('#pdf-overlay-sheet-tree');
    if (!tree) return;
    const sheetValue = this.el('list').value;
    const viewValue = this.root.querySelector('#pdf-overlay-registered-view-list')?.value;
    for (const button of tree.querySelectorAll('.cad-tree-node')) {
      const { kind, value } = button.dataset;
      const selected =
        kind === 'view'
          ? !this.mainViewActive && value === viewValue
          : kind === 'list'
            ? value === sheetValue && this.sectionSheetSelection === value
            : kind === 'sheet' && value === sheetValue && this.mainViewActive;
      button.classList.toggle('selected', Boolean(selected));
      button.parentElement.setAttribute('aria-selected', String(Boolean(selected)));
    }
  }
  /** 配置先シートと次の操作を示し、操作できない状態のボタンを無効にする。 */
  renderPlacementGuide(project, sheet) {
    this.el('target').textContent = sheet
      ? '配置先: ' +
        sheet.number +
        ' ' +
        sheet.name +
        '（ビュー' +
        sheet.placements.length +
        '件）。別シートはシート一覧で選択'
      : project
        ? '配置先のシートがありません。リボンの「シート生成」を押してください。'
        : 'リボンの「シート生成」で空シートを作成してください。';
    this.el('place').disabled = !sheet || !this.el('view-catalog').options.length;
    this.el('view-catalog').disabled = !this.el('view-catalog').options.length;
    this.el('auto-place-views').disabled = !project || !project.drawingDocuments.length;
  }

  /** Resolve a placed view by its stable id; paper metadata never owns tags. */
  viewportDocument() {
    if (this.activeSheetPlacement !== 'view' || !this.project() || !this.placement()) return null;
    return resolveSheetViewportDocument(this.project(), this.sheetId, this.placementId).document;
  }
  renderViewportAnnotationEditor() {
    const tagSelect = this.el('edit-tag');
    const dimensionSelect = this.el('edit-dimension');
    if (!tagSelect || !dimensionSelect) return;
    let document = null;
    let editorError = '';
    try {
      document = this.viewportDocument();
    } catch (error) {
      // A stale or missing view must disable editing, not break sheet rendering.
      editorError = error?.message || String(error);
    }
    const tags = document?.tagIntents || [];
    const dimensions = document?.dimensionIntents || [];
    if (!tags.some((item) => item.id === this.editTagId)) this.editTagId = tags[0]?.id || '';
    if (!dimensions.some((item) => item.id === this.editDimensionId))
      this.editDimensionId = dimensions[0]?.id || '';
    const populate = (select, items, selected, label) => {
      select.replaceChildren();
      for (const item of items) {
        const option = this.root.ownerDocument.createElement('option');
        option.value = item.id;
        option.textContent = label(item);
        select.append(option);
      }
      select.value = selected;
      select.disabled = !items.length;
    };
    populate(tagSelect, tags, this.editTagId, (tag) => tag.id + ' / ' + tag.template.id);
    populate(
      dimensionSelect,
      dimensions,
      this.editDimensionId,
      (dimension) => dimension.id + ' / ' + dimension.familyId,
    );
    const tag = tags.find((item) => item.id === this.editTagId);
    const position =
      tag?.placement?.mode === 'follow-member'
        ? tag.placement.offset.xy
        : tag?.placement?.origin?.xy;
    for (const [field, value] of [
      ['tag-x', position?.[0]],
      ['tag-y', position?.[1]],
      ['tag-angle', tag?.placement.orientation.rotationDeg],
    ]) {
      this.el(field).disabled = !tag;
      this.el(field).value = value == null ? '' : String(value);
    }
    this.el('tag-leader').disabled = !tag;
    this.el('tag-leader').checked = tag?.placement.leader || false;
    this.el('tag-save').disabled = !tag;
    const dimension = dimensions.find((item) => item.id === this.editDimensionId);
    this.el('dimension-offset').disabled = !dimension;
    this.el('dimension-offset').value = dimension ? String(dimension.placement.offsetModelMm) : '';
    this.el('dimension-save').disabled = !dimension;
    this.el('annotation-status').textContent = editorError
      ? '編集不可: ' + editorError
      : document
        ? '編集対象: ' +
          document.name +
          ' / タグ' +
          tags.length +
          '件 / 保存寸法' +
          dimensions.length +
          '件'
        : '編集するビューポートを選択してください。';
  }
  /** View-intent transaction: the sheet metadata editor intentionally rejects such edits. */
  applyViewportAnnotationEdit(edit) {
    const session = this.panel.sessionUi;
    const old = session.loadedDrawingProject;
    if (!old) throw new Error('DrawingProjectがありません。');
    const hadPreview = this.isMainViewSheetCurrent();
    const updated = edit(old);
    if (
      updated?.projectId !== old.projectId ||
      JSON.stringify(updated.modelSlots) !== JSON.stringify(old.modelSlots) ||
      JSON.stringify(updated.bindings) !== JSON.stringify(old.bindings) ||
      JSON.stringify(updated.drawingSheets) !== JSON.stringify(old.drawingSheets)
    ) {
      throw new Error('注記の編集でビュー以外の正本データが変更されました。');
    }
    session.loadedDrawingProject = updated;
    try {
      session.reviseOpenDrawingProject?.();
      if (hadPreview) this.previewProject = updated;
      this.render();
      this.panel.renderOverlay?.();
    } catch (error) {
      session.loadedDrawingProject = old;
      if (hadPreview) this.previewProject = old;
      throw error;
    }
    return updated;
  }
  saveViewportAnnotation(kind) {
    if (this.activeSheetPlacement !== 'view')
      throw new Error('リスト選択中はビューの注記を編集できません。');
    const intentId = kind === 'tag' ? this.editTagId : this.editDimensionId;
    if (!intentId) throw new Error('編集する注記を選択してください。');
    const readNumber = (field) => {
      const raw = this.el(field).value.trim();
      if (!raw) throw new Error('座標・寸法には数値を入力してください。');
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error('有限な数値を入力してください。');
      return value;
    };
    const changes =
      kind === 'tag'
        ? {
            xy: [readNumber('tag-x'), readNumber('tag-y')],
            rotationDeg: readNumber('tag-angle'),
            leader: this.el('tag-leader').checked,
          }
        : { offsetModelMm: readNumber('dimension-offset') };
    this.applyViewportAnnotationEdit((project) =>
      editSheetViewportAnnotation({
        project,
        sheetId: this.sheetId,
        placementId: this.placementId,
        kind,
        intentId,
        changes,
      }),
    );
    this.el('annotation-status').textContent = 'ビューの注記を保存しました。';
  }
  /** Tag pointer events are scoped to the selected view and STB revision. */
  handleViewportTagPointerDown(event, context) {
    const project = this.project();
    const { placementId, drawingDocumentId, modelToPaper, elementKey, template } = context;
    const sheetId = this.sheetId;
    let document;
    try {
      ({ document } = resolveSheetViewportDocument(project, sheetId, placementId));
      if (document.id !== drawingDocumentId) throw new Error('ビューポート参照が不整合です。');
    } catch (error) {
      this.el('annotation-status').textContent = '編集不可: ' + (error?.message || String(error));
      return;
    }
    const ref = context.ref;
    if (!ref?.elementType || ref.elementId == null)
      throw new Error('タグの部材参照が不正です: ' + String(elementKey));
    const binding = project.bindings.find(
      (entry) =>
        entry.modelSlotId === document.modelSlotId &&
        entry.revisions.some(
          (revision) =>
            revision.sourceRevisionId === document.sourceRevisionId &&
            revision.sourceRef?.elementType === ref.elementType &&
            String(revision.sourceRef?.elementId) === String(ref.elementId) &&
            (revision.sourceRef.guid == null || revision.sourceRef.guid === ref.guid),
        ),
    );
    const tag = document.tagIntents.find(
      (item) =>
        item.id === context.placement?.instanceId &&
        item.binding.entityId === binding?.entityId &&
        item.template.id === template.id &&
        item.template.version === template.version,
    );
    if (!tag) {
      this.el('annotation-status').textContent =
        'このタグはビューへ保存されていません。保存タグのみ移動できます。';
      return;
    }
    this.placementId = placementId;
    this.activeSheetPlacement = 'view';
    this.editTagId = tag.id;
    this.el('placements').value = placementId;
    this.renderPlacement();
    const viewport = event.target.closest?.('.cad-sheet-composite-view');
    let matrix;
    try {
      matrix = viewport?.getScreenCTM?.();
      screenDeltaToSheetMm(matrix, 0, 0);
    } catch (error) {
      this.el('annotation-status').textContent =
        'タグ移動不可: ' + (error?.message || String(error));
      return;
    }
    const startX = event.clientX,
      startY = event.clientY;
    const group = event.target.closest?.('.stb-drawing-tag');
    const previous = group?.getAttribute('transform') || '';
    const win = this.root.ownerDocument.defaultView || globalThis;
    const pointerId = event.pointerId;
    const delta = (e) => screenDeltaToSheetMm(matrix, e.clientX - startX, e.clientY - startY);
    const moving = (e) => {
      if (pointerId != null && e.pointerId != null && e.pointerId !== pointerId) return;
      try {
        const [x, y] = delta(e);
        group?.setAttribute('transform', 'translate(' + x + ' ' + y + ') ' + previous);
      } catch (error) {
        cancel();
        this.el('annotation-status').textContent =
          'タグ移動不可: ' + (error?.message || String(error));
      }
    };
    const cleanup = () => {
      win.removeEventListener('pointermove', moving);
      win.removeEventListener('pointerup', finish);
      win.removeEventListener('pointercancel', cancel);
      win.removeEventListener('keydown', cancelOnEscape);
    };
    const cancel = (e) => {
      if (e?.pointerId != null && pointerId != null && e.pointerId !== pointerId) return;
      cleanup();
      group?.setAttribute('transform', previous);
    };
    const cancelOnEscape = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      cancel();
    };
    const finish = (e) => {
      if (pointerId != null && e.pointerId != null && e.pointerId !== pointerId) return;
      let x, y;
      try {
        [x, y] = delta(e);
      } catch (error) {
        cancel();
        this.el('annotation-status').textContent =
          'タグ移動不可: ' + (error?.message || String(error));
        return;
      }
      cleanup();
      if (Math.hypot(x, y) < 1e-6) {
        this.renderPreview();
        this.panel.renderOverlay?.();
        return;
      }
      if (
        project !== this.project() ||
        sheetId !== this.sheetId ||
        this.placementId !== placementId ||
        this.activeSheetPlacement !== 'view' ||
        this.editTagId !== tag.id
      ) {
        group?.setAttribute('transform', previous);
        this.el('annotation-status').textContent =
          '編集対象が変更されたためタグ移動を取り消しました。';
        return;
      }
      try {
        this.applyViewportAnnotationEdit((current) =>
          moveSheetViewportTag({
            project: current,
            sheetId,
            placementId,
            intentId: tag.id,
            deltaPaperMm: [x, y],
            modelToPaper,
          }),
        );
      } catch (error) {
        group?.setAttribute('transform', previous);
        this.el('annotation-status').textContent = error?.message || String(error);
      }
    };
    win.addEventListener('pointermove', moving);
    win.addEventListener('pointerup', finish);
    win.addEventListener('pointercancel', cancel);
    win.addEventListener('keydown', cancelOnEscape);
  }
  handleViewportDimensionSelect(event, context) {
    const project = this.project();
    const { placementId, drawingDocumentId, intentId } = context;
    try {
      const { document } = resolveSheetViewportDocument(project, this.sheetId, placementId);
      if (
        document.id !== drawingDocumentId ||
        !document.dimensionIntents.some((intent) => intent.id === intentId)
      ) {
        throw new Error('保存寸法とビューポートの参照が一致しません。');
      }
    } catch (error) {
      this.el('annotation-status').textContent = '編集不可: ' + (error?.message || String(error));
      return;
    }
    this.placementId = placementId;
    this.activeSheetPlacement = 'view';
    this.editDimensionId = intentId;
    this.el('placements').value = placementId;
    this.renderPlacement();
    this.el('annotation-status').textContent =
      '保存寸法 ' + intentId + ' を選択しました。オフセット値を編集してください。';
    this.renderPreview();
    this.panel.renderOverlay?.();
  }

  /** Editor-only move/resize grips; print SVG and DrawingDocument are untouched. */
  renderViewportLayoutControls(svg) {
    const sheet = this.sheet();
    if (!sheet?.placements.length) return;
    const ns = 'http://www.w3.org/2000/svg';
    const create = (tag, attrs) => {
      const node = svg.ownerDocument.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      return node;
    };
    const viewports = new Map(
      [...svg.querySelectorAll('.cad-sheet-composite-view')].map((view) => [
        view.getAttribute('data-placement-id'),
        view,
      ]),
    );
    for (const placement of sheet.placements) {
      const { xMm: x, yMm: y, widthMm: w, heightMm: h } = placement;
      // Put the editor hit area behind the view geometry so saved tags and
      // dimensions keep their own gestures. Published SVGs never receive it.
      viewports.get(placement.id)?.prepend(
        create('rect', {
          class: 'cad-viewport-interior-hit',
          x,
          y,
          width: w,
          height: h,
          fill: 'transparent',
          'pointer-events': 'all',
          cursor: 'move',
        }),
      );
      const selected = this.activeSheetPlacement !== 'list' && this.placementId === placement.id;
      const group = create('g', {
        class: 'cad-sheet-viewport-controls',
        'data-viewport-placement-id': placement.id,
      });
      const outline = create('rect', {
        x,
        y,
        width: w,
        height: h,
        fill: 'none',
        stroke: selected ? '#2465a5' : '#8a8a8a',
        'stroke-width': selected ? 1 : 0.35,
        'pointer-events': 'none',
      });
      group.append(outline);
      // The frame has a generous invisible stroke hit area; the view interior,
      // including its persisted tags and dimensions, keeps receiving its own clicks.
      const border = create('rect', {
        x,
        y,
        width: w,
        height: h,
        class: 'cad-viewport-move-grip',
        fill: 'none',
        stroke: 'transparent',
        'stroke-width': 6,
        'pointer-events': 'stroke',
        cursor: 'move',
        'aria-label': 'ビューポートを移動',
      });
      border.addEventListener('pointerdown', (event) =>
        this.handleViewportFramePointerDown(event, svg, placement.id, 'move'),
      );
      group.append(border);
      if (selected) {
        const handles = {
          nw: [x, y],
          n: [x + w / 2, y],
          ne: [x + w, y],
          w: [x, y + h / 2],
          e: [x + w, y + h / 2],
          sw: [x, y + h],
          s: [x + w / 2, y + h],
          se: [x + w, y + h],
        };
        for (const [direction, [cx, cy]] of Object.entries(handles)) {
          const handle = create('rect', {
            x: cx - 3,
            y: cy - 3,
            width: 6,
            height: 6,
            class: 'cad-viewport-resize-handle',
            'data-resize-direction': direction,
            fill: '#ffffff',
            stroke: '#2465a5',
            'stroke-width': 0.8,
            cursor:
              direction === 'n' || direction === 's'
                ? 'ns-resize'
                : direction === 'e' || direction === 'w'
                  ? 'ew-resize'
                  : direction === 'nw' || direction === 'se'
                    ? 'nwse-resize'
                    : 'nesw-resize',
            'aria-label': 'ビューポートの' + direction + '方向をリサイズ',
          });
          handle.addEventListener('pointerdown', (event) =>
            this.handleViewportFramePointerDown(event, svg, placement.id, direction),
          );
          group.append(handle);
        }
      }
      group.addEventListener('click', (event) => event.stopPropagation());
      svg.append(group);
    }
  }

  /** Convert screen drag to paper mm, preview the frame, then commit once on release. */
  handleViewportFramePointerDown(event, svg, placementId, handle) {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const project = this.project();
    const sheetId = this.sheetId;
    const original = this.sheet()?.placements.find((p) => p.id === placementId);
    if (!original) return;
    let matrix;
    try {
      matrix = svg.getScreenCTM?.();
      screenDeltaToSheetMm(matrix, 0, 0);
    } catch (error) {
      this.el('status').textContent = error?.message || String(error);
      return;
    }
    this.placementId = placementId;
    this.activeSheetPlacement = 'view';
    this.el('placements').value = placementId;
    this.showCadProperties({ sheetId, placementId });
    this.renderPlacement();
    const ns = 'http://www.w3.org/2000/svg';
    const ghost = svg.ownerDocument.createElementNS(ns, 'rect');
    for (const [key, value] of Object.entries({
      class: 'cad-viewport-drag-preview',
      fill: 'none',
      stroke: '#2465a5',
      'stroke-width': 1,
      'stroke-dasharray': '4 2',
      'pointer-events': 'none',
    }))
      ghost.setAttribute(key, String(value));
    svg.append(ghost);
    const win = svg.ownerDocument.defaultView || globalThis;
    const startX = event.clientX,
      startY = event.clientY,
      pointerId = event.pointerId;
    const samePointer = (e) =>
      pointerId == null || e.pointerId == null || e.pointerId === pointerId;
    const calculate = (e) => {
      const [dx, dy] = screenDeltaToSheetMm(matrix, e.clientX - startX, e.clientY - startY);
      return computeSheetViewportDrag(original, handle, dx, dy);
    };
    const paint = (values) => {
      for (const [key, value] of Object.entries(values)) {
        ghost.setAttribute(
          { xMm: 'x', yMm: 'y', widthMm: 'width', heightMm: 'height' }[key],
          String(value),
        );
        this.el(fieldMap[key]).value = String(value);
      }
    };
    paint(computeSheetViewportDrag(original, handle, 0, 0));
    const cleanup = () => {
      ghost.remove();
      win.removeEventListener('pointermove', moving);
      win.removeEventListener('pointerup', finish);
      win.removeEventListener('pointercancel', cancel);
      win.removeEventListener('keydown', escape);
    };
    const cancel = () => {
      cleanup();
      this.renderPlacement();
      this.renderPreview();
      this.panel.renderOverlay?.();
    };
    const moving = (e) => {
      if (!samePointer(e)) return;
      try {
        paint(calculate(e));
      } catch (error) {
        this.el('status').textContent = error.message;
        cancel();
      }
    };
    const finish = (e) => {
      if (!samePointer(e)) return;
      let next;
      try {
        next = calculate(e);
      } catch (error) {
        this.el('status').textContent = error.message;
        cancel();
        return;
      }
      cleanup();
      const current = this.sheet()?.placements.find((p) => p.id === placementId);
      if (
        this.project() !== project ||
        this.sheetId !== sheetId ||
        this.activeSheetPlacement !== 'view' ||
        this.placementId !== placementId ||
        !current ||
        ['xMm', 'yMm', 'widthMm', 'heightMm'].some((key) => current[key] !== original[key])
      ) {
        this.el('status').textContent = '編集対象が変更されたためドラッグを取り消しました。';
        this.renderPlacement();
        return;
      }
      try {
        if (['xMm', 'yMm', 'widthMm', 'heightMm'].some((key) => next[key] !== original[key])) {
          this.commit(
            (p) =>
              updateDrawingSheetPlacement(
                p,
                sheetId,
                placementId,
                preserveSheetViewportContentCenter(original, next),
              ),
            {
              preservePreview: true,
            },
          );
        } else {
          this.render();
        }
        this.panel.renderOverlay?.();
      } catch (error) {
        this.el('status').textContent = error?.message || String(error);
        this.renderPlacement();
      }
    };
    const escape = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
    win.addEventListener('pointermove', moving);
    win.addEventListener('pointerup', finish);
    win.addEventListener('pointercancel', cancel);
    win.addEventListener('keydown', escape);
  }

  bindViewportSelection(svg) {
    this.renderViewportLayoutControls(svg);
    // The frame stroke is not the only move target: users can drag the view
    // interior. Persisted tags/dimensions retain their own editing gestures.
    svg.addEventListener('pointerdown', (event) => {
      if (event.target.closest?.('.cad-viewport-move-grip, .cad-viewport-resize-handle')) return;
      if (event.target.closest?.('.stb-drawing-tag, [data-persisted-dimension-id]')) return;
      const viewport = event.target.closest?.('[data-placement-id]');
      const placementId = viewport?.getAttribute('data-placement-id');
      if (placementId && this.sheet()?.placements.some((p) => p.id === placementId))
        this.handleViewportFramePointerDown(event, svg, placementId, 'move');
    });
    svg.addEventListener('click', (event) => {
      const viewport = event.target.closest?.('[data-placement-id]');
      const id = viewport?.getAttribute('data-placement-id');
      if (!id || !this.sheet()?.placements.some((p) => p.id === id)) return;
      if (this.placementId === id && this.activeSheetPlacement === 'view') {
        this.showCadProperties({ sheetId: this.sheetId, placementId: id });
        return;
      }
      this.placementId = id;
      this.activeSheetPlacement = 'view';
      this.showCadProperties({ sheetId: this.sheetId, placementId: id });
      this.el('placements').value = id;
      this.renderPlacement();
      this.renderPreview();
      this.panel.renderOverlay?.();
    });
  }

  renderPlacement() {
    const p = this.placement();
    for (const [key, field] of Object.entries(fieldMap)) {
      const input = this.el(field);
      input.disabled = !p;
      input.value = p ? String(p[key]) : '';
    }
    this.el('apply').disabled = !p;
    this.el('unplace').disabled = !p;
    this.renderViewportAnnotationEditor();
  }
  renderPreview({ throwOnCompositeError = false } = {}) {
    const container = this.el('preview');
    container.replaceChildren();
    const project = this.project();
    const sheet = this.sheet();
    if (!sheet) {
      this.el('status').textContent =
        'シート未作成。リボンの「シート生成」で空シートを作成できます。';
      return;
    }
    const { widthMm: w, heightMm: h } = getSheetPaperSize(sheet.paper, sheet.orientation);
    const doc = this.root.ownerDocument,
      ns = 'http://www.w3.org/2000/svg';
    const elem = (name, attrs, text) => {
      const e = doc.createElementNS(ns, name);
      for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, String(value));
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const workspace = getDrawingSheetWorkspaceBounds(sheet);
    const svg = elem('svg', {
      viewBox: [workspace.minX, workspace.minY, workspace.widthMm, workspace.heightMm].join(' '),
      width: '100%',
      role: 'img',
      'aria-label': sheet.paper + 'シート配置枠のみのプレビュー（図形非表示）',
    });
    svg.append(elem('rect', { x: 0, y: 0, width: w, height: h, fill: '#fff', stroke: '#777' }));
    const issues = inspectDrawingSheetPlacements(sheet);
    if (this.previewSources && this.previewSourceDocument !== getState('models.documentA'))
      this.invalidatePreviewSources();
    let previewError = '';
    const occupied = sheet.placements.length + (sheet.listPlacements?.length ?? 0);
    if (
      occupied &&
      this.previewSources &&
      this.previewSheetId === sheet.id &&
      this.previewProject === project
    ) {
      try {
        const composed = renderDrawingSheetCompositeSvg({
          project,
          sheetId: sheet.id,
          drawingsById: this.previewSources,
          sourceDocument: this.previewSourceDocument,
          listReferencesByPlacementId: this.previewListRefs,
          document: doc,
          selectedPlacementId:
            this.activeSheetPlacement === 'list' ? this.listPlacementId : this.placementId,
          onTagPointerDown: (event, context) => this.handleViewportTagPointerDown(event, context),
          onPersistedDimensionSelect: (event, context) =>
            this.handleViewportDimensionSelect(event, context),
        });
        this.bindViewportSelection(composed);
        container.append(composed);
        this.el('status').textContent =
          sheet.paper +
          ' / 全ビュー実図形プレビュー ' +
          occupied +
          '件。図面・DXF・PDFは確認済みシートから保存できます。' +
          describeSheetLayoutWarnings(sheet);
        return;
      } catch (error) {
        this.invalidatePreviewSources();
        // Generation must propagate a composite failure to the main paper
        // rather than claiming success with no vectors.
        if (throwOnCompositeError) throw error;
        // On a changed layout or revision, the fallback must visibly explain
        // why the previous generated geometry is no longer available.
        previewError = '再生成が必要です: ' + (error?.message || String(error));
      }
    }
    // Only render geometry when every placement can be verified against the
    // current STB-A DrawingModel. Other views need their own explicit producers.
    // Never fabricate an elevation from the current plan or a 3D camera.
    let missingSource = previewError;
    if (sheet.placements.length && !sheet.listPlacements?.length && this.panel.drawing?.bounds) {
      try {
        const currentDocument = resolveCurrentSheetDrawingDocument(
          project,
          this.panel.drawing,
          this.panel.selectedCadDrawingView?.(),
        );
        const currentId = currentDocument.id;
        if (sheet.placements.some((p) => p.drawingDocumentId !== currentId)) {
          missingSource ||= '別ビューのDrawingModelが未生成です。配置枠のみ表示します。';
        } else {
          const composed = renderDrawingSheetCompositeSvg({
            project,
            sheetId: sheet.id,
            drawingsById: { [currentId]: this.panel.drawing },
            sourceDocument: getState('models.documentA'),
            document: doc,
            selectedPlacementId:
              this.activeSheetPlacement === 'list' ? this.listPlacementId : this.placementId,
            onTagPointerDown: (event, context) => this.handleViewportTagPointerDown(event, context),
            onPersistedDimensionSelect: (event, context) =>
              this.handleViewportDimensionSelect(event, context),
          });
          this.bindViewportSelection(composed);
          container.append(composed);
          this.el('status').textContent =
            sheet.paper +
            ' / 実図形プレビュー ' +
            sheet.placements.length +
            '件。図面・DXF・PDFは確認済みシートから保存できます。' +
            describeSheetLayoutWarnings(sheet);
          return;
        }
      } catch (error) {
        missingSource ||= '実図形プレビュー不可: ' + (error?.message || String(error));
      }
    } else if (occupied) {
      missingSource ||= sheet.listPlacements?.length
        ? 'リスト領域を含むシートは「シート内の全ビューを生成・確認」後に図形を表示します。'
        : 'DrawingModelが未生成です。配置枠のみ表示します。';
    }
    for (const p of [...sheet.placements, ...(sheet.listPlacements ?? [])]) {
      const invalid = issues.some((i) => i.placementId === p.id || i.otherId === p.id);
      svg.append(
        elem('rect', {
          x: p.xMm,
          y: p.yMm,
          width: p.widthMm,
          height: p.heightMm,
          fill: 'none',
          stroke: invalid ? '#c44' : '#2465a5',
          'stroke-width': p.id === this.placementId ? 2.5 : 1,
          ...(p.drawingDocumentId
            ? { 'data-placement-id': p.id, 'pointer-events': 'all', cursor: 'move' }
            : {}),
        }),
      );
      svg.append(
        elem(
          'text',
          {
            x: p.xMm + 3,
            y: p.yMm + 9,
            'font-size': 7,
            fill: '#333',
            ...(p.drawingDocumentId ? { 'data-placement-id': p.id, cursor: 'move' } : {}),
          },
          p.drawingDocumentId ?? CAD_SHEET_LIST_TYPES[p.listType].label,
        ),
      );
    }
    this.bindViewportSelection(svg);
    container.append(svg);
    this.el('status').textContent = issues.length
      ? '配置診断 ' +
        issues.length +
        '件: ' +
        issues.map((i) => i.code).join(', ') +
        '。PDFでは用紙外をトリムして出力します。'
      : sheet.paper +
        ' / 配置' +
        occupied +
        '件。' +
        (missingSource || '配置枠のみ表示（図形描画・シート出力は未対応）。');
  }
}
