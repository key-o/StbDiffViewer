/**
 * @fileoverview 要素再描画設定レジストリ
 *
 * 各要素タイプのSTB固有メタデータを管理します。
 * ジオメトリ生成は viewer/geometry/GeometryGeneratorFactory で行います。
 *
 * @module config/elementRedrawConfig
 */

import { STB_TAG_NAMES } from '../constants/elementTypes.js';

/**
 * @typedef {Object} ElementRedrawConfig
 * @property {string} elementType - 要素タイプ名
 * @property {string} stbTagName - STB XMLタグ名
 * @property {string} nodeStartAttr - 開始ノード属性名
 * @property {string|null} nodeEndAttr - 終了ノード属性（単一ノード要素はnull）
 * @property {string} elementsKey - stbData内の要素キー
 * @property {string} sectionsKey - stbData内の断面キー
 * @property {boolean} [supportsLineMode=true] - 線表示モードをサポートするか
 * @property {string} [wallViewerElementType] - 壁要素の表示種別（'Wall'|'ShearWall'）。
 *   指定時は描画側（elementRedrawCore）が wallClassification で絞り込む
 */

/**
 * 要素再描画設定マップ（STBメタデータのみ）
 * ジェネレータ情報は viewer/geometry/GeometryGeneratorFactory.GENERATOR_MAP を参照
 * @type {Map<string, ElementRedrawConfig>}
 */
export const ELEMENT_REDRAW_CONFIGS = new Map([
  // 垂直要素（2ノード: bottom-top）
  [
    'Column',
    {
      elementType: 'Column',
      stbTagName: STB_TAG_NAMES.COLUMN,
      nodeStartAttr: 'id_node_bottom',
      nodeEndAttr: 'id_node_top',
      elementsKey: 'columnElements',
      sectionsKey: 'columnSections',
    },
  ],
  [
    'Post',
    {
      elementType: 'Post',
      stbTagName: STB_TAG_NAMES.POST,
      nodeStartAttr: 'id_node_bottom',
      nodeEndAttr: 'id_node_top',
      elementsKey: 'postElements',
      sectionsKey: 'postSections',
    },
  ],

  // 水平要素（2ノード: start-end）
  [
    'Girder',
    {
      elementType: 'Girder',
      stbTagName: STB_TAG_NAMES.GIRDER,
      nodeStartAttr: 'id_node_start',
      nodeEndAttr: 'id_node_end',
      elementsKey: 'girderElements',
      sectionsKey: 'girderSections',
    },
  ],
  [
    'Beam',
    {
      elementType: 'Beam',
      stbTagName: STB_TAG_NAMES.BEAM,
      nodeStartAttr: 'id_node_start',
      nodeEndAttr: 'id_node_end',
      elementsKey: 'beamElements',
      sectionsKey: 'beamSections',
    },
  ],
  [
    'Brace',
    {
      elementType: 'Brace',
      stbTagName: STB_TAG_NAMES.BRACE,
      nodeStartAttr: 'id_node_start',
      nodeEndAttr: 'id_node_end',
      elementsKey: 'braceElements',
      sectionsKey: 'braceSections',
    },
  ],
  [
    'Parapet',
    {
      elementType: 'Parapet',
      stbTagName: STB_TAG_NAMES.PARAPET,
      nodeStartAttr: 'id_node_start',
      nodeEndAttr: 'id_node_end',
      elementsKey: 'parapetElements',
      sectionsKey: 'parapetSections',
    },
  ],
  [
    'StripFooting',
    {
      elementType: 'StripFooting',
      stbTagName: STB_TAG_NAMES.STRIP_FOOTING,
      nodeStartAttr: 'id_node_start',
      nodeEndAttr: 'id_node_end',
      elementsKey: 'stripFootingElements',
      sectionsKey: 'footingSections',
    },
  ],

  // 免震装置（2ノード: start-end）
  [
    'IsolatingDevice',
    {
      elementType: 'IsolatingDevice',
      stbTagName: STB_TAG_NAMES.ISOLATING_DEVICE,
      nodeStartAttr: 'id_node_start',
      nodeEndAttr: 'id_node_end',
      elementsKey: 'isolatingDeviceElements',
      sectionsKey: 'isolatingDeviceSections',
    },
  ],

  // 制振装置（2ノード: start-end）
  [
    'DampingDevice',
    {
      elementType: 'DampingDevice',
      stbTagName: STB_TAG_NAMES.DAMPING_DEVICE,
      nodeStartAttr: 'id_node_start',
      nodeEndAttr: 'id_node_end',
      elementsKey: 'dampingDeviceElements',
      sectionsKey: 'dampingDeviceSections',
    },
  ],

  // 制振装置（フレーム）（4ノード面要素）
  [
    'FrameDampingDevice',
    {
      elementType: 'FrameDampingDevice',
      stbTagName: STB_TAG_NAMES.FRAME_DAMPING_DEVICE,
      nodeStartAttr: 'node_ids',
      nodeEndAttr: null,
      elementsKey: 'frameDampingDeviceElements',
      sectionsKey: 'dampingDeviceSections',
      supportsLineMode: true,
    },
  ],

  // 杭（2ノード: bottom-top）
  [
    'Pile',
    {
      elementType: 'Pile',
      stbTagName: STB_TAG_NAMES.PILE,
      nodeStartAttr: 'id_node_bottom',
      nodeEndAttr: 'id_node_top',
      elementsKey: 'pileElements',
      sectionsKey: 'pileSections',
    },
  ],

  // 単一ノード要素
  [
    'Footing',
    {
      elementType: 'Footing',
      stbTagName: STB_TAG_NAMES.FOOTING,
      nodeStartAttr: 'id_node',
      nodeEndAttr: null,
      elementsKey: 'footingElements',
      sectionsKey: 'footingSections',
      supportsLineMode: false,
    },
  ],
  [
    'FoundationColumn',
    {
      elementType: 'FoundationColumn',
      stbTagName: STB_TAG_NAMES.FOUNDATION_COLUMN,
      nodeStartAttr: 'id_node',
      nodeEndAttr: null,
      elementsKey: 'foundationColumnElements',
      sectionsKey: 'foundationcolumnSections',
    },
  ],

  // ポリゴン要素（複数ノード）
  [
    'Slab',
    {
      elementType: 'Slab',
      stbTagName: STB_TAG_NAMES.SLAB,
      nodeStartAttr: 'node_ids',
      nodeEndAttr: null,
      elementsKey: 'slabElements',
      sectionsKey: 'slabSections',
      supportsLineMode: true,
    },
  ],
  [
    'ShearWall',
    {
      elementType: 'ShearWall',
      stbTagName: STB_TAG_NAMES.WALL,
      nodeStartAttr: 'node_ids',
      nodeEndAttr: null,
      elementsKey: 'wallElements',
      sectionsKey: 'wallSections',
      supportsLineMode: true,
      wallViewerElementType: 'ShearWall',
    },
  ],
  [
    'Wall',
    {
      elementType: 'Wall',
      stbTagName: STB_TAG_NAMES.WALL,
      nodeStartAttr: 'node_ids',
      nodeEndAttr: null,
      elementsKey: 'wallElements',
      sectionsKey: 'wallSections',
      supportsLineMode: true,
      wallViewerElementType: 'Wall',
    },
  ],
]);

