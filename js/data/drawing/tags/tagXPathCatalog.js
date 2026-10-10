/**
 * @fileoverview カテゴリ別のSTB XPath候補と、TagFamily v1の`.`区切りキーからの移行表。
 *
 * 候補はエディタの入力補助であり、ここに無いXPathも記法の範囲内なら使用できる。
 * STB 2.0.2 / 2.1 で要素名が異なる箇所は版ごとのpathを `|` で併記する。
 */
import { TAG_MEMBER_ELEMENT_BY_CATEGORY } from './tagXPath.js';

const union = (...paths) => paths.join(' | ');

export const STB_SECTION_ELEMENTS_BY_CATEGORY = Object.freeze({
  Girder: Object.freeze(['StbSecBeam_RC', 'StbSecBeam_S', 'StbSecBeam_SRC']),
  Beam: Object.freeze(['StbSecBeam_RC', 'StbSecBeam_S', 'StbSecBeam_SRC']),
  Column: Object.freeze([
    'StbSecColumn_RC',
    'StbSecColumn_S',
    'StbSecColumn_SRC',
    'StbSecColumn_CFT',
  ]),
  Post: Object.freeze([
    'StbSecColumn_RC',
    'StbSecColumn_S',
    'StbSecColumn_SRC',
    'StbSecColumn_CFT',
  ]),
  Brace: Object.freeze(['StbSecBrace_S']),
  Slab: Object.freeze(['StbSecSlab_RC', 'StbSecSlabDeck', 'StbSecSlabPrecast']),
  Wall: Object.freeze(['StbSecWall_RC']),
});

const sectionName = (category) =>
  union(...STB_SECTION_ELEMENTS_BY_CATEGORY[category].map((section) => `${section}/@name`));

const BEAM_FIGURE = 'StbSecBeam_RC/StbSecFigureBeam_RC';
const BEAM = Object.freeze({
  width: union(
    `${BEAM_FIGURE}/StbSecBeamStraight/@width`,
    `${BEAM_FIGURE}/StbSecBeamTaper/@start_width`,
    `${BEAM_FIGURE}/StbSecBeamTaper/@end_width`,
    `${BEAM_FIGURE}/StbSecBeam_RC_Straight/@width`,
    `${BEAM_FIGURE}/StbSecBeam_RC_Taper/@width`,
  ),
  depth: union(
    `${BEAM_FIGURE}/StbSecBeamStraight/@depth`,
    `${BEAM_FIGURE}/StbSecBeamTaper/@start_depth`,
    `${BEAM_FIGURE}/StbSecBeamTaper/@end_depth`,
    `${BEAM_FIGURE}/StbSecBeam_RC_Straight/@depth`,
    `${BEAM_FIGURE}/StbSecBeam_RC_Taper/@depth`,
  ),
  verticalOffset: union(
    `${BEAM_FIGURE}/StbSecBeamStraight/@vertical_offset`,
    `${BEAM_FIGURE}/StbSecBeamTaper/@start_vertical_offset`,
    `${BEAM_FIGURE}/StbSecBeamTaper/@end_vertical_offset`,
  ),
});

const SLAB_21 = 'StbSecSlab_RC/StbSecSlab_RC_Conventional/StbSecFigureSlab_RC_Conventional';
const SLAB_202 = 'StbSecSlab_RC/StbSecFigureSlab_RC';
const SLAB = Object.freeze({
  thickness: union(
    `${SLAB_21}/StbSecSlab_RC_ConventionalStraight/@depth`,
    `${SLAB_21}/StbSecSlab_RC_ConventionalTaper/@base_depth`,
    `${SLAB_21}/StbSecSlab_RC_ConventionalTaper/@tip_depth`,
    `${SLAB_202}/StbSecSlab_RC_Straight/@depth`,
    `${SLAB_202}/StbSecSlab_RC_Taper/@depth`,
  ),
  tipOffset: `${SLAB_21}/StbSecSlab_RC_ConventionalTaper/@tip_offset`,
});

