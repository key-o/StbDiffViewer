/**
 * @fileoverview UI要素IDと要素タイプのマッピング設定
 */

/**
 * 要素タイプと立体表示チェックボックスIDのマッピング
 * @type {Object.<string, string>}
 */
export const VIEW_MODE_CHECKBOX_IDS = {
  Column: 'toggleColumnView',
  Post: 'togglePost3DView',
  Girder: 'toggleGirderView',
  Beam: 'toggleBeam3DView',
  Brace: 'toggleBrace3DView',
  IsolatingDevice: 'toggleIsolatingDevice3DView',
  DampingDevice: 'toggleDampingDevice3DView',
  FrameDampingDevice: 'toggleFrameDampingDevice3DView',
  Pile: 'togglePile3DView',
  StripFooting: 'toggleStripFooting3DView',
  Slab: 'toggleSlab3DView',
  Wall: 'toggleWall3DView',
  Parapet: 'toggleParapet3DView',
};

/**
 * 再描画が必要な要素タイプのセット
 * ラベル表示切替時に再描画を実行する要素タイプ
 * @type {Set<string>}
 */
export const REDRAW_REQUIRED_ELEMENT_TYPES = new Set([
  'Node',
  'Column',
  'Girder',
  'Beam',
  'Brace',
  'Post',
  'IsolatingDevice',
  'DampingDevice',
  'FrameDampingDevice',
  'Pile',
  'Footing',
  'StripFooting',
  'FoundationColumn',
  'Slab',
  'Wall',
  'Parapet',
  'Joint',
]);
