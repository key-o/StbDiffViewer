/**
 * @fileoverview 柱・梁・スラブ断面リストをシート一覧から開くコマンド（#559 c）。
 * 断面リスト本体は既存のフローティングウィンドウ（sectionList/*Panel）をそのまま使い、
 * 簡易CADのシート一覧がウィンドウの開閉を担う。
 */
import { floatingWindowManager } from '../floatingWindowManager.js';

/** 断面リスト種別 → 既存パネルのウィンドウID・表示名。 */
export const CAD_SECTION_LIST_WINDOWS = Object.freeze({
  column: Object.freeze({
    windowId: 'column-section-list-window',
    label: '柱リスト',
    icon: 'column',
  }),
  beam: Object.freeze({ windowId: 'beam-section-list-window', label: '梁リスト', icon: 'beam' }),
  'steel-column': Object.freeze({
    windowId: 'steel-column-section-list-window',
    label: 'S柱リスト',
    icon: 'column',
  }),
  'steel-beam': Object.freeze({
    windowId: 'steel-beam-section-list-window',
    label: 'S梁リスト',
    icon: 'beam',
  }),
  'src-column': Object.freeze({ windowId: 'src-column-section-list-window', label: 'SRC柱リスト', icon: 'column' }),
  'src-beam': Object.freeze({ windowId: 'src-beam-section-list-window', label: 'SRC梁リスト', icon: 'beam' }),
  slab: Object.freeze({
    windowId: 'slab-section-list-window',
    label: 'スラブリスト',
    icon: 'slab',
  }),
});

/** 断面リストのウィンドウを開く（開いていれば前面化のため再表示）。 */
export function openCadSectionListWindow(listType, manager = floatingWindowManager) {
  const def = CAD_SECTION_LIST_WINDOWS[listType];
  if (!def) throw new RangeError(`未対応の断面リスト種別です: ${listType}`);
  manager.showWindow(def.windowId);
  return def.windowId;
}
