/**
 * @fileoverview 差分サマリーのステータス・色マッピング定数群
 *
 * サマリー表示（4カテゴリ）→差分フィルタステータス（9カテゴリ）の対応表と、
 * 各ステータスに対応するCSSクラス名・カラー変数の定義を提供します。
 * グラフ・表のクリック絞り込みに使用します。
 */

import { DIFF_STATUS } from '../../../config/diffFilterConfig.js';

/** 属性不一致としてまとめて扱うステータス群 */
const ATTRIBUTE_MISMATCH_STATUSES = [
  DIFF_STATUS.ATTRIBUTE_MISMATCH,
  DIFF_STATUS.ATTRIBUTE_MISMATCH_INSTANCE,
  DIFF_STATUS.ATTRIBUTE_MISMATCH_TYPE,
  DIFF_STATUS.ATTRIBUTE_MISMATCH_BOTH,
  DIFF_STATUS.COMBINED,
];

/** サマリーの4カテゴリ列に対応するステータス群 */
const SUMMARY_CATEGORY_STATUSES = {
  corresponding: [
    DIFF_STATUS.MATCHED,
    DIFF_STATUS.POSITION_TOLERANCE,
    ...ATTRIBUTE_MISMATCH_STATUSES,
  ],
  matched: [DIFF_STATUS.MATCHED, DIFF_STATUS.POSITION_TOLERANCE],
  onlyA: [DIFF_STATUS.ONLY_A],
  onlyB: [DIFF_STATUS.ONLY_B],
  attributeMismatch: ATTRIBUTE_MISMATCH_STATUSES,
};

const PAIRED_STATUSES = [
  DIFF_STATUS.MATCHED,
  DIFF_STATUS.POSITION_TOLERANCE,
  ...ATTRIBUTE_MISMATCH_STATUSES,
];

const POSITION_EXACT_STATUSES = [
  DIFF_STATUS.MATCHED,
  DIFF_STATUS.ATTRIBUTE_MISMATCH,
  DIFF_STATUS.ATTRIBUTE_MISMATCH_INSTANCE,
  DIFF_STATUS.ATTRIBUTE_MISMATCH_TYPE,
  DIFF_STATUS.ATTRIBUTE_MISMATCH_BOTH,
];

const POSITION_TOLERANCE_STATUSES = [
  DIFF_STATUS.POSITION_TOLERANCE,
  DIFF_STATUS.COMBINED,
  DIFF_STATUS.ATTRIBUTE_MISMATCH,
  DIFF_STATUS.ATTRIBUTE_MISMATCH_INSTANCE,
  DIFF_STATUS.ATTRIBUTE_MISMATCH_TYPE,
  DIFF_STATUS.ATTRIBUTE_MISMATCH_BOTH,
];

const DIFF_STATUS_VALUE_CLASSES = {
  [DIFF_STATUS.MATCHED]: 'diff-stat-matched',
  [DIFF_STATUS.ONLY_A]: 'diff-stat-only-a',
  [DIFF_STATUS.ONLY_B]: 'diff-stat-only-b',
  [DIFF_STATUS.POSITION_TOLERANCE]: 'diff-stat-position-tolerance',
  [DIFF_STATUS.ATTRIBUTE_MISMATCH]: 'diff-stat-attribute-mismatch',
  [DIFF_STATUS.ATTRIBUTE_MISMATCH_INSTANCE]: 'diff-stat-attribute-mismatch-instance',
  [DIFF_STATUS.ATTRIBUTE_MISMATCH_TYPE]: 'diff-stat-attribute-mismatch-type',
  [DIFF_STATUS.ATTRIBUTE_MISMATCH_BOTH]: 'diff-stat-attribute-mismatch-both',
  [DIFF_STATUS.COMBINED]: 'diff-stat-combined',
};

const DIFF_STATUS_COLOR_VARS = {
  [DIFF_STATUS.MATCHED]: 'var(--color-matched)',
  [DIFF_STATUS.ONLY_A]: 'var(--color-only-a)',
  [DIFF_STATUS.ONLY_B]: 'var(--color-only-b)',
  [DIFF_STATUS.POSITION_TOLERANCE]: 'var(--color-position-tolerance)',
  [DIFF_STATUS.ATTRIBUTE_MISMATCH]: 'var(--color-attribute-mismatch)',
  [DIFF_STATUS.ATTRIBUTE_MISMATCH_INSTANCE]: 'var(--color-attribute-mismatch-instance)',
  [DIFF_STATUS.ATTRIBUTE_MISMATCH_TYPE]: 'var(--color-attribute-mismatch-type)',
  [DIFF_STATUS.ATTRIBUTE_MISMATCH_BOTH]: 'var(--color-attribute-mismatch-both)',
  [DIFF_STATUS.COMBINED]: 'var(--color-combined)',
};

export {
  SUMMARY_CATEGORY_STATUSES,
  PAIRED_STATUSES,
  POSITION_EXACT_STATUSES,
  POSITION_TOLERANCE_STATUSES,
  DIFF_STATUS_VALUE_CLASSES,
  DIFF_STATUS_COLOR_VARS,
};
