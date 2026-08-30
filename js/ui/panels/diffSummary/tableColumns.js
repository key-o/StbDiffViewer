/**
 * @fileoverview 差分サマリー要素タイプ別テーブルの列モデル定義
 *
 * 配置要素テーブルは、対応要素を3D差分色と同じ排他的カテゴリ
 * （完全一致 / 位置許容差 / インスタンス属性差 / 断面・タイプ差 / 複合差）へ分解する。
 * 断面・接合・開口・STB定義などの非描画要素は、別の定義テーブルで表示する。
 */

import { DIFF_STATUS, DIFF_STATUS_VALUES } from '../../../config/diffFilterConfig.js';
import { SUMMARY_CATEGORY_STATUSES, DIFF_STATUS_VALUE_CLASSES } from './statusMaps.js';

// ---------------------------------------------------------------------------
// 要素タイプ別テーブルの列定義
// 各列は per(typeStats) / tot(stats) で値を取り出し、cls/statuses で
// 3D色とクリック絞り込みを規定する。
// ---------------------------------------------------------------------------

// 「全体」= 軸を持たない先頭の固定列（A計 / B計 / 対応）。
const FLAT_LEADING_COLUMNS = [
  {
    key: 'modelA',
    label: 'A計',
    title: 'モデルA側の配置要素数',
    per: (s) => s.totalModelA,
    tot: (s) => s.totalModelA,
    cls: 'diff-cell-total',
    statuses: DIFF_STATUS_VALUES,
  },
  {
    key: 'modelB',
    label: 'B計',
    title: 'モデルB側の配置要素数',
    per: (s) => s.totalModelB,
    tot: (s) => s.totalModelB,
    cls: 'diff-cell-total',
    statuses: DIFF_STATUS_VALUES,
  },
  {
    key: 'corresponding',
    label: '対応',
    title: 'モデルA/Bで対応した配置要素数（右側の色別内訳の合計）',
    per: (s) => s.corresponding,
    tot: (s) => s.totalCorresponding,
    cls: 'diff-stat-matched',
    statuses: SUMMARY_CATEGORY_STATUSES.corresponding,
  },
];

function countStatuses(stats, statuses) {
  return statuses.reduce((sum, status) => sum + (stats?.statusCounts?.[status] || 0), 0);
}

/**
 * 対応要素の3D色別内訳。
 * 5列は排他的で、合計が「対応」列と一致する。
 * generic attributeMismatch は従来どおり橙に含める。
 */
const CORRESPONDING_STATUS_COLUMNS = [
  {
    key: 'exact',
    label: '完全一致',
    title: '完全一致（緑）：位置・インスタンス属性・断面/タイプがすべて一致',
    per: (s) => countStatuses(s, [DIFF_STATUS.MATCHED]),
    tot: (s) => countStatuses(s, [DIFF_STATUS.MATCHED]),
    cls: DIFF_STATUS_VALUE_CLASSES[DIFF_STATUS.MATCHED],
    headerCls: DIFF_STATUS_VALUE_CLASSES[DIFF_STATUS.MATCHED],
    statuses: [DIFF_STATUS.MATCHED],
  },
  {
    key: 'positionTolerance',
    label: '●位置',
    title: '位置許容差（黄）：位置のみ許容差内で、属性・断面/タイプは一致',
    per: (s) => countStatuses(s, [DIFF_STATUS.POSITION_TOLERANCE]),
    tot: (s) => countStatuses(s, [DIFF_STATUS.POSITION_TOLERANCE]),
    cls: DIFF_STATUS_VALUE_CLASSES[DIFF_STATUS.POSITION_TOLERANCE],
    headerCls: DIFF_STATUS_VALUE_CLASSES[DIFF_STATUS.POSITION_TOLERANCE],
    statuses: [DIFF_STATUS.POSITION_TOLERANCE],
  },
  {
    key: 'instanceMismatch',
    label: '●属性',
    title: 'インスタンス属性差（橙）：インスタンス属性差・未分類属性差',
    per: (s) =>
      countStatuses(s, [DIFF_STATUS.ATTRIBUTE_MISMATCH, DIFF_STATUS.ATTRIBUTE_MISMATCH_INSTANCE]),
    tot: (s) =>
      countStatuses(s, [DIFF_STATUS.ATTRIBUTE_MISMATCH, DIFF_STATUS.ATTRIBUTE_MISMATCH_INSTANCE]),
    cls: DIFF_STATUS_VALUE_CLASSES[DIFF_STATUS.ATTRIBUTE_MISMATCH_INSTANCE],
    headerCls: DIFF_STATUS_VALUE_CLASSES[DIFF_STATUS.ATTRIBUTE_MISMATCH_INSTANCE],
    statuses: [DIFF_STATUS.ATTRIBUTE_MISMATCH, DIFF_STATUS.ATTRIBUTE_MISMATCH_INSTANCE],
  },
  {
    key: 'typeMismatch',
    label: '●断面',
    title: '断面・タイプ差（シアン）：参照断面またはタイプ情報が不一致',
    per: (s) => countStatuses(s, [DIFF_STATUS.ATTRIBUTE_MISMATCH_TYPE]),
    tot: (s) => countStatuses(s, [DIFF_STATUS.ATTRIBUTE_MISMATCH_TYPE]),
    cls: DIFF_STATUS_VALUE_CLASSES[DIFF_STATUS.ATTRIBUTE_MISMATCH_TYPE],
    headerCls: DIFF_STATUS_VALUE_CLASSES[DIFF_STATUS.ATTRIBUTE_MISMATCH_TYPE],
    statuses: [DIFF_STATUS.ATTRIBUTE_MISMATCH_TYPE],
  },
  {
    key: 'combinedMismatch',
    label: '●複合',
    title: '複合差（紫）：属性＋タイプ、または位置許容差＋属性の複合差',
    per: (s) =>
      countStatuses(s, [DIFF_STATUS.ATTRIBUTE_MISMATCH_BOTH, DIFF_STATUS.COMBINED]),
    tot: (s) =>
      countStatuses(s, [DIFF_STATUS.ATTRIBUTE_MISMATCH_BOTH, DIFF_STATUS.COMBINED]),
    cls: DIFF_STATUS_VALUE_CLASSES[DIFF_STATUS.ATTRIBUTE_MISMATCH_BOTH],
    headerCls: DIFF_STATUS_VALUE_CLASSES[DIFF_STATUS.ATTRIBUTE_MISMATCH_BOTH],
    statuses: [DIFF_STATUS.ATTRIBUTE_MISMATCH_BOTH, DIFF_STATUS.COMBINED],
  },
];

