/**
 * @fileoverview RC柱断面ビジュアルコンポーネント
 *
 * RC柱断面リストの配置計算は columnScheduleModel をSSOTとし、
 * SVGレンダラーは ConfiguredRcColumnVisualRenderer に一本化する。
 */

export {
  ConfiguredRcColumnVisualRenderer as RcColumnVisualRenderer,
  ConfiguredRcColumnVisualRenderer,
  default,
} from './ConfiguredRcColumnVisualRenderer.js';
export {
  buildColumnScheduleGeometry,
  columnScheduleInputFromSection,
  parseColumnBarDiameterMm,
} from './columnScheduleModel.js';
export {
  REBAR_SYMBOLS,
  addBarSymbolDefs,
  placeBarSymbol,
  getAvailableDiameters,
  createSvgElement,
} from './rebarSymbolDefs.js';
