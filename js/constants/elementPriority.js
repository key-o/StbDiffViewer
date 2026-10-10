/**
 * @fileoverview 要素処理優先度の定義
 *
 * モデルの段階的読み込みで使用される要素タイプの処理優先順位を定義します。
 * 数値が小さいほど優先的に処理されます。
 *
 * @module constants/elementPriority
 */

/**
 * 要素タイプの処理優先度定義
 * 数値が小さいほど優先的に処理される
 * @constant {Object.<string, number>}
 */
export const ELEMENT_PRIORITY = {
  // Phase 1: 構造要素（最優先）
  StbColumn: 1,
  StbPost: 1,
  StbGirder: 2,
  StbBeam: 2,

  // Phase 2: 面要素
  StbSlab: 3,
  StbWall: 3,
  StbFrameDampingDevice: 3,

  // Phase 3: 基礎要素
  StbFooting: 4,
  StbPile: 4,
  StbFoundationColumn: 4,

  // Phase 4: 補助要素
  StbBrace: 5,
  StbIsolatingDevice: 5,
  StbDampingDevice: 5,
  StbOpening: 6,

  // Phase 5: 参照情報（最後）
  StbNode: 7,
  axes: 8,
  stories: 8,
};
