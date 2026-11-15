/**
 * S柱/S梁断面リスト用の階×符号モデル。STB 2.0.2 / 2.1.0 の鋼材図形を扱う。
 * RC断面の抽出経路には合流させず、S部材の使用実績だけを採用する。
 */
import {
  querySelectorAll,
  extractStories,
  compareStoriesDescending,
  compareSymbols,
} from './sectionListUtils.js';

const DEFS = Object.freeze({
  'steel-column': {
    member: 'StbColumn',
    section: 'StbSecColumn_S',
    nodeA: 'id_node_bottom',
    nodeB: 'id_node_top',
  },
  'steel-beam': {
    member: 'StbGirder',
    section: 'StbSecBeam_S',
    nodeA: 'id_node_start',
    nodeB: 'id_node_end',
  },
});

const numberAttr = (el, name) => {
  const n = Number(el.getAttribute(name));
  return el.hasAttribute(name) && Number.isFinite(n) && n > 0 ? n : null;
};
const descendants = (el) =>
  Array.from(el?.children || []).flatMap((child) => [child, ...descendants(child)]);

/** Shape names are references to StbSecSteel, never dimensions invented from the member. */
export function extractSteelProfiles(xmlDoc) {
  const result = new Map();
  for (const root of querySelectorAll(xmlDoc, 'StbSecSteel')) {
    for (const el of descendants(root)) {
      const name = el.getAttribute('name');
      if (!name || !el.localName?.startsWith('StbSec')) continue;
      const tag = el.localName.toUpperCase();
      const family = tag.includes('PIPE')
        ? 'PIPE'
        : tag.includes('BOX')
          ? 'BOX'
          : /(?:^|-)H$/.test(tag)
            ? 'H'
            : null;
      result.set(name, {
        name,
        family,
        tag: el.localName,
        A: numberAttr(el, 'A'),
        B: numberAttr(el, 'B'),
        D: numberAttr(el, 'D'),
        t: numberAttr(el, 't'),
        t1: numberAttr(el, 't1'),
        t2: numberAttr(el, 't2'),
      });
    }
  }
  return result;
}

function sectionVariants(section, profiles) {
  const found = [];
  const visit = (el, parentPos = '', parentOrder = '') => {
    const pos = el.getAttribute('pos') || el.getAttribute('position') || parentPos;
    const order = el.getAttribute('order') || parentOrder;
    const shape = el.getAttribute('shape');
    const taperStart = el.getAttribute('start_shape');
    const taperEnd = el.getAttribute('end_shape');
    const basePos = pos || (order ? `#${order}` : '全断面');
    const addShape = (name, label) => {
      if (!name) return;
      found.push({
        pos: label ? `${basePos} ${label}` : basePos,
        shape: name,
        profile: profiles.get(name) || null,
        strengthMain: el.getAttribute('strength_main') || '',
        strengthWeb: el.getAttribute('strength_web') || '',
      });
    };
    if (shape) {
      addShape(shape, '');
    } else if (taperStart || taperEnd) {
      // STBのテーパー梁は単一shapeを持たず、始端・終端の鋼材形状をそれぞれ参照する。
      addShape(taperStart, '始端');
      addShape(taperEnd, '終端');
    } else {
      Array.from(el.children || []).forEach((child) => visit(child, pos, order));
    }
  };
  Array.from(section.children || []).forEach((child) => visit(child));
  return found.filter(
    (v, i) => found.findIndex((item) => item.pos === v.pos && item.shape === v.shape) === i,
  );
}

function usedStory(member, stories, type) {
  const ids = (nodeId) => [...stories.values()].filter((s) => s.nodeIds.has(nodeId));
  const a = ids(member.nodeA);
  const b = ids(member.nodeB);
  const byLevel = (x, y) => (x.level ?? 0) - (y.level ?? 0);
  if (type === 'steel-column') return [...(a.length ? a : b)].sort(byLevel)[0] || null;
  // A girder is assigned to the common node story. If absent, select the start-node story.
  const common = a.filter((story) => b.some((other) => other.id === story.id));
  return [...(common.length ? common : a.length ? a : b)].sort(byLevel)[0] || null;
}

/**
 * @returns {{stories:Array, symbols:Array, grid:Map, type:string}}
 * grid is keyed by `${story.id}:${section.name}` and stores one S section cell.
 */
export function extractSteelSectionGrid(xmlDoc, type) {
  const def = DEFS[type];
  if (!def) throw new RangeError(`Unsupported steel section list: ${type}`);
  const stories = extractStories(xmlDoc);
  const profiles = extractSteelProfiles(xmlDoc);
  const sections = new Map(
    querySelectorAll(xmlDoc, def.section)
      .filter((s) => s.getAttribute('id'))
      .map((s) => [s.getAttribute('id'), s]),
  );
  const grid = new Map();
  const storyIds = new Set();
  const symbols = new Set();
  for (const el of querySelectorAll(xmlDoc, def.member)) {
    if ((el.getAttribute('kind_structure') || '').toUpperCase() !== 'S') continue;
    if (type === 'steel-column' && el.getAttribute('kind_column') === 'POST') continue;
    const sec = sections.get(el.getAttribute('id_section'));
    if (!sec) continue;
    const story = usedStory(
      { nodeA: el.getAttribute(def.nodeA), nodeB: el.getAttribute(def.nodeB) },
      stories,
      type,
    );
    if (!story) continue;
    const symbol = sec.getAttribute('name') || el.getAttribute('name') || sec.getAttribute('id');
    const key = `${story.id}:${symbol}`;
    const variant = sectionVariants(sec, profiles);
    if (!grid.has(key))
      grid.set(key, {
        id: sec.getAttribute('id'),
        name: symbol,
        variants: variant,
        memberIds: [],
      });
    const cell = grid.get(key);
    // Same name but different section IDs must not silently overwrite a drawing.
    if (cell.id !== sec.getAttribute('id')) {
      throw new Error(`同じ階・符号に複数の異なるS断面があります: ${story.name}/${symbol}`);
    }
    cell.memberIds.push(el.getAttribute('id'));
    storyIds.add(story.id);
    symbols.add(symbol);
  }
  return {
    type,
    stories: [...stories.values()].filter((s) => storyIds.has(s.id)).sort(compareStoriesDescending),
    symbols: [...symbols].sort(compareSymbols),
    grid,
  };
}

export const extractSteelColumnSectionGrid = (xmlDoc) =>
  extractSteelSectionGrid(xmlDoc, 'steel-column');
export const extractSteelBeamSectionGrid = (xmlDoc) =>
  extractSteelSectionGrid(xmlDoc, 'steel-beam');