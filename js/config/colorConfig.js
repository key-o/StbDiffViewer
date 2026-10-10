/**
 * @fileoverview 統一カラー設定
 *
 * アプリケーション全体で使用する色を一元管理します。
 * マテリアルデザインカラーを基調とし、用途別に整理されています。
 *
 * このファイルが色設定の単一の情報源（Single Source of Truth）です。
 * 他のモジュールはここから色定義をインポートしてください。
 */

// ============================================================================
// マテリアルデザイン基本色
// ============================================================================

/**
 * マテリアルデザイン基本カラーパレット
 * @see https://materialui.co/colors/
 */
export const COLORS = {
  // プライマリカラー
  GREEN: '#4CAF50', // マテリアルグリーン 500
  GREEN_LIGHT: '#A5D6A7', // マテリアルグリーン 200
  GREEN_DARK: '#388E3C', // マテリアルグリーン 700

  RED: '#F44336', // マテリアルレッド 500
  RED_LIGHT: '#EF9A9A', // マテリアルレッド 200
  RED_DARK: '#D32F2F', // マテリアルレッド 700

  BLUE: '#2196F3', // マテリアルブルー 500
  BLUE_LIGHT: '#90CAF9', // マテリアルブルー 200
  BLUE_DARK: '#1976D2', // マテリアルブルー 700

  ORANGE: '#FF9800', // マテリアルオレンジ 500
  ORANGE_LIGHT: '#FFCC80', // マテリアルオレンジ 200
  ORANGE_DARK: '#F57C00', // マテリアルオレンジ 700

  AMBER: '#FFC107', // マテリアルアンバー 500
  AMBER_LIGHT: '#FFE082', // マテリアルアンバー 200
  AMBER_DARK: '#FFA000', // マテリアルアンバー 700

  // セカンダリカラー
  BROWN: '#795548', // マテリアルブラウン 500
  CYAN: '#00BCD4', // マテリアルシアン 500
  PURPLE: '#9C27B0', // マテリアルパープル 500
  PINK: '#E91E63', // マテリアルピンク 500
  DEEP_ORANGE: '#FF5722', // マテリアルディープオレンジ 500
  LIGHT_GREEN: '#8BC34A', // マテリアルライトグリーン 500
  BLUE_GREY: '#607D8B', // マテリアルブルーグレー 500

  // ニュートラルカラー
  GREY: '#9E9E9E', // マテリアルグレー 500
  GREY_LIGHT: '#E0E0E0', // マテリアルグレー 300
  GREY_DARK: '#616161', // マテリアルグレー 700
  WHITE: '#FFFFFF',
  BLACK: '#000000',
};

// ============================================================================
// 要素タイプ別色設定
// ============================================================================

/**
 * 要素タイプ別のデフォルト色設定
 * 注: core.jsのCOLOR_ELEMENTSと同期を維持してください
 * @type {Object.<string, string>}
 */
export const DEFAULT_ELEMENT_COLORS = {
  Column: COLORS.BROWN, // マテリアルブラウン（柱らしい色）
  Post: COLORS.LIGHT_GREEN, // マテリアルライトグリーン（間柱用）
  Girder: COLORS.BLUE, // マテリアルブルー（大梁用）
  Beam: COLORS.GREEN, // マテリアルグリーン（小梁用）
  Brace: COLORS.ORANGE, // マテリアルオレンジ（ブレース用）
  Slab: COLORS.GREY, // マテリアルグレー（スラブ用）
  Wall: COLORS.DEEP_ORANGE, // マテリアルディープオレンジ（壁用）
  Parapet: COLORS.AMBER, // マテリアルアンバー（パラペット用）
  Joint: COLORS.PURPLE, // マテリアルパープル（接合用）
  Node: COLORS.PINK, // マテリアルピンク（節点用 - 目立つ色）
  Pile: COLORS.BLUE_GREY, // マテリアルブルーグレー（杭用）
  Footing: COLORS.CYAN, // マテリアルシアン（基礎用）
  StripFooting: COLORS.BLUE_DARK, // マテリアルブルーダーク（布基礎用）
  FoundationColumn: COLORS.GREEN_DARK, // マテリアルグリーンダーク（基礎柱用）
  IsolatingDevice: COLORS.PURPLE, // マテリアルパープル（免震装置用）
  DampingDevice: COLORS.DEEP_ORANGE, // マテリアルディープオレンジ（制振装置用）
  FrameDampingDevice: COLORS.AMBER_DARK, // マテリアルアンバーダーク（制振装置フレーム用）
  Undefined: COLORS.GREY, // マテリアルグレー（未定義断面要素 - 寸法不明なため控えめな色）
  // 表示要素（構造部材以外）
  Axis: COLORS.GREY_LIGHT, // マテリアルグレーライト（軸線用）
  Story: COLORS.GREY_LIGHT, // マテリアルグレーライト（階高表示用）
};