/** 常に表示する「A/Bのみ」列 */
const AB_ONLY_COLUMNS = [
  {
    key: 'onlyA',
    label: 'Aのみ',
    title: 'モデルAにのみある要素数',
    per: (s) => s.onlyA,
    tot: (s) => s.totalOnlyA,
    cls: 'diff-stat-only-a',
    statuses: SUMMARY_CATEGORY_STATUSES.onlyA,
  },
  {
    key: 'onlyB',
    label: 'Bのみ',
    title: 'モデルBにのみある要素数',
    per: (s) => s.onlyB,
    tot: (s) => s.totalOnlyB,
    cls: 'diff-stat-only-b',
    statuses: SUMMARY_CATEGORY_STATUSES.onlyB,
  },
];

const TYPE_TABLE_WIDTH_TERMS = {
  name: 'var(--diff-type-name-width)',
  metric: 'var(--diff-type-metric-width)',
};

// 断面定義カテゴリ別テーブルの数値列。位置軸を持たないため、
// 対応 / 情報一致 / 情報不一致 / A・Bのみ を示す。
const SECTION_CATEGORY_COLUMNS = [
  { key: 'totalA', label: 'A計', title: 'モデルA側の定義数', cls: 'diff-cell-total' },
  { key: 'totalB', label: 'B計', title: 'モデルB側の定義数', cls: 'diff-cell-total' },
  { key: 'corresponding', label: '対応', title: 'A/Bで対応した定義数', cls: 'diff-stat-matched' },
  {
    key: 'sameNameMatch',
    label: '情報一致',
    title: '対応した定義のうち情報が一致した数',
    cls: 'diff-stat-matched',
  },
  {
    key: 'sameNameMismatch',
    label: '情報不一致',
    title: '対応した定義のうち情報が不一致の数',
    cls: DIFF_STATUS_VALUE_CLASSES[DIFF_STATUS.ATTRIBUTE_MISMATCH_TYPE],
  },
  { key: 'onlyA', label: 'Aのみ', title: 'モデルAにのみある定義数', cls: 'diff-stat-only-a' },
  { key: 'onlyB', label: 'Bのみ', title: 'モデルBにのみある定義数', cls: 'diff-stat-only-b' },
];

