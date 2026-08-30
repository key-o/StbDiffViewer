/**
 * @fileoverview パラメータオブジェクト用の型定義
 *
 * 多数のパラメータを持つ関数をパラメータオブジェクトパターンに
 * リファクタリングする際に使用する型定義を提供します。
 *
 * @module viewer/types/parameterTypes
 */

// ============================================
// 共通型定義
// ============================================

/**
 * 3D座標
 * @typedef {Object} Vector3
 * @property {number} x - X座標
 * @property {number} y - Y座標
 * @property {number} z - Z座標
 */

/**
 * 2D座標
 * @typedef {Object} Vector2
 * @property {number} x - X座標
 * @property {number} y - Y座標
 */

// ============================================
// DXF Viewer 関連
// ============================================

/**
 * テキストスプライト作成設定
 * @typedef {Object} TextSpriteConfig
 * @property {string} text - 表示テキスト
 * @property {Vector3} position - 表示位置
 * @property {number} scale - スケール
 * @property {number} color - テキスト色 (0xRRGGBB形式)
 * @property {number} [height=1] - テキスト高さ
 * @property {number} [rotation=0] - 回転角度（度）
 */

/**
 * 矢印ヘッド描画設定
 * @typedef {Object} ArrowHeadConfig
 * @property {THREE.Group} group - 追加先グループ
 * @property {Vector3} position - 矢印の先端位置
 * @property {number} direction - 方向 (1 または -1)
 * @property {number} scale - スケール
 * @property {number} color - 矢印色 (0xRRGGBB形式)
 */

/**
 * 寸法テキストスプライト作成設定
 * @typedef {Object} DimensionTextSpriteConfig
 * @property {string} text - 表示テキスト
 * @property {Vector3} position - 表示位置
 * @property {number} scale - スケール
 * @property {number} color - テキスト色 (0xRRGGBB形式)
 * @property {number} [rotation=0] - 回転角度（ラジアン）
 */

// ============================================
// Labels 関連
// ============================================

/**
 * ラベル作成設定
 * @typedef {Object} LabelConfig
 * @property {string} text - ラベルテキスト
 * @property {Vector3} position - ラベル位置
 * @property {string} elementType - 要素タイプ (例: 'Node', 'Column')
 * @property {string} elementId - 要素ID
 * @property {string} [modelSource='A'] - モデルソース ('A', 'B', 'matched')
 * @property {LabelOptions} [options={}] - 追加オプション
 */

/**
 * ラベルオプション
 * @typedef {Object} LabelOptions
 * @property {number} [fontSize=16] - フォントサイズ
 * @property {string} [fontFamily] - フォントファミリー。省略時は共通タイポグラフィ設定を使用
 * @property {string} [color='rgba(0, 0, 0, 1)'] - テキスト色
 * @property {number} [padding=6] - パディング
 */

// ============================================
// Layout 関連
// ============================================

/**
 * 一点鎖線パターンの点描画設定
 * @typedef {Object} DotPatternConfig
 * @property {THREE.Vector3} start - 線の始点
 * @property {THREE.Vector3} direction - 正規化された方向ベクトル
 * @property {number} totalLength - 線の全長
 * @property {DotPatternStyle} style - 点パターンスタイル
 * @property {Object} userData - セグメントのメタデータ
 */

/**
 * 一点鎖線パターンスタイル
 * @typedef {Object} DotPatternStyle
 * @property {number} cycleLength - 1サイクルの長さ (DASH + GAP + DOT + GAP)
 * @property {number} dashLength - ダッシュ（長い実線）の長さ
 * @property {number} gapLength - 隙間の長さ
 * @property {number} dotLength - 点（短い実線）の長さ
 */

// ============================================
// RC柱ビジュアルレンダラー関連
// ============================================

/**
 * 矩形断面鉄筋描画設定
 * @typedef {Object} RectangularRebarConfig
 * @property {SVGElement} svg - 描画先SVG要素
 * @property {Object} mainBar - 主筋設定
 * @property {RectBounds} rectBounds - 断面の矩形座標
 * @property {number} coverScaled - スケール済みかぶり厚さ
 */

/**
 * 断面の矩形座標
 * @typedef {Object} RectBounds
 * @property {number} x - 左上X座標
 * @property {number} y - 左上Y座標
 * @property {number} width - 幅
 * @property {number} height - 高さ
 */

/**
 * 芯鉄筋描画設定
 * @typedef {Object} CoreRebarConfig
 * @property {SVGElement} svg - 描画先SVG要素
 * @property {Object} coreBar - 芯鉄筋設定
 * @property {RectBounds} rectBounds - 断面の矩形座標
 * @property {number} coverScaled - スケール済みかぶり厚さ
 */

// ============================================
// エクスポート
// ============================================

// JSDoc用の型定義ファイルのため、実行時エクスポートは空オブジェクト
export const Types = {};
