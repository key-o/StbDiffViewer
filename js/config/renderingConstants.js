/**
 * @fileoverview レンダリング関連の定数定義
 *
 * Three.jsレンダリング、カメラ、UI表示に関する定数を一元管理します。
 * マジックナンバーを排除し、保守性を向上させます。
 */

// ============================================================================
// カメラ設定
// ============================================================================

/**
 * 正投影カメラのズーム設定
 */
export const CAMERA_ORTHOGRAPHIC = {
  ZOOM_FACTOR: 0.001,
  MIN_ZOOM: 0.01,
  MAX_ZOOM: 50,
};

/**
 * カメラ操作設定
 */
export const CAMERA_CONTROLS = {
  DRAG_THRESHOLD_PX: 3, // ドラッグと判定する最小ピクセル数
};

/**
 * 画面上の選択許容幅をワールド座標へ変換するための設定
 */
export const SELECTION_PICKING = {
  HOVER_LINE_TOLERANCE_PX: 8,
  CLICK_LINE_TOLERANCE_PX: 12,
  MIN_LINE_THRESHOLD_MM: 5,
  MAX_LINE_THRESHOLD_MM: 1000,
  FALLBACK_TARGET_DISTANCE_MM: 5000,
};

// ============================================================================
// ラベル表示設定
// ============================================================================

/**
 * ラベルキャンバスとフォント設定
 */
export const LABEL_SETTINGS = {
  // 標準ラベル
  FONT_SIZE: 45,
  CANVAS_WIDTH: 512,
  CANVAS_HEIGHT: 64,
  BASE_SCALE_X: 640,
  BASE_SCALE_Y: 80,
  OFFSET_X: 256, // CANVAS_WIDTH / 2
  OFFSET_Y: 32, // CANVAS_HEIGHT / 2

  // 通り芯ラベル（丸い背景）
  BALLOON_SIZE: 64,
  BALLOON_FONT_SIZE: 28,

  // 階ラベル（四角い背景）
  STORY_BOX_WIDTH: 80,
  STORY_BOX_HEIGHT: 48,
  STORY_FONT_SIZE: 24,

  // スケーリング設定
  REFERENCE_DISTANCE: 5000,
  MIN_SCALE_FACTOR: 5.0,
  MAX_SCALE_FACTOR: 30.0,
};

/**
 * ラベルオクルージョンチェック設定
 * ラベルの遮蔽判定と前面描画を制御します
 */
export const LABEL_OCCLUSION_SETTINGS = {
  // チェック頻度（間引き設定）
  CHECK_INTERVAL_FRAMES: 10, // フレーム間引き数（0で毎フレーム）
  CAMERA_MOVE_THRESHOLD: 100, // カメラ移動検出閾値 (mm)
  CAMERA_ROTATE_THRESHOLD: 0.02, // カメラ回転検出閾値 (ラジアン)

  // ヒステリシス設定（状態変化の安定化）
  HYSTERESIS_FRAMES: 5, // 状態変化に必要な連続フレーム数

  // ラベル単位の遮蔽判定
  SELF_OCCLUSION_EPSILON_MM: 30, // アンカー直前の接触は自身の部材面として許容
  OVERLAY_RENDER_ORDER: 10000, // 表示対象タグは部材より前面に描画
};

// ============================================================================
// グリッド設定
// ============================================================================

/**
 * グリッドヘルパーの設定
 */
export const GRID_SETTINGS = {
  SIZE: 100000, // グリッドのサイズ (mm)
  DIVISIONS: 100, // グリッドの分割数
  CENTER_LINE_COLOR: 0x888888, // 中心線の色
  GRID_LINE_COLOR: 0xcccccc, // グリッド線の色
};

// ============================================================================
// 通り芯・階表示設定
// ============================================================================

/**
 * 通り芯線のダッシュパターン（一点鎖線）
 */
export const AXIS_LINE_PATTERN = {
  DASH_LENGTH: 500, // 長い実線部分 (mm) - 短くしてサイクル数を増やす
  DOT_LENGTH: 200, // 点部分 (mm) - 視認性向上のため拡大
  GAP_LENGTH: 150, // 隙間 (mm) - 少し短く
};

// ============================================================================
// デフォルトエクスポート
// ============================================================================

export default {
  CAMERA_ORTHOGRAPHIC,
  CAMERA_CONTROLS,
  SELECTION_PICKING,
  LABEL_SETTINGS,
  LABEL_OCCLUSION_SETTINGS,
  GRID_SETTINGS,
  AXIS_LINE_PATTERN,
};
