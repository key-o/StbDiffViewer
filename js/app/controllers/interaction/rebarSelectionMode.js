/** @fileoverview 鉄筋ジオメトリ選択モードの状態 */

let active = false;

export function isRebarSelectionModeActive() {
  return active;
}

export function setRebarSelectionModeActive(value) {
  active = Boolean(value);
  return active;
}