/**
 * 要素タイプの設定を取得
 * @param {string} elementType - 要素タイプ名
 * @returns {ElementRedrawConfig|undefined} 設定オブジェクト
 */
export function getElementRedrawConfig(elementType) {
  return ELEMENT_REDRAW_CONFIGS.get(elementType);
}

/**
 * すべての要素タイプ名を取得
 * @returns {string[]} 要素タイプ名の配列
 */
export function getAllElementTypes() {
  return Array.from(ELEMENT_REDRAW_CONFIGS.keys());
}

/**
 * 特定の機能をサポートする要素タイプを取得
 * @param {string} feature - 機能名（例: 'supportsLineMode'）
 * @param {boolean} [value=true] - 期待する値
 * @returns {string[]} 要素タイプ名の配列
 */
export function getElementTypesByFeature(feature, value = true) {
  const types = [];
  for (const [type, config] of ELEMENT_REDRAW_CONFIGS) {
    const featureValue = config[feature] !== undefined ? config[feature] : true;
    if (featureValue === value) {
      types.push(type);
    }
  }
  return types;
}

/**
 * 2ノード（線）要素のタイプを取得
 * @returns {string[]} 2ノード要素タイプ名の配列
 */
export function getLineElementTypes() {
  const types = [];
  for (const [type, config] of ELEMENT_REDRAW_CONFIGS) {
    if (config.nodeEndAttr !== null) {
      types.push(type);
    }
  }
  return types;
}

/**
 * 単一ノード要素のタイプを取得
 * @returns {string[]} 単一ノード要素タイプ名の配列
 */
export function getSingleNodeElementTypes() {
  const types = [];
  for (const [type, config] of ELEMENT_REDRAW_CONFIGS) {
    if (config.nodeEndAttr === null) {
      types.push(type);
    }
  }
  return types;
}
