/**
 * A lightweight runtime-only bridge between the CAD session owner and the
 * beam/column list windows. No global persisted state or silent local copies.
 */
let getCadPanel = null;

export function registerDrawingSheetSessionProvider(provider) {
  if (typeof provider !== 'function')
    throw new TypeError('CAD session provider must be a function');
  getCadPanel = provider;
}

export function currentDrawingSheetSession() {
  return getCadPanel?.() ?? null;
}
