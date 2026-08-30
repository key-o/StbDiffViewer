/**
 * @fileoverview 新規部材追加フォームのフィールド定義（部材種別ごとの入力仕様）
 *
 * 部材タイプごとの表示ラベル・入力属性・参照可能なSTB断面ルートを定義する。
 * DOM・グローバル状態には触れない。
 *
 * @module ui/panels/element-info/addMemberForm/fieldDefs
 */

/** 部材タイプの表示ラベル */
export const TYPE_LABELS = {
  Node: '節点',
  Column: '柱',
  Post: '間柱',
  Girder: '大梁',
  Beam: '小梁',
  Brace: 'ブレース',
  Slab: '床',
  Wall: '壁',
  Pile: '杭',
  Footing: '基礎',
  FoundationColumn: '基礎柱',
  Parapet: 'パラペット',
  Story: '階',
  Axis: '通り芯',
  ArcAxis: '円弧軸',
  RadialAxis: '放射軸',
};

export const NODELIST_TYPES = new Set(['Story', 'Axis', 'ArcAxis', 'RadialAxis']);
export const FREE_GROUP_TYPES = new Set(['ArcAxis', 'RadialAxis']);

/** kind_structure の許容値（部材タイプ別）。 */
export const STRUCTURE_OPTIONS_BY_TYPE = {
  Column: ['RC', 'S', 'SRC', 'CFT', 'UNDEFINED'],
  Post: ['RC', 'S', 'SRC', 'CFT', 'UNDEFINED'],
  Girder: ['RC', 'S', 'SRC', 'UNDEFINED'],
  Beam: ['RC', 'S', 'SRC', 'UNDEFINED'],
  // StbBrace のXSD列挙には RC/S/SRC があるが、断面定義は現行仕様では StbSecBrace_S のみ。
  Brace: ['S'],
  Slab: ['RC', 'DECK', 'PRECAST', 'LOAD'],
  Wall: ['RC', 'LOAD'],
  Pile: ['RC', 'S', 'PC'],
  FoundationColumn: ['RC'],
  Parapet: ['RC'],
};

/** 属性ごとのフィールド定義 */
export const FIELD_DEFS = {
  X: { label: 'X 座標 (mm)', kind: 'number', default: '0' },
  Y: { label: 'Y 座標 (mm)', kind: 'number', default: '0' },
  Z: { label: 'Z 座標 (mm)', kind: 'number', default: '0' },
  id_node_bottom: { label: '下端節点', kind: 'node' },
  id_node_top: { label: '上端節点', kind: 'node' },
  id_node_start: { label: '始端節点', kind: 'node' },
  id_node_end: { label: '終端節点', kind: 'node' },
  id_node: { label: '配置節点', kind: 'node' },
  id_section: { label: '断面', kind: 'section' },
  id_section_FD: { label: '基礎部断面', kind: 'section' },
  id_section_WR: { label: '立上り部断面（任意）', kind: 'section' },
  rotate: { label: '回転角 (度)', kind: 'number', default: '0' },
  level_top: { label: '杭頭レベル (mm)', kind: 'number', default: '0' },
  level_bottom: { label: '底面レベル (mm)', kind: 'number', default: '0' },
  offset: { label: 'オフセット (mm)', kind: 'number', default: '0' },
  kind_structure: {
    label: '構造種別',
    kind: 'enum',
    options: ['S', 'RC', 'SRC', 'CFT', 'UNDEFINED'],
    default: 'S',
  },
  kind_slab: { label: '床種別', kind: 'enum', options: ['NORMAL', 'CANTI'], default: 'NORMAL' },
  isFoundation: { label: '基礎床', kind: 'enum', options: ['false', 'true'], default: 'false' },
  kind_layout: {
    label: '配置種別',
    kind: 'enum',
    options: ['ON_GIRDER', 'ON_BEAM', 'ON_SLAB'],
    default: 'ON_GIRDER',
  },
  name: { label: '名称', kind: 'text' },
  height: { label: '高さ (mm)', kind: 'number', default: '0' },
  distance: { label: '距離 (mm)', kind: 'number', default: '0' },
  group: { label: '軸グループ', kind: 'enum', options: ['X', 'Y'], default: 'X' },
  radius: { label: '半径 (mm)', kind: 'number', default: '1000' },
  angle: { label: '角度 (度)', kind: 'number', default: '0' },
  center_x: { label: '中心 X (mm)', kind: 'number', default: '0' },
  center_y: { label: '中心 Y (mm)', kind: 'number', default: '0' },
  start_angle: { label: '開始角 (度)', kind: 'number', default: '0' },
  end_angle: { label: '終了角 (度)', kind: 'number', default: '90' },
  kind: {
    label: '階種別',
    kind: 'enum',
    options: ['GENERAL', 'BASEMENT', 'ROOF', 'PENTHOUSE', 'ISOLATION', 'DEPENDENCE'],
    default: 'GENERAL',
  },
};

