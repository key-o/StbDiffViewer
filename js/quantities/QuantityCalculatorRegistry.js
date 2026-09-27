/**
 * @fileoverview STB要素種別から派生数量 calculator を解決する registry。
 */

import {
  calculateFoundationColumnQuantity,
  calculateLinearMemberQuantity,
} from './calculators/LinearMemberQuantityCalculator.js';
import { calculatePanelQuantity } from './calculators/PanelQuantityFacade.js';
import {
  calculateFootingQuantity,
  calculateStripFootingQuantity,
} from './calculators/FootingQuantityCalculator.js';
import { calculatePileQuantity } from './calculators/PileQuantityCalculator.js';

const registry = new Map();

export function registerQuantityCalculator(elementType, calculator) {
  if (!elementType || typeof calculator !== 'function') {
    throw new TypeError('elementType and calculator function are required');
  }
  registry.set(String(elementType), calculator);
}

export function getQuantityCalculator(elementType) {
  return registry.get(String(elementType)) || null;
}

export function calculateQuantity(context) {
  const calculator = getQuantityCalculator(context?.elementType);
  if (!calculator) return null;
  return calculator(context);
}

for (const type of ['StbColumn', 'StbPost', 'StbGirder', 'StbBeam', 'StbBrace']) {
  registerQuantityCalculator(type, calculateLinearMemberQuantity);
}
registerQuantityCalculator('StbFoundationColumn', calculateFoundationColumnQuantity);
for (const type of ['StbWall', 'StbSlab', 'StbParapet']) {
  registerQuantityCalculator(type, calculatePanelQuantity);
}
registerQuantityCalculator('StbFooting', calculateFootingQuantity);
registerQuantityCalculator('StbStripFooting', calculateStripFootingQuantity);
registerQuantityCalculator('StbPile', calculatePileQuantity);

export function getRegisteredQuantityTypes() {
  return [...registry.keys()];
}
