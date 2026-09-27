/**
 * @fileoverview STBバージョン表示機能
 *
 * 2つのモデルのSTBバージョンをインライン表示し、
 * クロスバージョン比較時の差異情報を管理します。
 */

import { eventBus } from '../../data/events/eventBus.js';
import { EventTypes, ModelEvents, VersionEvents } from '../../constants/eventTypes.js';

/**
 * バージョン情報の状態
 */
let currentVersionInfo = {
  versionA: null,
  versionB: null,
  isCrossVersion: false,
};

/**
 * バージョン差分フィルタの状態
 * true: バージョン固有差分を表示する
 * false: バージョン固有差分を除外する
 */
let showVersionSpecificDifferences = true;

/**
 * バージョン情報を更新し、インラインバッジを更新
 * @param {Object} versionInfo - バージョン情報
 * @param {string} versionInfo.versionA - モデルAのバージョン
 * @param {string} versionInfo.versionB - モデルBのバージョン
 * @param {string} [versionInfo.sourceTypeA] - モデルAのソース種別 ('stb'|'ifc')
 * @param {string} [versionInfo.sourceTypeB] - モデルBのソース種別
 * @param {string} [versionInfo.ifcSchemaA] - モデルAのIFCスキーマ (IFC2X3等)
 * @param {string} [versionInfo.ifcSchemaB] - モデルBのIFCスキーマ
 */
export function updateVersionPanel(versionInfo) {
  currentVersionInfo = {
    ...versionInfo,
    isCrossVersion:
      versionInfo.versionA !== versionInfo.versionB &&
      versionInfo.versionA !== 'unknown' &&
      versionInfo.versionB !== 'unknown',
  };

  // インライン要素を更新
  updateInlineVersionBadge(
    'versionA-inline',
    versionInfo.versionA,
    versionInfo.sourceTypeA,
    versionInfo.ifcSchemaA,
    versionInfo.hasModelA !== false,
  );
  updateInlineVersionBadge(
    'versionB-inline',
    versionInfo.versionB,
    versionInfo.sourceTypeB,
    versionInfo.ifcSchemaB,
    versionInfo.hasModelB !== false,
  );
}

/**
 * インラインバージョンバッジを更新
 * @param {string} elementId - 更新する要素のID
 * @param {string} version - バージョン文字列
 * @param {string} [sourceType] - ソース種別 ('stb'|'ifc')
 * @param {string} [ifcSchema] - IFCスキーマ文字列
 * @param {boolean} [hasModel=true] - 対象スロットにモデルが存在するか
 */
function updateInlineVersionBadge(elementId, version, sourceType, ifcSchema, hasModel = true) {
  const el = document.getElementById(elementId);
  if (!el) return;

  if (!hasModel) {
    el.textContent = '';
    el.className = 'version-badge-inline';
    return;
  }

  el.textContent = formatSourceLabel(version, sourceType, ifcSchema);
  el.className = 'version-badge-inline ' + getVersionClass(version, sourceType);
}

/**
 * ソース種別とバージョンからラベルをフォーマット
 * @param {string} version - バージョン文字列
 * @param {string} [sourceType] - ソース種別
 * @param {string} [ifcSchema] - IFCスキーマ文字列
 * @returns {string} 表示ラベル
 */
function formatSourceLabel(version, sourceType, ifcSchema) {
  if (sourceType === 'ifc') {
    return ifcSchema ? formatIfcSchema(ifcSchema) : 'IFC';
  }
  if (!version || version === 'unknown') {
    return '不明';
  }
  return `STB ${version}`;
}

/**
 * IFCスキーマ文字列を表示用にフォーマット
 * @param {string} schema - IFCスキーマ ('IFC2X3', 'IFC4', 'IFC4X3'等)
 * @returns {string} フォーマットされたスキーマ名
 */
function formatIfcSchema(schema) {
  const s = schema.toUpperCase();
  if (s === 'IFC2X3' || s === 'IFC2X3TC1') return 'IFC 2x3';
  if (s === 'IFC4' || s === 'IFC4X0') return 'IFC 4x0';
  if (s === 'IFC4X1') return 'IFC 4x1';
  if (s === 'IFC4X2') return 'IFC 4x2';
  if (s === 'IFC4X3' || s.startsWith('IFC4X3')) return 'IFC 4x3';
  return `IFC ${schema}`;
}

/**
 * バージョンとソース種別に対応するCSSクラスを取得
 * @param {string} version - バージョン文字列
 * @param {string} [sourceType] - ソース種別
 * @returns {string} CSSクラス名
 */
function getVersionClass(version, sourceType) {
  if (sourceType === 'ifc') {
    return 'version-ifc';
  }
  if (!version || version === 'unknown') {
    return 'version-unknown';
  }
  if (version.startsWith('2.0')) {
    return 'version-202';
  }
  if (version.startsWith('2.1')) {
    return 'version-210';
  }
  return 'version-other';
}

/**
 * バージョン情報をクリア
 */
export function clearVersionPanel() {
  currentVersionInfo = {
    versionA: null,
    versionB: null,
    isCrossVersion: false,
  };

  // インライン要素をクリア
  const versionAEl = document.getElementById('versionA-inline');
  const versionBEl = document.getElementById('versionB-inline');
  if (versionAEl) {
    versionAEl.textContent = '';
    versionAEl.className = 'version-badge-inline';
  }
  if (versionBEl) {
    versionBEl.textContent = '';
    versionBEl.className = 'version-badge-inline';
  }
}

/**
 * 現在のバージョン情報を取得
 * @returns {Object} 現在のバージョン情報
 */
export function getCurrentVersionInfo() {
  return { ...currentVersionInfo };
}

/**
 * クロスバージョン比較かどうかを判定
 * @returns {boolean} クロスバージョンの場合true
 */
export function isCrossVersionComparison() {
  return currentVersionInfo.isCrossVersion;
}

/**
 * バージョン固有差分を表示するかどうかを取得
 * @returns {boolean} 表示する場合true
 */
export function shouldShowVersionSpecificDifferences() {
  return showVersionSpecificDifferences;
}

/**
 * バージョン固有差分の表示設定を変更
 * @param {boolean} show - 表示する場合true
 */
export function setShowVersionSpecificDifferences(show) {
  showVersionSpecificDifferences = show;
  const checkbox = document.getElementById('version-diff-filter');
  if (checkbox) {
    checkbox.checked = show;
  }
  eventBus.emit(VersionEvents.FILTER_CHANGED, {
    showVersionSpecificDifferences: show,
  });
}

/**
 * イベントリスナーを設定
 */
export function setupVersionPanelEventListeners() {
  // 比較完了時
  eventBus.on(EventTypes.Comparison.COMPLETED, (data) => {
    if (data?.versionInfo) {
      updateVersionPanel(data.versionInfo);
    }
  });

  eventBus.on(ModelEvents.CLEARED, clearVersionPanel);
}
