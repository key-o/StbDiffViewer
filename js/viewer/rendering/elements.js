/**
 * @fileoverview 構造要素描画モジュール（公開エントリ）
 *
 * このファイルは、構造要素の3D表現を生成する機能の公開窓口です：
 * - 線要素（柱、梁など）の描画 → ./lineElements.js
 * - ポリゴン要素（スラブ、壁など）の描画 → ./polyElements.js
 * - 節点要素の描画 → ./nodeElements.js
 * - 要素のラベル生成・共通ヘルパー → ./elementsShared.js
 *
 * ラベルプロバイダーの可変状態は ./elementsShared.js にのみ保持されます。
 * 実装を追加する場合は各責務別モジュールへ配置し、ここでは再エクスポートのみを行います。
 *
 * @module viewer/rendering/elements
 */

export { setElementsLabelProvider } from './elementsShared.js';
export { drawLineElements } from './lineElements.js';
export { drawPolyElements } from './polyElements.js';
export { drawNodes } from './nodeElements.js';
