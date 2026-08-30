/**
 * @fileoverview 要素比較・処理モジュール（公開API バレル）
 *
 * このモジュールはモデル間の構造要素比較の公開APIを再エクスポートします：
 * - 要素解析と抽出
 * - モデル比較ロジック実行
 * - 要素分類（共通、Aのみ、Bのみ）
 * - レンダリング用境界計算
 *
 * 実装は comparison/ サブモジュールに分割されています：
 * - comparison/comparisonCaches.js: 断面抽出・階/通り芯ルックアップのキャッシュ（唯一の保持者）
 * - comparison/comparisonElementUtils.js: 属性アクセス・壁種別正規化・第一Node解決
 * - comparison/sectionKeyResolvers.js: 断面一致基準に基づくキー／内容シグネチャ解決
 * - comparison/elementTypeComparator.js: 単一要素タイプの比較実行
 * - comparison/comparisonOrchestrator.js: 全要素タイプの比較・単一タイプ再比較
 * - comparison/comparisonStatistics.js: 境界計算・統計集計
 *
 * @module modelLoader/elementComparison
 */

export {
  invalidateComparisonCachesForDocument,
  getCachedExtractedSections,
} from './comparison/comparisonCaches.js';

export { normalizeComparisonElementType } from './comparison/comparisonElementUtils.js';

export { createSectionKeyResolvers } from './comparison/sectionKeyResolvers.js';

export {
  processElementComparison,
  recompareSingleElementType,
} from './comparison/comparisonOrchestrator.js';

export {
  calculateElementBounds,
  getComparisonStatistics,
} from './comparison/comparisonStatistics.js';
