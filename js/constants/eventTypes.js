/**
 * @fileoverview イベントタイプ定数
 *
 * アプリケーション全体で使用されるイベントタイプを一元管理します。
 * 各イベントタイプはドメインごとにグループ化されています。
 *
 * Layer 0 (constants) に配置し、全レイヤーからimport可能です。
 *
 * @module constants/eventTypes
 */

// ============================================
// ドメイン別イベントタイプ定義
// ============================================

/**
 * 重要度関連イベント
 * @constant {Object}
 */
export const ImportanceEvents = {
  /** 重要度設定が変更された */
  SETTINGS_CHANGED: 'importance:settingsChanged',
  /** 重要度フィルタが変更された */
  FILTER_CHANGED: 'importance:filterChanged',
  /** 重要度フィルタが適用された */
  FILTER_APPLIED: 'importance:filterApplied',
  /** 自動再描画が完了した */
  AUTO_REDRAW_COMPLETED: 'importance:autoRedrawCompleted',
  /** 自動再描画でエラーが発生した */
  AUTO_REDRAW_ERROR: 'importance:autoRedrawError',
};

/**
 * 比較キータイプ関連イベント
 * @constant {Object}
 */
export const COMPARISON_KEY_EVENTS = {
  /** 比較キータイプが変更された */
  KEY_TYPE_CHANGED: 'comparisonKey:keyTypeChanged',
  /** 断面一致基準が変更された */
  SECTION_MATCH_CRITERION_CHANGED: 'comparisonKey:sectionMatchCriterionChanged',
  /** 通り芯・階の判定基準が変更された */
  STORY_AXIS_MATCH_CRITERION_CHANGED: 'comparisonKey:storyAxisMatchCriterionChanged',
  /** 異ソフト間の階名正準化設定が変更された */
  CROSS_SOFTWARE_MODE_CHANGED: 'comparisonKey:crossSoftwareModeChanged',
};

/**
 * 比較関連イベント
 * @constant {Object}
 */
export const ComparisonEvents = {
  /** 比較統計を更新 */
  UPDATE_STATISTICS: 'comparison:updateStatistics',
  /** 比較が完了した */
  COMPLETED: 'comparison:completed',
  /** 比較がエラーで失敗した */
  ERROR: 'comparison:error',
  /** 比較キーが変更された */
  KEY_CHANGED: 'comparison:keyChanged',
};

/**
 * レンダリング関連イベント
 * @constant {Object}
 */
export const RenderEvents = {
  /** 要素の再描画をリクエスト */
  REQUEST_ELEMENT_RERENDER: 'render:requestElementRerender',
  /** モデルの読み込みが完了した */
  MODEL_LOADED: 'render:modelLoaded',
  /** 表示モードが変更された */
  VIEW_MODE_CHANGED: 'render:viewModeChanged',
  /** 描画フレームをリクエスト */
  REQUEST_RENDER: 'render:requestRender',
  /** 描画フレームが完了した */
  RENDER_COMPLETED: 'render:renderCompleted',
};

/**
 * 軸描画関連イベント
 * @constant {Object}
 */
export const AxisEvents = {
  /** 軸の再描画をリクエスト */
  REDRAW_REQUESTED: 'axis:redrawRequested',
  /** 軸の再描画が完了した */
  REDRAW_COMPLETED: 'axis:redrawCompleted',
};

/**
 * UI関連イベント
 * @constant {Object}
 */
export const UIEvents = {
  /** パネルが開かれた */
  PANEL_OPENED: 'ui:panelOpened',
  /** パネルが閉じられた */
  PANEL_CLOSED: 'ui:panelClosed',
  /** テーマが変更された */
  THEME_CHANGED: 'ui:themeChanged',
};

/**
 * 選択関連イベント
 * @constant {Object}
 */
export const SelectionEvents = {
  /** 要素が選択された */
  ELEMENT_SELECTED: 'selection:elementSelected',
  /** 選択がクリアされた */
  SELECTION_CLEARED: 'selection:cleared',
  /** 複数要素が選択された */
  MULTI_SELECT: 'selection:multiSelect',
};

/**
 * 設定関連イベント
 * @constant {Object}
 */
