/**
 * @fileoverview 部材色設定とViewer色マネージャーの接続
 */

import {
  getElementColorPreferences,
  setElementColorPreference,
  setElementColorPreferences,
} from './elementColorPreferences.js';

const initializedManagers = new WeakSet();

/**
 * 保存済み設定を色マネージャーへ適用し、以降の変更を設定ストアへ反映する。
 * @param {Object} colorManager - 部材色操作・変更通知を提供するColorManager
 */
export function connectElementColorPreferences(colorManager) {
  if (initializedManagers.has(colorManager)) return;
  initializedManagers.add(colorManager);

  colorManager.setAllElementColors(getElementColorPreferences());
  colorManager.onElementColorChange((elementType, color) => {
    if (elementType === null) {
      setElementColorPreferences(colorManager.getAllElementColors());
    } else {
      setElementColorPreference(elementType, color);
    }
  });
}
