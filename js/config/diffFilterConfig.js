/**
 * @fileoverview 差分フィルタ統合設定
 *
 * 差分カテゴリ、色、ラベル、プリセットを一元管理します。
 * このファイルが差分フィルタ関連設定の単一の情報源（Single Source of Truth）です。
 *
 * 国際化対応のため、ラベルはja/en形式で定義します。
 *
 * @module config/diffFilterConfig
 */

// ============================================================================
// 差分カテゴリ定義（6カテゴリ）
// ============================================================================

/**
 * 差分カテゴリ定義
 * 存在差分(3) + 内容差分(3) = 6カテゴリ
 * @type {Array<Object>}
 */
export const DIFF_CATEGORIES = [
  {
    id: 'matched',
    label: {
      ja: '完全一致',
      en: 'Matched',
    },
    description: {
      ja: '位置・属性とも完全に一致',
      en: 'Position and attributes match completely',
    },
    colorKey: 'matched',
    icon: '✓',
    group: 'existence', // 存在差分グループ
    order: 1,
    htmlCheckboxId: 'diff-filter-matched',
    htmlCountId: 'diff-count-matched',
    htmlColorClass: 'legend-color-matched',
  },
  {
    id: 'onlyA',
    label: {
      ja: 'モデルAのみ',
      en: 'Only in Model A',
    },
    description: {
      ja: 'モデルAにのみ存在（削除された要素）',
      en: 'Exists only in Model A (deleted elements)',
    },
    colorKey: 'onlyA',
    icon: 'A',
    group: 'existence',
    order: 2,
    htmlCheckboxId: 'diff-filter-onlyA',
    htmlCountId: 'diff-count-onlyA',
    htmlColorClass: 'legend-color-onlya',
  },
  {
    id: 'onlyB',
    label: {
      ja: 'モデルBのみ',
      en: 'Only in Model B',
    },
    description: {
      ja: 'モデルBにのみ存在（追加された要素）',
      en: 'Exists only in Model B (added elements)',
    },
    colorKey: 'onlyB',
    icon: 'B',
    group: 'existence',
    order: 3,
    htmlCheckboxId: 'diff-filter-onlyB',
    htmlCountId: 'diff-count-onlyB',
    htmlColorClass: 'legend-color-onlyb',
  },
  {
    id: 'positionTolerance',
    label: {
      ja: '位置許容差内',
      en: 'Within Tolerance',
    },
    description: {
      ja: '位置が許容差内、属性は一致',
      en: 'Position within tolerance, attributes match',
    },
    colorKey: 'positionTolerance',
    icon: '≈',
    group: 'content', // 内容差分グループ
    order: 4,
    htmlCheckboxId: 'diff-filter-positionTolerance',
    htmlCountId: 'diff-count-positionTolerance',
    htmlColorClass: 'legend-color-positiontolerance',
  },
  {
    id: 'attributeMismatch',
    label: {
      ja: '属性不一致（種別不明）',
      en: 'Attribute Mismatch',
    },
    description: {
      ja: '位置は一致、属性が不一致（旧比較結果または種別未分類）',
      en: 'Position matches, attributes differ (legacy or unclassified)',
    },
    colorKey: 'attributeMismatch',
    icon: '!',
    group: 'content',
    order: 5,
    htmlCheckboxId: 'diff-filter-attributeMismatch',
    htmlCountId: 'diff-count-attributeMismatch',
    htmlColorClass: 'legend-color-attributemismatch',
  },
  {
    id: 'attributeMismatchInstance',
    label: {
      ja: 'インスタンス属性差',
      en: 'Instance Attribute Diff',
    },
    description: {
      ja: 'オフセット、回転、配置属性など部材インスタンス側の情報が不一致',
      en: 'Instance-level data such as offsets, rotation, or placement attributes differ',
    },
    colorKey: 'attributeMismatchInstance',
    icon: 'I',
    group: 'content',
    order: 6,
    htmlCheckboxId: 'diff-filter-attributeMismatchInstance',
    htmlCountId: 'diff-count-attributeMismatchInstance',
    htmlColorClass: 'legend-color-attributemismatchinstance',
  },
  {
    id: 'attributeMismatchType',
    label: {
      ja: 'タイプ情報差',
      en: 'Type Info Diff',
    },
    description: {
      ja: '参照断面などタイプ定義側の情報が不一致',
      en: 'Type definition data such as referenced section definitions differ',
    },
    colorKey: 'attributeMismatchType',
    icon: 'T',
    group: 'content',
    order: 7,
    htmlCheckboxId: 'diff-filter-attributeMismatchType',
    htmlCountId: 'diff-count-attributeMismatchType',
    htmlColorClass: 'legend-color-attributemismatchtype',
  },
  {
    id: 'attributeMismatchBoth',
    label: {
      ja: '属性+タイプ差',
      en: 'Instance + Type Diff',
    },
    description: {
      ja: 'インスタンス情報とタイプ情報の両方が不一致',
      en: 'Both instance-level and type-definition data differ',
    },
    colorKey: 'attributeMismatchBoth',
    icon: 'B',
    group: 'content',
    order: 8,
    htmlCheckboxId: 'diff-filter-attributeMismatchBoth',
    htmlCountId: 'diff-count-attributeMismatchBoth',
    htmlColorClass: 'legend-color-attributemismatchboth',
  },
  {
    id: 'combined',
    label: {
      ja: '位置+属性差',
      en: 'Combined Diff',
    },
    description: {
      ja: '位置が許容差内、かつ属性も不一致',
      en: 'Position within tolerance and attributes differ',
    },
    colorKey: 'combined',
    icon: '⚠',
    group: 'content',
    order: 9,
    htmlCheckboxId: 'diff-filter-combined',
    htmlCountId: 'diff-count-combined',
    htmlColorClass: 'legend-color-combined',
  },
];