export const SettingsEvents = {
  /** 設定が変更された */
  CHANGED: 'settings:changed',
  /** 設定がリセットされた */
  RESET: 'settings:reset',
  /** 設定がインポートされた */
  IMPORTED: 'settings:imported',
  /** 設定がエクスポートされた */
  EXPORTED: 'settings:exported',
};

/**
 * 差分ステータスフィルタ関連イベント
 * @constant {Object}
 */
export const DiffStatusEvents = {
  /** 差分フィルタが変更された */
  FILTER_CHANGED: 'diffStatus:filterChanged',
  /** 差分フィルタが適用された */
  FILTER_APPLIED: 'diffStatus:filterApplied',
  /** プリセットが適用された */
  PRESET_APPLIED: 'diffStatus:presetApplied',
};

/**
 * バージョン比較関連イベント
 * @constant {Object}
 */
export const VersionEvents = {
  /** バージョン固有差分フィルタが変更された */
  FILTER_CHANGED: 'version:filterChanged',
  /** バージョン情報が更新された */
  INFO_UPDATED: 'version:infoUpdated',
};

/**
 * モデル関連イベント
 * @constant {Object}
 */
export const ModelEvents = {
  /** モデルがロードされた */
  LOADED: 'model:loaded',
  /** モデルがクリアされた */
  CLEARED: 'model:cleared',
  /** モデルの読み込みエラー */
  LOAD_ERROR: 'model:loadError',
  /** モデルのパースが開始された */
  PARSE_STARTED: 'model:parseStarted',
  /** モデルのパースが完了した */
  PARSE_COMPLETED: 'model:parseCompleted',
  /** モデルのバウンディングボックスが更新された */
  BOUNDS_UPDATED: 'model:boundsUpdated',
};

/**
 * 表示関連イベント
 * @constant {Object}
 */
export const ViewEvents = {
  /** 表示モード変更 */
  MODE_CHANGED: 'view:modeChanged',
  /** カラーモード変更 */
  COLOR_MODE_CHANGED: 'view:colorModeChanged',
  /** カラーモードの再適用要求（設定変更時に各モードモジュールが発行） */
  COLOR_MODE_REFRESH_REQUESTED: 'view:colorModeRefreshRequested',
  /** 要素表示/非表示切替 */
  ELEMENT_VISIBILITY_CHANGED: 'view:elementVisibilityChanged',
  /** カメラモード変更 */
  CAMERA_MODE_CHANGED: 'view:cameraModeChanged',
  /** ビュー方向変更（正面、上面など） */
  VIEW_DIRECTION_CHANGED: 'view:directionChanged',
  /** クリッピング状態変更 */
  CLIPPING_CHANGED: 'view:clippingChanged',
  /** グリッド表示切替 */
  GRID_TOGGLED: 'view:gridToggled',
  /** ラベル表示切替 */
  LABELS_TOGGLED: 'view:labelsToggled',
};

/**
 * エクスポート関連イベント
 * @constant {Object}
 */
export const ExportEvents = {
  /** エクスポート開始 */
  STARTED: 'export:started',
  /** エクスポート完了 */
  COMPLETED: 'export:completed',
  /** エクスポートエラー */
  ERROR: 'export:error',
  /** エクスポート進捗 */
  PROGRESS: 'export:progress',
  /** STBエクスポート状態更新要求 */
  STB_STATUS_UPDATE_REQUESTED: 'export:stbStatusUpdateRequested',
};

/**
 * 荷重表示関連イベント
 * @constant {Object}
 */
export const LoadEvents = {
  /** 荷重ケースが変更された */
  CASE_CHANGED: 'load:caseChanged',
  /** 荷重表示モードが変更された */
  DISPLAY_MODE_CHANGED: 'load:displayModeChanged',
  /** 荷重スケールが変更された */
  SCALE_CHANGED: 'load:scaleChanged',
  /** 荷重データが読み込まれた */
  DATA_LOADED: 'load:dataLoaded',
};

/**
 * トースト通知関連イベント
 * @constant {Object}
 */
