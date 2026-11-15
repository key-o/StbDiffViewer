/**
 * SRC柱・SRC梁断面リスト。ST-Bridge 2.0.2 / 2.1.x のSRC専用定義を抽出する。
 * S/RCリストと混在させず、kind_structure=SRC の使用部材だけを採用する。
 */
import {
  querySelector, querySelectorAll, extractStories, compareStoriesDescending, compareSymbols,
} from './sectionListUtils.js';
import { extractSteelProfiles } from './steelSectionListExtractor.js';

const TYPES = Object.freeze({
  'src-column': { member: 'StbColumn', section: 'StbSecColumn_SRC', a: 'id_node_bottom', b: 'id_node_top', steel: 'StbSecSteelFigureColumn_SRC', bar: 'StbSecBarArrangementColumn_SRC', figure: 'StbSecFigureColumn_SRC' },
  'src-beam': { member: 'StbGirder', section: 'StbSecBeam_SRC', a: 'id_node_start', b: 'id_node_end', steel: 'StbSecSteelFigureBeam_SRC', bar: 'StbSecBarArrangementBeam_SRC', figure: 'StbSecFigureBeam_SRC' },
});
const children = (node) => Array.from(node?.children || []);
const walk = (node) => children(node).flatMap((child) => [child, ...walk(child)]);
const attr = (node, ...names) => {
  for (const name of names) {
    const value = node?.getAttribute(name);
    if (value != null && value !== '') return value;
  }
  return '';
};
const positive = (node, ...names) => {
  const value = Number(attr(node, ...names));
  return Number.isFinite(value) && value > 0 ? value : null;
};
const first = (el, parentTag) => querySelector(el, parentTag);
const floorOf = (member, section, stories, type, def) => {
  const a = attr(member, def.a), b = attr(member, def.b);
  const bottom = [...stories.values()].filter((story) => story.nodeIds.has(a));
  const top = [...stories.values()].filter((story) => story.nodeIds.has(b));
  const common = bottom.filter((x) => top.some((y) => x.id === y.id));
  const candidates = type === 'src-column' ? (bottom.length ? bottom : top) : (common.length ? common : bottom.length ? bottom : top);
  if (candidates.length) return [...candidates].sort((x, y) => (x.level ?? 0) - (y.level ?? 0))[0];
  const floor = attr(section, 'floor') || attr(member, 'floor');
  return [...stories.values()].find((s) => s.id === floor || s.name === floor) || null;
};

function concreteFigures(section, def) {
  const root = first(section, def.figure);
  if (!root) return [];
  const entries = [];
  const findFigures = (node, order = '', pos = '') => {
    for (const child of children(node)) {
      const tag = child.localName || child.tagName;
      const currentOrder = attr(child, 'order') || order;
      const currentPos = attr(child, 'pos', 'position') || pos;
      if (/Column.*(?:Rect|Circle)$|Beam.*(?:Straight|Taper|Haunch)$/.test(tag)) {
        const width = positive(child, 'width_X', 'depth_X', 'width');
        const height = positive(child, 'width_Y', 'depth_Y', 'depth');
        const diameter = positive(child, 'D');
        if (width && height) entries.push({ kind: 'rect', width, height, order: currentOrder, pos: currentPos });
        else if (diameter) entries.push({ kind: 'circle', diameter, order: currentOrder, pos: currentPos });
      } else findFigures(child, currentOrder, currentPos);
    }
  };
  findFigures(root, attr(root, 'order'), attr(root, 'pos', 'position'));
  return entries;
}

function steelVariants(section, def, profiles) {
  const root = first(section, def.steel);
  if (!root) return [];
  const result = [];
  const visit = (node, pos = '', order = '') => {
    for (const child of children(node)) {
      const currentPos = attr(child, 'pos', 'position') || pos;
      const currentOrder = attr(child, 'order') || order;
      const names = [
        ['shape', attr(child, 'shape')],
        ['X', attr(child, 'shape_X')],
        ['Y', attr(child, 'shape_Y')],
        ['H', attr(child, 'shape_H')],
        ['T', attr(child, 'shape_T')],
        ['始端', attr(child, 'start_shape')],
        ['終端', attr(child, 'end_shape')],
      ].filter(([, name]) => name);
      if (names.length) {
        const shapes = names.map(([axis, name]) => ({
          axis, name, profile: profiles.get(name) || null,
          direction: attr(child, 'direction_type'),
          strength: axis === 'X' ? attr(child, 'strength_main_X') : axis === 'Y' ? attr(child, 'strength_main_Y') : axis === 'H' ? attr(child, 'strength_main_H') : axis === 'T' ? attr(child, 'strength_main_T') : attr(child, 'strength_main', 'strength'),
        }));
        result.push({
          pos: currentPos || (currentOrder ? '#' + currentOrder : '全断面'),
          order: currentOrder, shapes,
          shape: shapes.map((item) => (item.axis === 'shape' ? '' : item.axis + ':') + item.name).join(' / '),
          profile: shapes[0].profile,
          strengthMain: shapes.map((x) => x.strength).filter(Boolean).join('/'),
          strengthWeb: attr(child, 'strength_web'),
          // 3Dメッシュと同じ方向・オフセットを保持し、断面図の配置計算へ引き継ぐ。
          steelPlacement: {
            direction: attr(child, 'direction_type'),
            offsetHX: attr(child, 'offset_HX'),
            offsetHY: attr(child, 'offset_HY'),
            offsetT: attr(child, 'offset_T'),
          },
        });
      } else visit(child, currentPos, currentOrder);
    }
  };
  visit(root);
  return result.filter((v, i) => result.findIndex((x) => x.pos === v.pos && x.order === v.order && x.shape === v.shape) === i);
}

