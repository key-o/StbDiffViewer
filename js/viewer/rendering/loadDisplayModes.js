/**
 * @fileoverview 荷重表示モード定義
 *
 * LoadDisplayManager と各荷重種別の描画モジュールが共有する表示モード定数。
 * 循環参照を避けるため、定数のみを保持する最下層モジュールとして分離しています。
 *
 * @module viewer/rendering/loadDisplayModes
 */

/**
 * 表示モード
 */
export const LOAD_DISPLAY_MODE = {
  NONE: 'none',
  ARROW: 'arrow',
  LABEL: 'label',
  BOTH: 'both',
};