export const ToastEvents = {
  /** エラー表示要求 */
  SHOW_ERROR: 'toast:showError',
  /** 警告表示要求 */
  SHOW_WARNING: 'toast:showWarning',
  /** 成功表示要求 */
  SHOW_SUCCESS: 'toast:showSuccess',
  /** 情報表示要求 */
  SHOW_INFO: 'toast:showInfo',
};

/**
 * クリッピング関連イベント
 * @constant {Object}
 */
export const ClippingEvents = {
  /** エラー発生 */
  ERROR: 'clipping:error',
  /** 2D表示モードの変更 */
  MODE_2D_CHANGED: 'clipping:mode2dChanged',
  /** セクションボックスのON/OFF */
  SECTION_BOX_TOGGLED: 'clipping:sectionBoxToggled',
};

/**
 * 編集関連イベント
 * @constant {Object}
 */
export const EditEvents = {
  /** 属性編集が開始された */
  EDIT_STARTED: 'edit:started',
  /** 属性値が変更された */
  ATTRIBUTE_CHANGED: 'edit:attributeChanged',
  /** 編集起因の再比較が完了した（ペイロード: { changedElementTypes: string[] }） */
  RECOMPARISON_COMPLETED: 'edit:recomparisonCompleted',
  /** 編集がキャンセルされた */
  EDIT_CANCELLED: 'edit:cancelled',
  /** 編集モードが切り替わった */
  MODE_TOGGLED: 'edit:modeToggled',
};

/**
 * アプリ→UI通知イベント（R1違反解消用）
 * @constant {Object}
 */
export const AppEvents = {
  /** UIの全状態をクリア */
  CLEAR_UI_STATE: 'app:clearUIState',
  /** ツリービューをクリア */
  CLEAR_TREE: 'app:clearTree',
  /** セクションツリーをクリア */
  CLEAR_SECTION_TREE: 'app:clearSectionTree',
  /** モデル読み込み後のバリデーション要求 */
  POST_LOAD_VALIDATION: 'app:postLoadValidation',
};

/**
 * ローディングインジケータ関連イベント
 * @constant {Object}
 */
export const LoadingIndicatorEvents = {
  /** ローディング表示を開始 */
  SHOW: 'loadingIndicator:show',
  /** ローディング進捗を更新 */
  UPDATE: 'loadingIndicator:update',
  /** ローディングを完了表示 */
  COMPLETE: 'loadingIndicator:complete',
  /** ローディングを非表示 */
  HIDE: 'loadingIndicator:hide',
  /** ローディングエラーを表示 */
  ERROR: 'loadingIndicator:error',
};

/**
 * ラベル管理関連イベント（app→ui 方向違反解消用）
 * @constant {Object}
 */
export const LabelEvents = {
  /** ラベルをグローバル状態に追加 */
  ADD_LABELS: 'label:addLabels',
  /** 要素タイプ別にラベルを削除 */
  REMOVE_BY_TYPE: 'label:removeByType',
  /** ラベル表示状態を更新 */
  UPDATE_VISIBILITY: 'label:updateVisibility',
};

/**
 * 寸法測定イベント
 * @constant {Object}
 */
export const MeasurementEvents = {
  /** 測定モードに入った */
  MODE_ENTERED: 'measurement:modeEntered',
  /** 測定モードを抜けた */
  MODE_EXITED: 'measurement:modeExited',
  /** 第1点が選択された */
  FIRST_POINT_PICKED: 'measurement:firstPointPicked',
  /** 測定が完了した */
  MEASUREMENT_COMPLETED: 'measurement:completed',
  /** 測定が個別削除された */
  MEASUREMENT_DELETED: 'measurement:deleted',
  /** 全測定がクリアされた */
  ALL_CLEARED: 'measurement:allCleared',
};

/**
 * ファイナライゼーション関連イベント
 * @constant {Object}
 */
export const FinalizationEvents = {
  /** UI状態を設定（ラベル、階、軸情報） */
  SET_GLOBAL_STATE: 'finalization:setGlobalState',
  /** セレクターとラベルを更新 */
  UPDATE_SELECTORS: 'finalization:updateSelectors',
  /** 可視化の最終処理が完了した（オーバーレイ表示の再生成用） */
  COMPLETED: 'finalization:completed',
};