// ============================================================================
// プリセット定義（7種類）
// ============================================================================

/**
 * フィルタプリセット定義
 * @type {Array<Object>}
 */
const DIFF_FILTER_PRESETS = [
  {
    id: 'all',
    name: {
      ja: '全て表示',
      en: 'Show All',
    },
    description: {
      ja: 'すべての差分ステータスを表示',
      en: 'Show all difference statuses',
    },
    categories: [
      'matched',
      'onlyA',
      'onlyB',
      'positionTolerance',
      'attributeMismatch',
      'attributeMismatchInstance',
      'attributeMismatchType',
      'attributeMismatchBoth',
      'combined',
    ],
    icon: '☰',
    order: 1,
  },
  {
    id: 'differencesOnly',
    name: {
      ja: '差分のみ',
      en: 'Differences Only',
    },
    description: {
      ja: 'モデルA/Bのみの要素を表示（追加・削除）',
      en: 'Show only unique elements (added/deleted)',
    },
    categories: ['onlyA', 'onlyB'],
    icon: '⊕',
    order: 2,
  },
  {
    id: 'matchedOnly',
    name: {
      ja: '共通部材のみ',
      en: 'Common Only',
    },
    description: {
      ja: '両方のモデルに存在する要素のみ表示',
      en: 'Show only common elements',
    },
    categories: [
      'matched',
      'positionTolerance',
      'attributeMismatch',
      'attributeMismatchInstance',
      'attributeMismatchType',
      'attributeMismatchBoth',
      'combined',
    ],
    icon: '∩',
    order: 3,
  },
  {
    id: 'onlyAOnly',
    name: {
      ja: 'モデルAのみ',
      en: 'Model A Only',
    },
    description: {
      ja: 'モデルAにのみ存在する要素を表示',
      en: 'Show elements existing only in Model A',
    },
    categories: ['onlyA'],
    icon: 'A',
    order: 4,
  },
  {
    id: 'onlyBOnly',
    name: {
      ja: 'モデルBのみ',
      en: 'Model B Only',
    },
    description: {
      ja: 'モデルBにのみ存在する要素を表示',
      en: 'Show elements existing only in Model B',
    },
    categories: ['onlyB'],
    icon: 'B',
    order: 5,
  },
  {
    id: 'changesOnly',
    name: {
      ja: '変更・差分のみ',
      en: 'Changes Only',
    },
    description: {
      ja: '変更があった要素のみ表示（追加、削除、位置変更、属性変更）',
      en: 'Show only modified elements',
    },
    categories: [
      'onlyA',
      'onlyB',
      'positionTolerance',
      'attributeMismatch',
      'attributeMismatchInstance',
      'attributeMismatchType',
      'attributeMismatchBoth',
      'combined',
    ],
    icon: '△',
    order: 6,
  },
  {
    id: 'exactMatchOnly',
    name: {
      ja: '完全一致のみ',
      en: 'Exact Match Only',
    },
    description: {
      ja: '位置・属性とも完全に一致する要素のみ表示',
      en: 'Show only elements with exact match',
    },
    categories: ['matched'],
    icon: '=',
    order: 7,
  },
];

