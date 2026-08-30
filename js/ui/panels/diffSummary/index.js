/**
 * @fileoverview 差分サマリー表示モジュール公開API
 *
 * diffSummary ディレクトリ内のモジュールを統合し、外部向けAPIを提供します。
 * - calculateDiffStatistics: 比較結果から差分統計を集計
 * - generateSummaryHTML: 統計からサマリーHTMLを生成
 * - setupDiffSummaryEventListeners: 比較結果更新イベントの購読を開始
 */

export { calculateDiffStatistics } from './statistics.js';
export { generateSummaryHTML } from './summaryHtml.js';
export { setupDiffSummaryEventListeners } from './interactions.js';
