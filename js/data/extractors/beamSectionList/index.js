/**
 * @fileoverview RC梁断面リスト用データ抽出モジュール（公開API）
 *
 * STBファイルからRC梁断面リストに必要なデータを抽出し、グリッド形式（階×符号マトリクス）で返す。
 * STB v2.0.2と v2.1の両方に対応しており、バージョンごとに異なるパーサーロジックを使用する。
 *
 * @module data/extractors/beamSectionList
 */

export { extractBeamSectionGrid, extractBeamSectionList } from './beamGrid.js';