/** タイプごとに入力させる属性 */
export const TYPE_FIELDS = {
  Node: ['X', 'Y', 'Z'],
  Column: ['id_node_bottom', 'id_node_top', 'id_section', 'rotate', 'kind_structure'],
  Post: ['id_node_bottom', 'id_node_top', 'id_section', 'rotate', 'kind_structure'],
  Girder: ['id_node_start', 'id_node_end', 'id_section', 'rotate', 'kind_structure'],
  Beam: ['id_node_start', 'id_node_end', 'id_section', 'rotate', 'kind_structure'],
  Brace: ['id_node_start', 'id_node_end', 'id_section', 'rotate', 'kind_structure'],
  Slab: ['id_section', 'kind_structure', 'kind_slab', 'isFoundation'],
  Wall: ['id_section', 'kind_structure', 'kind_layout'],
  Pile: ['id_node', 'id_section', 'kind_structure', 'level_top'],
  Footing: ['id_node', 'id_section', 'level_bottom', 'rotate'],
  FoundationColumn: ['id_node', 'id_section_FD', 'id_section_WR', 'kind_structure', 'rotate'],
  Parapet: [
    'id_node_start',
    'id_node_end',
    'id_section',
    'kind_structure',
    'kind_layout',
    'offset',
  ],
  Story: ['name', 'height', 'kind'],
  Axis: ['group', 'name', 'distance'],
  ArcAxis: ['group', 'name', 'radius', 'center_x', 'center_y', 'start_angle', 'end_angle'],
  RadialAxis: ['group', 'name', 'angle', 'center_x', 'center_y'],
};

/**
 * 部材タイプごとの参照可能な断面ルート要素。
 *
 * 接頭辞ではなく XSD の StbSections 直下に定義された正確な要素名を列挙する。
 * openSectionBuilder 側で現在のSTBバージョンの StbSections 定義と積集合を取るため、
 * 2.1で追加された Load 断面は2.0.2では自動的に候補から除外される。
 *
 * StbFoundationColumn の id_section_FD / id_section_WR は ST-Bridge 仕様上
 * StbSecColumn_RC を参照するため、StbSecFoundation_RC ではない。
 */
export const MEMBER_SECTION_CONFIG = {
  Column: {
    roots: [
      'StbSecColumn_RC',
      'StbSecColumn_S',
      'StbSecColumn_SRC',
      'StbSecColumn_CFT',
      'StbSecUndefined',
    ],
  },
  Post: {
    roots: [
      'StbSecColumn_RC',
      'StbSecColumn_S',
      'StbSecColumn_SRC',
      'StbSecColumn_CFT',
      'StbSecUndefined',
    ],
  },
  Girder: { roots: ['StbSecBeam_RC', 'StbSecBeam_S', 'StbSecBeam_SRC', 'StbSecUndefined'] },
  Beam: { roots: ['StbSecBeam_RC', 'StbSecBeam_S', 'StbSecBeam_SRC', 'StbSecUndefined'] },
  Brace: { roots: ['StbSecBrace_S'] },
  Slab: {
    roots: ['StbSecSlab_RC', 'StbSecSlabDeck', 'StbSecSlabPrecast', 'StbSecSlabLoad'],
  },
  Wall: { roots: ['StbSecWall_RC', 'StbSecWallLoad'] },
  Pile: { roots: ['StbSecPile_RC', 'StbSecPile_S', 'StbSecPileProduct'] },
  Footing: { roots: ['StbSecFoundation_RC'] },
  FoundationColumn: { roots: ['StbSecColumn_RC'] },
  Parapet: { roots: ['StbSecParapet_RC'] },
};

export const VALIDATION_TAG_OVERRIDES = {
  Node: 'StbNode',
  Axis: 'StbParallelAxis',
  ArcAxis: 'StbArcAxis',
  RadialAxis: 'StbRadialAxis',
};