const columnFigure = (kind, shape202, shape21, attribute) =>
  union(
    `StbSecColumn_${kind}/StbSecFigureColumn_${kind}/${shape21}/@${attribute}`,
    `StbSecColumn_${kind}/StbSecFigureColumn_${kind}/StbSecColumn_${kind}_${shape202}/@${attribute}`,
  );

const COLUMN = Object.freeze({
  widthX: union(
    columnFigure('RC', 'Rect', 'StbSecColumnRect', 'width_X'),
    columnFigure('SRC', 'Rect', 'StbSecColumnRect', 'width_X'),
  ),
  widthY: union(
    columnFigure('RC', 'Rect', 'StbSecColumnRect', 'width_Y'),
    columnFigure('SRC', 'Rect', 'StbSecColumnRect', 'width_Y'),
  ),
  diameter: union(
    columnFigure('RC', 'Circle', 'StbSecColumnCircle', 'D'),
    columnFigure('SRC', 'Circle', 'StbSecColumnCircle', 'D'),
  ),
  concreteStrength: union(
    'StbSecColumn_RC/@strength_concrete',
    'StbSecColumn_SRC/@strength_concrete',
    'StbSecColumn_CFT/@strength_concrete',
  ),
  steelShape: union(
    'StbSecColumn_S/StbSecSteelFigureColumn_S/StbSecSteelColumn_S_Same/@shape',
    'StbSecColumn_CFT/StbSecSteelFigureColumn_CFT/StbSecSteelColumn_CFT_Same/@shape',
  ),
  steelStrength: union(
    'StbSecColumn_S/StbSecSteelFigureColumn_S/StbSecSteelColumn_S_Same/@strength_main',
    'StbSecColumn_CFT/StbSecSteelFigureColumn_CFT/StbSecSteelColumn_CFT_Same/@strength',
  ),
});

const COLUMN_BAR = 'StbSecColumn_RC/StbSecBarArrangementColumn_RC';
const RECT_BAR_KINDS = Object.freeze(['RectSame', 'RectNotSame']);
const CIRCLE_BAR_KINDS = Object.freeze(['CircleSame', 'CircleNotSame']);
/** 2.0.2形式(StbSecBarColumn_RC_*)と2.1 Simple形式の同じ意味の属性を版ごとに併記する。 */
const columnBars = (kinds, legacyAttribute, simpleAttribute = legacyAttribute) =>
  union(
    ...kinds.map((kind) => `${COLUMN_BAR}/StbSecBarColumn_RC_${kind}/@${legacyAttribute}`),
    ...(simpleAttribute
      ? kinds.map(
          (kind) =>
            `${COLUMN_BAR}/StbSecBarColumn${kind}/StbSecBarColumn${kind}Simple/@${simpleAttribute}`,
        )
      : []),
  );
const ALL_BAR_KINDS = [...RECT_BAR_KINDS, ...CIRCLE_BAR_KINDS];

/**
 * RC柱配筋。矩形の主筋本数はX/Y方向の1段筋本数(隅筋を含む1面の本数)を別に持つ。
 * 総本数は2.0.2の N_main_total だけにあり、2.1 Simple形式には無い。
 */
const COLUMN_REBAR = Object.freeze({
  mainCountX: columnBars(RECT_BAR_KINDS, 'N_main_X_1st', 'N_X'),
  mainCountY: columnBars(RECT_BAR_KINDS, 'N_main_Y_1st', 'N_Y'),
  mainCountCircle: columnBars(CIRCLE_BAR_KINDS, 'N_main'),
  mainCountTotal: columnBars(RECT_BAR_KINDS, 'N_main_total', null),
  mainDiameter: columnBars(ALL_BAR_KINDS, 'D_main'),
  hoopDiameter: columnBars(ALL_BAR_KINDS, 'D_band', 'D_hoop'),
  hoopPitch: columnBars(ALL_BAR_KINDS, 'pitch_band', 'pitch_hoop'),
});

