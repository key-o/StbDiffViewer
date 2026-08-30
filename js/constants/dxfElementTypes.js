/**
 * @fileoverview DXFエクスポート要素タイプ定数
 *
 * DXFエクスポートで使用する要素タイプと色設定を定義します。
 * @module constants/dxfElementTypes
 */

/** エクスポート可能な要素タイプ一覧 */
export const EXPORTABLE_ELEMENT_TYPES = [
  'Column',
  'Post',
  'Girder',
  'Beam',
  'Brace',
  'Slab',
  'Wall',
  'Open',
  'Footing',
  'StripFooting',
  'Pile',
  'Parapet',
  'Node',
];

/** 要素タイプごとのDXFレイヤー色（ACI: AutoCAD Color Index） */
export const ELEMENT_TYPE_COLORS = {
  Column: 1, // 赤
  Post: 1, // 赤
  Girder: 3, // 緑
  Beam: 3, // 緑
  Brace: 5, // 青
  Slab: 4, // シアン
  Wall: 6, // マゼンタ
  Open: 2, // 黄色（開口）
  Footing: 8, // グレー
  StripFooting: 8, // グレー
  Pile: 8, // グレー
  Parapet: 30, // オレンジ
  Node: 7, // 白/黒
  Axis: 2, // 黄色
  Level: 2, // 黄色
  Label: 7, // 白/黒
};
