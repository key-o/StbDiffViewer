/**
 * @fileoverview 鉄筋径別の3D表示色。
 *
 * 既存の統一カラーパレットを使い、表示要素設定の「鉄筋径」から上書きできる既定値を定義する。
 */

import { COLORS } from './colorConfig.js';

export const DEFAULT_REBAR_DIAMETER_COLORS = Object.freeze({
  D6: COLORS.GREY_DARK,
  D10: COLORS.BLUE,
  D13: COLORS.GREEN,
  D16: COLORS.AMBER,
  D19: COLORS.RED,
  D22: COLORS.PURPLE,
  D25: COLORS.CYAN,
  D29: COLORS.ORANGE,
  D32: COLORS.LIGHT_GREEN,
  D35: COLORS.PINK,
  D38: COLORS.BLUE_GREY,
  D41: COLORS.BROWN,
  D51: COLORS.DEEP_ORANGE,
  DEFAULT: '#2F6FD0',
});

export default DEFAULT_REBAR_DIAMETER_COLORS;