const BRACE = Object.freeze({
  steelShape: 'StbSecBrace_S/StbSecSteelFigureBrace_S/StbSecSteelBrace_S_Same/@shape',
  steelStrength: 'StbSecBrace_S/StbSecSteelFigureBrace_S/StbSecSteelBrace_S_Same/@strength_main',
});

const WALL = Object.freeze({
  thickness: 'StbSecWall_RC/StbSecFigureWall_RC/StbSecWall_RC_Straight/@t',
  concreteStrength: 'StbSecWall_RC/@strength_concrete',
});

/** RC柱/RC梁断面の豆図。要素pathで断面全体(外形+配筋)を参照する。 */
export const RC_COLUMN_SECTION_FIGURE_XPATH = 'StbSecColumn_RC';
export const RC_BEAM_SECTION_FIGURE_XPATH = 'StbSecBeam_RC';

function memberEntries(category) {
  const member = TAG_MEMBER_ELEMENT_BY_CATEGORY[category];
  return [
    ['部材ID', `${member}/@id`],
    ['部材名', `${member}/@name`],
    ['断面ID', `${member}/@id_section`],
    ['断面符号', sectionName(category)],
  ];
}

function additionEntries(category) {
  const member = TAG_MEMBER_ELEMENT_BY_CATEGORY[category];
  const sides = category === 'Slab' ? ['top', 'bottom'] : ['top', 'bottom', 'left', 'right'];
  return sides.map((side) => [`増打ち(${side})`, `${member}/@thickness_add_${side}`]);
}

const entries = (list) => Object.freeze(list.map(([label, key]) => Object.freeze({ label, key })));

export const TAG_XPATH_CATALOG_BY_CATEGORY = Object.freeze({
  Girder: entries([
    ...memberEntries('Girder'),
    ['梁幅', BEAM.width],
    ['梁せい', BEAM.depth],
    ['鉛直オフセット', BEAM.verticalOffset],
    ...additionEntries('Girder'),
    ['RC梁断面図(豆図)', RC_BEAM_SECTION_FIGURE_XPATH],
  ]),
  Beam: entries([
    ...memberEntries('Beam'),
    ['梁幅', BEAM.width],
    ['梁せい', BEAM.depth],
    ['鉛直オフセット', BEAM.verticalOffset],
    ...additionEntries('Beam'),
    ['RC梁断面図(豆図)', RC_BEAM_SECTION_FIGURE_XPATH],
  ]),
  Column: entries([
    ...memberEntries('Column'),
    ['構造種別', 'StbColumn/@kind_structure'],
    ['柱幅X', COLUMN.widthX],
    ['柱幅Y', COLUMN.widthY],
    ['直径', COLUMN.diameter],
    ['コンクリート強度', COLUMN.concreteStrength],
    ['鋼材形状', COLUMN.steelShape],
    ['鋼材強度', COLUMN.steelStrength],
    ['主筋本数X', COLUMN_REBAR.mainCountX],
    ['主筋本数Y', COLUMN_REBAR.mainCountY],
    ['主筋本数(円形)', COLUMN_REBAR.mainCountCircle],
    ['主筋総本数(2.0.2)', COLUMN_REBAR.mainCountTotal],
    ['主筋径', COLUMN_REBAR.mainDiameter],
    ['帯筋径', COLUMN_REBAR.hoopDiameter],
    ['帯筋ピッチ', COLUMN_REBAR.hoopPitch],
    ['RC柱断面図(豆図)', RC_COLUMN_SECTION_FIGURE_XPATH],
  ]),
  Post: entries([
    ...memberEntries('Post'),
    ['構造種別', 'StbPost/@kind_structure'],
    ['柱幅X', COLUMN.widthX],
    ['柱幅Y', COLUMN.widthY],
    ['直径', COLUMN.diameter],
    ['コンクリート強度', COLUMN.concreteStrength],
    ['鋼材形状', COLUMN.steelShape],
    ['鋼材強度', COLUMN.steelStrength],
    ['主筋本数X', COLUMN_REBAR.mainCountX],
    ['主筋本数Y', COLUMN_REBAR.mainCountY],
    ['主筋本数(円形)', COLUMN_REBAR.mainCountCircle],
    ['主筋総本数(2.0.2)', COLUMN_REBAR.mainCountTotal],
    ['主筋径', COLUMN_REBAR.mainDiameter],
    ['帯筋径', COLUMN_REBAR.hoopDiameter],
    ['帯筋ピッチ', COLUMN_REBAR.hoopPitch],
    ['RC柱断面図(豆図)', RC_COLUMN_SECTION_FIGURE_XPATH],
  ]),
  Brace: entries([
    ...memberEntries('Brace'),
    ['構造種別', 'StbBrace/@kind_structure'],
    ['鋼材形状', BRACE.steelShape],
    ['鋼材強度', BRACE.steelStrength],
  ]),
  Slab: entries([
    ...memberEntries('Slab'),
    ['スラブ厚', SLAB.thickness],
    ['先端下がり', SLAB.tipOffset],
    ...additionEntries('Slab'),
  ]),
  Wall: entries([
    ...memberEntries('Wall'),
    ['構造種別', 'StbWall/@kind_structure'],
    ['配置種別', 'StbWall/@kind_layout'],
    ['壁種別', 'StbWall/@kind_wall'],
    ['壁厚', WALL.thickness],
    ['コンクリート強度', WALL.concreteStrength],
  ]),
});

