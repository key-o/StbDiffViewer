/**
 * @fileoverview モデル比較機能のための中核モジュール（バレル）
 *
 * このファイルは、2つのSTBモデルを比較するための機能を提供します:
 *
 * **幾何的比較**:
 * - 要素間の座標ベースの比較ロジック
 * - 線分要素（柱、梁）の比較機能
 * - ポリゴン要素（スラブ、壁）の比較機能
 * - 節点要素の比較機能
 *
 * **パラメータ比較**:
 * - 座標パラメータの数値精度比較
 * - 寸法・断面パラメータの差分検出
 * - 材料特性・構造パラメータの値比較
 *
 * **結果分類**:
 * - モデル間の一致・不一致要素の分類
 * - 重要度を考慮した比較フィルタリング機能
 *
 * 比較結果は「一致」「モデルAのみ」「モデルBのみ」の3つに分類され、
 * 3Dビュー上での色分け表示の基礎となります。
 *
 * 実装は以下のモジュールへ分割済みで、このファイルは再エクスポートのみを行う:
 * - comparison/comparisonCore.js       - 比較コア（戦略への委譲）
 * - comparison/keyExtractors.js        - キー抽出（Mode 1 / V1）
 * - comparison/keyExtractorsV2.js      - キー抽出（Mode 2・3 / V2）
 * - comparison/keyExtractorUtils.js    - キー抽出の共有ヘルパー
 * - comparison/importanceComparison.js - 重要度連携
 *
 * @note このモジュールは以下のサブモジュールに責任を分割しています：
 * - comparison/keyGenerator.js - キー生成
 * - comparison/strategies/ - 比較戦略
 *
 * @module common-stb/comparison/comparator
 */

// --- 要素比較ロジック ---
export { compareElements, compareElementsWithTolerance } from './comparisonCore.js';

// --- 要素タイプごとのキー抽出関数（Mode 1 / V1） ---
export {
  lineElementKeyExtractor,
  polyElementKeyExtractor,
  nodeElementKeyExtractor,
} from './keyExtractors.js';

// --- 配置要素比較 V2（Mode 2 & 3）キー抽出 ---
export { lineElementKeyExtractorV2, polyElementKeyExtractorV2 } from './keyExtractorsV2.js';

// --- 重要度を考慮した比較機能 ---
export {
  compareElementsWithImportance,
  generateImportanceSummary,
  updateComparisonResultImportance,
} from './importanceComparison.js';

/**
 * STBバージョン情報を保持するオブジェクト
 * @typedef {Object} VersionInfo
 * @property {string} versionA - モデルAのバージョン ('2.0.2' or '2.1.0')
 * @property {string} versionB - モデルBのバージョン ('2.0.2' or '2.1.0')
 */

/*
 * バージョン対応の比較結果
 * @typedef {Object} VersionAwareComparisonResult
 * @property {Array} matched - 一致した要素
 * @property {Array} onlyA - モデルAのみの要素
 * @property {Array} onlyB - モデルBのみの要素
 * @property {Array} versionDifferences - バージョン固有の差異
 * @property {Object} versionInfo - バージョン情報
 */

// エクスポート: DIFF_TYPE定数の再エクスポート
export { DIFF_TYPE } from './VersionAwareStrategy.js';