function barFacts(section, def) {
  const root = first(section, def.bar);
  if (!root) return [];
  const leaves = walk(root).filter((el) => {
    const tag = el.localName || el.tagName;
    return (/Simple$|_Same$|_NotSame$|_RectSame$|_RectNotSame$|_CircleSame$|_CircleNotSame$/.test(tag) || /StbSecBarBeam_SRC_(Same|ThreeTypes|StartEnd)$/.test(tag))
      && (el.hasAttribute('D_main') || el.hasAttribute('D_stirrup') || el.hasAttribute('D_hoop') || el.hasAttribute('D_band'));
  });
  return leaves.map((el) => {
    let parent = el, order = '', pos = '';
    while (parent && parent !== section) {
      order ||= attr(parent, 'order');
      pos ||= attr(parent, 'pos', 'position');
      parent = parent.parentElement;
    }
    const main = attr(el, 'D_main');
    const topBars = walk(el).filter((node) => /StbSecBarBeamSimpleMain$/.test(node.localName || node.tagName));
    const mainDescription = topBars.length
      ? topBars.map((b) => [attr(b, 'pos'), attr(b, 'step') ? '段' + attr(b, 'step') : '', attr(b, 'N') + '-' + attr(b, 'D'), attr(b, 'strength')].filter(Boolean).join(' ')).join(' / ')
      : [main, attr(el, 'N_main_total', 'N_main_X_1st', 'N_X') ? 'X:' + attr(el, 'N_main_X_1st', 'N_X') : '', attr(el, 'N_main_Y_1st', 'N_Y') ? 'Y:' + attr(el, 'N_main_Y_1st', 'N_Y') : '', attr(el, 'N_main_top_1st') ? '上:' + attr(el, 'N_main_top_1st') : '', attr(el, 'N_main_bottom_1st') ? '下:' + attr(el, 'N_main_bottom_1st') : '', attr(el, 'strength_main')].filter(Boolean).join(' ');
    const tie = attr(el, 'D_hoop', 'D_band', 'D_stirrup');
    const tiePitch = attr(el, 'pitch_hoop', 'pitch_band', 'pitch_stirrup');
    const tieStrength = attr(el, 'strength_hoop', 'strength_band', 'strength_stirrup');
    return { order, pos, main: mainDescription, tie: [tie, tiePitch ? '@' + tiePitch : '', tieStrength].filter(Boolean).join(' '), cover: positive(el, 'depth_cover_start_X', 'depth_cover_top', 'depth_cover'), raw: el };
  });
}

function sectionVariants(section, def, profiles) {
  const figures = concreteFigures(section, def);
  const steels = steelVariants(section, def, profiles);
  const bars = barFacts(section, def);
  // Even if steel geometry is absent, concrete and reinforcement facts remain visible.
  const variants = steels.length ? steels : [{ pos: '全断面', order: '', shapes: [], shape: '未定義', profile: null, strengthMain: '', strengthWeb: '' }];
  return variants.map((variant) => {
    // 位置別の定義が複数ある場合、根拠のない順序対応付けをしない。
    const concrete = figures.find((fig) => variant.order && fig.order === variant.order)
      || figures.find((fig) => variant.pos && fig.pos === variant.pos)
      || (figures.length === 1 ? figures[0] : null);
    const bar = bars.find((b) => variant.order && b.order === variant.order)
      || bars.find((b) => variant.pos && b.pos === variant.pos)
      || (bars.length === 1 ? bars[0] : null);
    return { ...variant, concrete, rebar: bar ? { main: bar.main, tie: bar.tie, cover: bar.cover } : null, concreteStrength: attr(section, 'strength_concrete') };
  });
}

/** SRC-only used-section grid, keyed by story ID and section symbol. */
export function extractSrcSectionGrid(xmlDoc, type) {
  const def = TYPES[type];
  if (!def) throw new RangeError('未対応のSRC断面リスト: ' + type);
  const stories = extractStories(xmlDoc);
  const profiles = extractSteelProfiles(xmlDoc);
  const sections = new Map(querySelectorAll(xmlDoc, def.section)
    .filter((el) => attr(el, 'id')).map((el) => [attr(el, 'id'), el]));
  const grid = new Map(), usedStories = new Set(), symbols = new Set();
  for (const member of querySelectorAll(xmlDoc, def.member)) {
    if (attr(member, 'kind_structure').toUpperCase() !== 'SRC') continue;
    if (type === 'src-column' && attr(member, 'kind_column').toUpperCase() === 'POST') continue;
    const section = sections.get(attr(member, 'id_section'));
    if (!section) continue;
    const story = floorOf(member, section, stories, type, def);
    if (!story) continue;
    const symbol = attr(section, 'name') || attr(member, 'name') || attr(section, 'id');
    const key = story.id + ':' + symbol;
    if (!grid.has(key)) grid.set(key, { id: attr(section, 'id'), name: symbol, variants: sectionVariants(section, def, profiles), memberIds: [] });
    const cell = grid.get(key);
    if (cell.id !== attr(section, 'id')) throw new Error('同じ階・符号に異なるSRC断面があります: ' + story.name + '/' + symbol);
    cell.memberIds.push(attr(member, 'id'));
    usedStories.add(story.id);
    symbols.add(symbol);
  }
  return { type, stories: [...stories.values()].filter((story) => usedStories.has(story.id)).sort(compareStoriesDescending), symbols: [...symbols].sort(compareSymbols), grid };
}
export const extractSrcColumnSectionGrid = (doc) => extractSrcSectionGrid(doc, 'src-column');
export const extractSrcBeamSectionGrid = (doc) => extractSrcSectionGrid(doc, 'src-beam');
