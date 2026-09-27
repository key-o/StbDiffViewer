/**
 * @fileoverview 鉄筋径別色管理。
 *
 * 部材別色と同じ createColorManager を使い、表示要素設定の鉄筋径色を管理する。
 */

import { DEFAULT_REBAR_DIAMETER_COLORS as CONFIG_REBAR_DIAMETER_COLORS } from '../../config/rebarDiameterColorConfig.js';
import { createColorManager } from './baseColorStateManager.js';

const {
  manager: rebarDiameterColorManager,
  types: REBAR_DIAMETER_COLOR_TYPES,
  defaults: DEFAULT_REBAR_DIAMETER_COLORS,
} = createColorManager({
  colorConfig: CONFIG_REBAR_DIAMETER_COLORS,
  managerName: 'RebarDiameterColorManager',
  methodPrefix: 'RebarDiameter',
  fallbackKey: 'DEFAULT',
});

/**
 * 呼び径の数値を色設定キーへ正規化する。
 * @param {number|string|null|undefined} diameterMm
 * @returns {string}
 */
export function normalizeRebarDiameterColorKey(diameterMm) {
  const numeric = Number(diameterMm);
  if (!(Number.isFinite(numeric) && numeric > 0)) return 'DEFAULT';
  const suffix = Number.isInteger(numeric) ? String(numeric) : String(numeric);
  const key = `D${suffix}`;
  return Object.prototype.hasOwnProperty.call(CONFIG_REBAR_DIAMETER_COLORS, key) ? key : 'DEFAULT';
}

export { rebarDiameterColorManager, REBAR_DIAMETER_COLOR_TYPES, DEFAULT_REBAR_DIAMETER_COLORS };
export default rebarDiameterColorManager;
