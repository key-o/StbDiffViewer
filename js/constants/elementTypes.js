/**
 * @fileoverview 要素タイプ定義（単一の情報源 - SSOT）
 *
 * アプリケーション全体で使用する要素タイプを一元管理します。
 * このファイルはthree.jsなどの外部依存を持たず、
 * テスト環境でも安全にインポートできます。
 *
 * 新要素追加時はここに追加し、適切なカテゴリにも振り分けてください。
 */

/**
 * サポートされる全要素タイプ
 * @type {string[]}
 */
export const SUPPORTED_ELEMENTS = [
  'Node',
  'Column',
  'Post',
  'Girder',
  'Beam',
  'Brace',
  'Slab',
  'Wall',
  'Parapet',
  'Joint',
  'Axis',
  'Story',
  'Pile',
  'Footing',
  'StripFooting',
  'FoundationColumn',
  'IsolatingDevice',
  'DampingDevice',
  'FrameDampingDevice',
  'Undefined', // StbSecUndefined断面を参照する要素（常にラインのみ表示）
];

/**
 * 表示モード（立体/線）切替対応要素
 * Node, Axis, Story は表示モード切替の対象外
 * Footing, FoundationColumn, Joint は立体表示のみ（切替不要）
 * @type {string[]}
 */
export const DISPLAY_MODE_ELEMENTS = [
  'Column',
  'Post',
  'Girder',
  'Beam',
  'Brace',
  'Slab',
  'Wall',
  'Parapet',
  'Pile',
  'StripFooting',
  'IsolatingDevice',
  'DampingDevice',
  'FrameDampingDevice',
];

/**
 * 立体表示のみの要素（線表示に切替不可）
 * 点配置要素（1ノード要素）や接合など、線表示が意味をなさない要素
 * @type {string[]}
 */
export const SOLID_ONLY_ELEMENTS = ['Footing', 'FoundationColumn', 'Joint'];

/**
 * ラベル表示対応要素（全要素）
 * @type {string[]}
 */
export const LABEL_ELEMENTS = [...SUPPORTED_ELEMENTS];

/**
 * 色設定対応要素（Axis, Storyを除く）
 * 通り芯と階はLAYOUT_COLORSで別管理
 * @type {string[]}
 */
export const COLOR_ELEMENTS = [
  'Node',
  'Column',
  'Post',
  'Girder',
  'Beam',
  'Brace',
  'Slab',
  'Wall',
  'Parapet',
  'Joint',
  'Pile',
  'Footing',
  'StripFooting',
  'FoundationColumn',
  'IsolatingDevice',
  'DampingDevice',
  'FrameDampingDevice',
  'Undefined',
];

/**
 * 要素カテゴリ（用途別グループ化）
 * @type {Object.<string, string[]>}
 */
export const ELEMENT_CATEGORIES = {
  STRUCTURAL: ['Column', 'Post', 'Girder', 'Beam', 'Brace', 'Joint'],
  SEISMIC: ['IsolatingDevice', 'DampingDevice', 'FrameDampingDevice'],
  SURFACE: ['Slab', 'Wall', 'Parapet'],
  FOUNDATION: ['Pile', 'Footing', 'StripFooting', 'FoundationColumn'],
  REFERENCE: ['Node', 'Axis', 'Story'],
};

/**
 * 要素タイプのセット（高速検索用）
 * @type {Set<string>}
 */
export const SUPPORTED_ELEMENTS_SET = new Set(SUPPORTED_ELEMENTS);

/**
 * 要素タイプがサポートされているか確認
 * @param {string} elementType
 * @returns {boolean}
 */
export function isSupportedElement(elementType) {
  return SUPPORTED_ELEMENTS_SET.has(elementType);
}

/**
 * STB XML タグ名定数
 *
 * 定義本体は STB読み込み共通カーネル（common-stb/import/）にあります。
 * アプリケーション層は従来どおり本モジュールから import してください。
 * （共通カーネルは外部ライブラリ相当の最下層として扱うため、
 * constants からの re-export はレイヤールール違反になりません）
 */
export { STB_TAG_NAMES } from '../common-stb/import/constants/stbTagNames.js';