/**
 * SRC柱の構成要素別カラー
 * - steel: 内蔵鉄骨（視認しやすい鉄骨色）
 * - concrete: RC外殻（コンクリート色）
 * @type {{Column: {steel: string, concrete: string}}}
 */
export const SRC_COMPONENT_COLORS = {
  Column: {
    steel: '#607D8B', // Blue Grey 500（鉄骨色）
    concrete: '#B0BEC5', // Blue Grey 200（RC外殻）
  },
};

// ============================================================================
// スキーマ検証結果色
// ============================================================================

/**
 * スキーマ検証結果の色設定
 * @type {Object.<string, string>}
 */
export const DEFAULT_SCHEMA_COLORS = {
  valid: COLORS.GREEN, // 正常要素（マテリアルグリーン）
  info: COLORS.BLUE, // 自動修復可能（マテリアルブルー）
  warning: COLORS.ORANGE, // 要確認（マテリアルオレンジ）
  error: COLORS.RED, // エラー要素（マテリアルレッド）
};

// ============================================================================
// 差分表示色
// ============================================================================

/**
 * 差分表示モードの色設定（6カテゴリ分類）
 * @type {Object.<string, string>}
 */
export const DIFF_COLORS = {
  // 存在差分
  matched: COLORS.GREEN, // 完全一致（位置・属性とも）
  onlyA: COLORS.BLUE, // モデルAのみ（ブルー）
  onlyB: COLORS.RED, // モデルBのみ（レッド）
  // 内容差分
  positionTolerance: COLORS.AMBER, // 位置許容差内、属性一致（イエロー/アンバー）
  attributeMismatch: COLORS.ORANGE, // 位置一致、属性不一致（オレンジ）
  attributeMismatchInstance: COLORS.ORANGE, // インスタンス属性差
  attributeMismatchType: COLORS.CYAN, // タイプ情報差（断面定義など）
  attributeMismatchBoth: COLORS.PURPLE, // インスタンス属性差 + タイプ情報差
  combined: COLORS.PURPLE, // 位置許容差内 + 属性不一致（紫）
  // レガシー互換
  mismatch: COLORS.ORANGE, // 後方互換: attributeMismatchと同義
};

/**
 * 許容差対応 差分表示用カラー（5段階分類）
 * @type {Object.<string, string>}
 */
export const TOLERANCE_DIFF_COLORS = {
  exact: COLORS.GREEN, // 完全一致
  withinTolerance: COLORS.AMBER, // 許容差内
  mismatch: COLORS.ORANGE, // 不一致
  onlyA: COLORS.BLUE, // モデルAのみ
  onlyB: COLORS.RED, // モデルBのみ
};

// ============================================================================
// 重要度色
// ============================================================================

/**
 * 重要度レベル別カラー
 * @type {Object.<string, string>}
 */
export const IMPORTANCE_COLORS = {
  // キーはIMPORTANCE_LEVELSの値（小文字）と一致させる
  // 違反要素は全て同一色（高/中/低の区分なし）
  required: COLORS.RED, // 違反
  optional: COLORS.RED, // 違反
  unnecessary: COLORS.RED, // 違反
  notApplicable: COLORS.GREY_DARK, // 対象外
};

// ============================================================================
// 荷重表示色
// ============================================================================

/**
 * 荷重タイプ別カラー
 * @type {Object.<string, string>}
 */
export const DEFAULT_LOAD_COLORS = {
  // 部材荷重タイプ
  uniformLoad: COLORS.RED, // 等分布荷重（レッド）
  pointLoad: COLORS.AMBER, // 集中荷重（アンバー）
  distributedLoad: COLORS.BLUE, // 分布荷重（ブルー）
  triangularLoad: COLORS.CYAN, // 三角形分布荷重（シアン）
  trapezoidalLoad: COLORS.PURPLE, // 台形分布荷重（パープル）

  // 荷重方向
  verticalLoad: COLORS.RED, // 鉛直荷重（レッド）
  horizontalLoad: COLORS.BLUE, // 水平荷重（ブルー）
  momentLoad: COLORS.PURPLE, // モーメント荷重（パープル）

  // デフォルト
  default: COLORS.GREY, // その他荷重（グレー）
};

// ============================================================================
// デフォルトエクスポート
// ============================================================================

export default {
  COLORS,
  DEFAULT_ELEMENT_COLORS,
  SRC_COMPONENT_COLORS,
  DEFAULT_SCHEMA_COLORS,
  DIFF_COLORS,
  TOLERANCE_DIFF_COLORS,
  IMPORTANCE_COLORS,
  DEFAULT_LOAD_COLORS,
};