// ============================================================================
// UI設定
// ============================================================================

/**
 * UI表示設定
 * @type {Object}
 */
export const DIFF_FILTER_UI_CONFIG = {
  /** デフォルト言語 */
  locale: 'ja',
  /** アイコン表示 */
  showIcons: true,
  /** カウント表示 */
  showCounts: true,
  /** 説明文表示（ツールチップ） */
  showDescriptions: true,
  /** プリセット機能 */
  enablePresets: true,
  /** カスタムプリセット（将来拡張用） */
  enableCustomPresets: false,
};

// ============================================================================
// ヘルパー関数
// ============================================================================

/**
 * カテゴリIDからカテゴリ定義を取得
 * @param {string} id - カテゴリID
 * @returns {Object|undefined} カテゴリ定義
 */
function getCategoryById(id) {
  return DIFF_CATEGORIES.find((cat) => cat.id === id);
}

/**
 * カテゴリIDからラベルを取得
 * @param {string} id - カテゴリID
 * @param {string} [locale='ja'] - 言語コード
 * @returns {string|undefined} ラベル
 */
export function getCategoryLabel(id, locale = 'ja') {
  const category = getCategoryById(id);
  if (!category) return undefined;
  return category.label[locale] || category.label.ja;
}

/**
 * 全プリセットをDiffStatusFilter形式に変換
 * @param {string} [locale='ja'] - 言語コード
 * @returns {Object} プリセット定義オブジェクト
 */
export function getPresetsForFilter(locale = 'ja') {
  const result = {};
  for (const preset of DIFF_FILTER_PRESETS) {
    result[preset.id] = {
      name: preset.name[locale] || preset.name.ja,
      levels: new Set(preset.categories),
      description: preset.description[locale] || preset.description.ja,
    };
  }
  return result;
}

// ============================================================================
// 差分ステータス定数（DIFF_CATEGORIESから導出）
// ============================================================================

/**
 * 差分ステータスの定数オブジェクト
 * @constant {Object}
 */
export const DIFF_STATUS = {
  // 存在差分
  MATCHED: 'matched',
  ONLY_A: 'onlyA',
  ONLY_B: 'onlyB',
  // 内容差分
  POSITION_TOLERANCE: 'positionTolerance',
  ATTRIBUTE_MISMATCH: 'attributeMismatch',
  ATTRIBUTE_MISMATCH_INSTANCE: 'attributeMismatchInstance',
  ATTRIBUTE_MISMATCH_TYPE: 'attributeMismatchType',
  ATTRIBUTE_MISMATCH_BOTH: 'attributeMismatchBoth',
  COMBINED: 'combined',
  // 旧ステータス名→新ステータス名変換用エイリアス
  MISMATCH: 'mismatch',
};

/**
 * 差分ステータスの表示名マッピング
 * @constant {Object.<string, string>}
 */
export const DIFF_STATUS_NAMES = Object.fromEntries(
  DIFF_CATEGORIES.map((cat) => [cat.id, cat.label.ja]),
);

/**
 * 全差分ステータスIDの配列
 * @constant {Array<string>}
 */
export const DIFF_STATUS_VALUES = DIFF_CATEGORIES.map((cat) => cat.id);