/** built-in詳細タグ用の名前付きXPath。 */
export const STB_TAG_XPATHS = Object.freeze({
  sectionName,
  beam: BEAM,
  slab: SLAB,
  column: COLUMN,
  columnRebar: COLUMN_REBAR,
  addition: (category, side) =>
    `${TAG_MEMBER_ELEMENT_BY_CATEGORY[category]}/@thickness_add_${side}`,
});

/**
 * TagFamily v1の`.`区切りキー→XPath。nullはSTB原本に直接の値が無く、v2で廃止したキー。
 * 旧 drawing.mark は図面符号の取得元である断面名称へ写像する。
 */
export function legacyTagParameterXPath(category, legacyKey) {
  const member = TAG_MEMBER_ELEMENT_BY_CATEGORY[category];
  const common = {
    'drawing.mark': sectionName(category),
    'section.mark': sectionName(category),
    'member.id': `${member}/@id`,
    'member.name': `${member}/@name`,
    'section.id': `${member}/@id_section`,
    'member.kindStructure': `${member}/@kind_structure`,
    'member.kindLayout': `${member}/@kind_layout`,
    'member.kindWall': `${member}/@kind_wall`,
    'addition.top': `${member}/@thickness_add_top`,
    'addition.bottom': `${member}/@thickness_add_bottom`,
    'addition.left': `${member}/@thickness_add_left`,
    'addition.right': `${member}/@thickness_add_right`,
  };
  const byCategory = {
    Girder: {
      'section.width': BEAM.width,
      'section.depth': BEAM.depth,
      'section.verticalOffset': BEAM.verticalOffset,
    },
    Beam: {
      'section.width': BEAM.width,
      'section.depth': BEAM.depth,
      'section.verticalOffset': BEAM.verticalOffset,
    },
    Slab: { 'section.thickness': SLAB.thickness, 'section.tipOffset': SLAB.tipOffset },
    Column: {
      'section.widthX': COLUMN.widthX,
      'section.widthY': COLUMN.widthY,
      'section.diameter': COLUMN.diameter,
      'section.concreteStrength': COLUMN.concreteStrength,
      'section.steelShape': COLUMN.steelShape,
      'section.steelStrength': COLUMN.steelStrength,
    },
    Brace: { 'section.steelShape': BRACE.steelShape, 'section.steelStrength': BRACE.steelStrength },
    Wall: {
      'section.thickness': WALL.thickness,
      'section.concreteStrength': WALL.concreteStrength,
    },
  };
  byCategory.Post = byCategory.Column;
  if (Object.hasOwn(byCategory[category] || {}, legacyKey)) return byCategory[category][legacyKey];
  if (Object.hasOwn(common, legacyKey)) return common[legacyKey];
  return null;
}