/**
 * インタラクション→UI通知イベント
 * @constant {Object}
 */
export const InteractionEvents = {
  /** 要素情報を表示 */
  DISPLAY_ELEMENT_INFO: 'interaction:displayElementInfo',
  /** 複数選択サマリー情報を表示 */
  DISPLAY_MULTI_SELECTION_INFO: 'interaction:displayMultiSelectionInfo',
  /** ツリーで要素を選択 */
  SELECT_ELEMENT_IN_TREE: 'interaction:selectElementInTree',
  /** コンテキストメニューを表示 */
  SHOW_CONTEXT_MENU: 'interaction:showContextMenu',
  /** コンテキストメニューを初期化 */
  INIT_CONTEXT_MENU: 'interaction:initContextMenu',
  /** フローティングウィンドウを開く（windowId 指定） */
  OPEN_WINDOW: 'interaction:openWindow',
  /** 梁貫通孔配置可能範囲図を開く（elementType/elementId/modelSource 指定） */
  OPEN_BEAM_OPENING_DIAGRAM: 'interaction:openBeamOpeningDiagram',
  /** 選択要素にセクションボックスを適用 */
  ACTIVATE_SECTION_BOX_FOR_SELECTION: 'interaction:activateSectionBoxForSelection',
  /** 節点ピックモード中に3Dで節点がクリックされた */
  NODE_PICKED: 'interaction:nodePicked',
};

/**
 * バリデーション関連イベント
 * @constant {Object}
 */
export const ValidationEvents = {
  /** バリデーションが開始された */
  STARTED: 'validation:started',
  /** バリデーションが完了した */
  COMPLETED: 'validation:completed',
  /** バリデーションでエラーが発生した */
  ERROR: 'validation:error',
  /** バリデーション統計が更新された */
  STATS_UPDATED: 'validation:statsUpdated',
};

/**
 * すべてのイベントタイプを統合したオブジェクト
 * @constant {Object}
 */
export const EventTypes = {
  Importance: ImportanceEvents,
  ComparisonKey: COMPARISON_KEY_EVENTS,
  Comparison: ComparisonEvents,
  Render: RenderEvents,
  Axis: AxisEvents,
  UI: UIEvents,
  Selection: SelectionEvents,
  Settings: SettingsEvents,
  DiffStatus: DiffStatusEvents,
  Version: VersionEvents,
  Model: ModelEvents,
  View: ViewEvents,
  Export: ExportEvents,
  Load: LoadEvents,
  Toast: ToastEvents,
  Clipping: ClippingEvents,
  Edit: EditEvents,
  Validation: ValidationEvents,
  App: AppEvents,
  Interaction: InteractionEvents,
  LoadingIndicator: LoadingIndicatorEvents,
  Finalization: FinalizationEvents,
  Label: LabelEvents,
  Measurement: MeasurementEvents,
};

/**
 * イベントタイプが有効かどうかを検証
 * @param {string} eventType - 検証するイベントタイプ
 * @returns {boolean} 有効な場合true
 */
export function isValidEventType(eventType) {
  const allTypes = [
    ...Object.values(ImportanceEvents),
    ...Object.values(COMPARISON_KEY_EVENTS),
    ...Object.values(ComparisonEvents),
    ...Object.values(RenderEvents),
    ...Object.values(AxisEvents),
    ...Object.values(UIEvents),
    ...Object.values(SelectionEvents),
    ...Object.values(SettingsEvents),
    ...Object.values(DiffStatusEvents),
    ...Object.values(VersionEvents),
    ...Object.values(ModelEvents),
    ...Object.values(ViewEvents),
    ...Object.values(ExportEvents),
    ...Object.values(LoadEvents),
    ...Object.values(ToastEvents),
    ...Object.values(ClippingEvents),
    ...Object.values(EditEvents),
    ...Object.values(ValidationEvents),
    ...Object.values(AppEvents),
    ...Object.values(InteractionEvents),
    ...Object.values(LoadingIndicatorEvents),
    ...Object.values(FinalizationEvents),
    ...Object.values(LabelEvents),
    ...Object.values(MeasurementEvents),
  ];
  return allTypes.includes(eventType);
}