// 断面タブの数値セルクリック時に、該当断面を参照する配置要素を3D絞り込みするための
// 列別設定。idsFields は bucket.ids のどの区分の断面定義idを対象にするか、statuses は
// 3D側の差分ステータス（色・表示状態）、modelSource は Aのみ/Bのみ の片側限定。
// A計/B計は導出値だが、モデルA/B側に存在する全断面（対応＋片側）を参照する配置要素を
// A側/B側の id_section で照合して表示する。
// 断面定義セルは「該当断面を参照する全配置要素（対応ペア matched を含む）」を表示する。
// 表示範囲は sectionIds + modelSource の criteria で決まる（A側/B側の id_section で照合）。
// 配置要素自身の差分ステータス（matched/onlyA/属性差…）は定義の一致状態と独立なので、
// statuses は全ステータスを許可し、ステータスによる絞り込みは行わない。
// modelSource は照合する id_section 体系（A側 / B側）の選択に使う。
const SECTION_COLUMN_FILTER = {
  totalA: {
    idsFields: ['sameNameMatch', 'sameNameMismatch', 'onlyA'],
    statuses: DIFF_STATUS_VALUES,
    modelSource: 'A',
  },
  totalB: {
    idsFields: ['sameNameMatch', 'sameNameMismatch', 'onlyB'],
    statuses: DIFF_STATUS_VALUES,
    modelSource: 'B',
  },
  corresponding: {
    idsFields: ['sameNameMatch', 'sameNameMismatch'],
    statuses: DIFF_STATUS_VALUES,
    modelSource: null,
  },
  sameNameMatch: {
    idsFields: ['sameNameMatch'],
    statuses: DIFF_STATUS_VALUES,
    modelSource: null,
  },
  sameNameMismatch: {
    idsFields: ['sameNameMismatch'],
    statuses: DIFF_STATUS_VALUES,
    modelSource: null,
  },
  onlyA: { idsFields: ['onlyA'], statuses: DIFF_STATUS_VALUES, modelSource: 'A' },
  onlyB: { idsFields: ['onlyB'], statuses: DIFF_STATUS_VALUES, modelSource: 'B' },
};

// 断面以外の定義グループ（接合/開口/STB定義）は3D配置要素を持たないため、
// 数値セルクリックで該当グループ・カテゴリの差分を生XML表示する。
// 列キー → 生XMLで表示する差分カテゴリ集合（rawXmlDiffViewer の category 名）。
// totalA/totalB は導出値のためクリック不可（ここに載せない）。
const DEFINITION_COLUMN_RAW_XML_CATEGORIES = {
  corresponding: ['mismatch', 'match'],
  sameNameMatch: ['match'],
  sameNameMismatch: ['mismatch'],
  onlyA: ['onlyA'],
  onlyB: ['onlyB'],
};

// 断面カテゴリの表示順（構造的なまとまりで並べる。未登場カテゴリは自動的にスキップ）。
const SECTION_CATEGORY_ORDER = [
  '柱',
  '間柱',
  '大梁',
  '小梁',
  '梁',
  'ブレース',
  '壁',
  'スラブ',
  'パラペット',
  '基礎',
  '基礎柱',
  '布基礎',
  '杭',
  'その他',
];

// 断面カテゴリ → 配置要素タイプ（複数可）の対応。カテゴリ行クリックで
// 該当する配置要素のみを3D表示に絞り込むために使う。
// 「梁」は kind_beam 不明のため大梁+小梁の両方を対象にする。
const SECTION_CATEGORY_TO_ELEMENT_TYPES = {
  柱: ['Column'],
  間柱: ['Post'],
  大梁: ['Girder'],
  小梁: ['Beam'],
  梁: ['Girder', 'Beam'],
  ブレース: ['Brace'],
  壁: ['Wall'],
  スラブ: ['Slab'],
  パラペット: ['Parapet'],
  基礎: ['Footing'],
  基礎柱: ['FoundationColumn'],
  布基礎: ['StripFooting'],
  杭: ['Pile'],
};

// STB定義グループ（タブ）の定義。順序・ラベル・タブ表示条件を規定する。
const DEFINITION_TAB_DEFS = [
  { group: 'section', label: '断面', title: 'StbSec* の断面定義（部材カテゴリ別）' },
  { group: 'joint', label: '接合', title: 'StbJoint* の継手（接合ルール）定義' },
  { group: 'open', label: '開口', title: 'StbOpen* の開口配置定義' },
  { group: 'other', label: 'STB定義', title: 'StbCommon 等の断面以外の定義（材料・強度指定など）' },
];

/**
 * 配置要素テーブルの、名前列を除く全実列を並び順で返す。
 * 先頭固定列（全体）→ 対応要素の3D色別内訳 → A/Bのみ の順。
 * colgroup・列幅・本体行・合計行で同じ並びを共有する。
 * @param {Object} _collapse - 後方互換のため受け取るが、色別内訳は常時表示する
 * @returns {Array<Object>} 実列の配列
 */
function getPlacementMetricColumns(_collapse) {
  return [...FLAT_LEADING_COLUMNS, ...CORRESPONDING_STATUS_COLUMNS, ...AB_ONLY_COLUMNS];
}

export {
  FLAT_LEADING_COLUMNS,
  CORRESPONDING_STATUS_COLUMNS,
  AB_ONLY_COLUMNS,
  TYPE_TABLE_WIDTH_TERMS,
  SECTION_CATEGORY_COLUMNS,
  SECTION_COLUMN_FILTER,
  DEFINITION_COLUMN_RAW_XML_CATEGORIES,
  SECTION_CATEGORY_ORDER,
  SECTION_CATEGORY_TO_ELEMENT_TYPES,
  DEFINITION_TAB_DEFS,
  getPlacementMetricColumns,
};
