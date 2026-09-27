/**
 * @fileoverview Q2 panel quantity の互換 facade。
 * 追加規則が対象外の形状だけ既存calculatorへ委譲する。
 */

import { calculatePanelQuantity as calculateBasePanelQuantity } from './PanelQuantityCalculator.js';
import { calculateEnhancedPanelQuantity } from './PanelQuantityEnhancements.js';
import { calculateSlabTaperQuantity } from './SlabTaperQuantity.js';
import { calculateSlabHaunchQuantity } from './SlabHaunchQuantity.js';
import { calculateParapetProfileQuantity } from './ParapetProfileQuantity.js';

export const PANEL_QUANTITY_CALCULATOR_VERSION = 4;

export function calculatePanelQuantity(context) {
  return (
    calculateEnhancedPanelQuantity(context) ||
    calculateSlabTaperQuantity(context) ||
    calculateSlabHaunchQuantity(context) ||
    calculateParapetProfileQuantity(context) ||
    calculateBasePanelQuantity(context)
  );
}
