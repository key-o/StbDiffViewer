/**
 * @fileoverview 差分サマリーパネルの共有ビュー状態
 *
 * このモジュールは、差分サマリーパネルの再描画をまたいで保持する必要がある
 * ビュー状態を一箇所に集約します:
 * - 要素タイプ別テーブルの分類軸（位置 / 属性 / 断面）の折りたたみ状態
 * - 直近に選択された定義タブ（断面 / 接合 / 開口 / STB定義）
 *
 * 折りたたみ状態は storageHelper で永続化され、定義タブの選択は
 * getter/setter 経由で他モジュールから参照・更新されます。
 */

import { storageHelper } from '../../../utils/storageHelper.js';

// ---------------------------------------------------------------------------
// 要素タイプ別テーブルの分類軸の折りたたみ状態
// 配置要素テーブルは「対応要素数」を親とし、その下に位置 / 属性 / 断面 の
// 3つの分類軸（それぞれ一致/不一致に分解）をぶら下げた3段ヘッダで表示する。
// 各軸は個別に展開/折りたたみでき、折りたたむと代表列（summaryKey）だけを表示する。
// ---------------------------------------------------------------------------

const GROUP_COLLAPSE_STORAGE_KEY = 'diffSummary:groupCollapse';

/**
 * 既定は全軸を展開する。
 * 折りたたむと配置要素の断面不一致（水色）・属性不一致（オレンジ）の列が隠れ、
 * 3Dジオメトリの色との対応が取れなくなるため。
 * キーは各分類軸の key（position / instance / section）。
 */
const DEFAULT_GROUP_COLLAPSE = { position: false, instance: false, section: false };

function loadGroupCollapse() {
  const saved = storageHelper.get(GROUP_COLLAPSE_STORAGE_KEY);
  return { ...DEFAULT_GROUP_COLLAPSE, ...(saved && typeof saved === 'object' ? saved : {}) };
}

let groupCollapse = loadGroupCollapse();

export function getGroupCollapse() {
  return groupCollapse;
}

export function toggleGroupCollapse(key) {
  groupCollapse = { ...groupCollapse, [key]: !groupCollapse[key] };
  storageHelper.set(GROUP_COLLAPSE_STORAGE_KEY, groupCollapse);
}

// 直近に選択された定義タブ（再描画をまたいで保持）。
let activeDefTab = 'section';

export function getActiveDefTab() {
  return activeDefTab;
}

export function setActiveDefTab(group) {
  activeDefTab = group;
}
