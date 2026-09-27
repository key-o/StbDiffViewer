/**
 * @fileoverview RC壁の断面・配筋・壁面配置・開口補強筋をST-Bridgeから正規化する。
 *
 * ST-Bridge 2.0.2 / 2.1 の差分をここで吸収し、geometry層には
 * 「壁面・配筋パターン・かぶり・径・ピッチ・開口配置」の意味だけを渡す。
 *
 * @module data/extractors/rebar3d/wallRebarSectionFacts
 */

const PATTERN_TAGS = Object.freeze({
  SINGLE: 'StbSecBarWall_RC_Single',
  ZIGZAG: 'StbSecBarWall_RC_Zigzag',
  DOUBLE_NET: 'StbSecBarWall_RC_DoubleNet',
  INSIDE_OUTSIDE: 'StbSecBarWall_RC_InsideAndOutside',
});

function numberAttr(element, name) {
  if (!element?.hasAttribute?.(name)) return null;
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : null;
}

function directChildren(element, tagName = null) {
  const children = Array.from(element?.childNodes || []).filter((node) => node?.nodeType === 1);
  if (!tagName) return children;
  return children.filter((node) => node.tagName === tagName || node.localName === tagName);
}

function firstDescendant(element, tagNames) {
  for (const tagName of tagNames) {
    const found = element?.getElementsByTagName?.(tagName)?.[0];
    if (found) return found;
  }
  return null;
}

function parseBarDiameters(raw) {
  const text = String(raw || '').toUpperCase();
  const values = [];
  const labels = [];
  for (const match of text.matchAll(/[DR](\d+(?:\.\d+)?)/g)) {
    const value = Number(match[1]);
    if (!(value > 0) || !Number.isFinite(value)) continue;
    values.push(value);
    labels.push(`${match[0][0]}${match[1]}`);
  }
  return { values, labels };
}

function parseBarElement(element, override = {}) {
  const pitchMm = numberAttr(element, 'pitch');
  const diameters = parseBarDiameters(element?.getAttribute?.('D'));
  if (!(pitchMm > 0) || diameters.values.length === 0) return null;
  return {
    pos: override.pos ?? element.getAttribute('pos') ?? '',
    pos2: override.pos2 ?? element.getAttribute('pos2') ?? null,
    pitchMm,
    diametersMm: diameters.values,
    designations: diameters.labels,
    strength: element.getAttribute('strength') || null,
    sourceTag: element.tagName || element.localName || '',
  };
}

function parseOpeningBarElement(element) {
  const count = numberAttr(element, 'N');
  const diameters = parseBarDiameters(element?.getAttribute?.('D'));
  if (!(count >= 1) || !Number.isInteger(count) || diameters.values.length === 0) return null;
  const rawLength = numberAttr(element, 'length');
  return {
    pos: (element.getAttribute('pos') || '').toUpperCase(),
    count,
    lengthMm: rawLength > 0 ? rawLength : null,
    diametersMm: diameters.values,
    designations: diameters.labels,
    strength: element.getAttribute('strength') || null,
    sourceTag: element.tagName || element.localName || '',
  };
}

function parseOpeningBars(parent, tagName) {
  const elements = directChildren(parent, tagName);
  const bars = elements.map(parseOpeningBarElement).filter(Boolean);
  const allowed = new Set(['VERTICAL', 'HORIZONTAL', 'DIAGONAL']);
  const invalid =
    bars.length !== elements.length ||
    bars.some((bar) => !allowed.has(String(bar.pos).toUpperCase()));
  return { bars, invalid, elementCount: elements.length };
}

function parseStraightShape(section) {
  const straight = firstDescendant(section, ['StbSecWall_RC_Straight']);
  if (straight) {
    const thicknessMm = numberAttr(straight, 't');
    return thicknessMm > 0 ? { type: 'STRAIGHT', thicknessMm } : null;
  }

  const taper = firstDescendant(section, ['StbSecWall_RC_Taper']);
  if (taper) {
    const bottomThicknessMm = numberAttr(taper, 't_bottom');
    const topThicknessMm = numberAttr(taper, 't_top');
    return {
      type: 'TAPER',
      bottomThicknessMm,
      topThicknessMm,
      depthHbMm: numberAttr(taper, 'depth_Hb') ?? 0,
      depthHtMm: numberAttr(taper, 'depth_Ht') ?? 0,
      straightFace: taper.getAttribute('type_straight') || 'OUTSIDE',
    };
  }
  return null;
}

function resolveCommonCover(xmlDoc) {
  const current = xmlDoc?.getElementsByTagName?.('StbApply_RC_Wall')?.[0];
  const currentCover = numberAttr(current, 'depth_cover');
  if (currentCover >= 0) return currentCover;

  const legacy = xmlDoc?.getElementsByTagName?.('StbWall_RC_BarPositionApply')?.[0];
  const legacyCover = numberAttr(legacy, 'depth_cover');
  const setDefault = legacy?.getAttribute?.('set_default');
  if (legacyCover >= 0 && setDefault !== 'false') return legacyCover;
  return null;
}

export function getWallRebarCoverOverride(options = {}) {
  const override = Number(options.coverMm);
  return Number.isFinite(override) && override >= 0 ? override : null;
}

function resolveCovers(arrangement, commonCoverMm, options = {}) {
  const override = getWallRebarCoverOverride(options);
  if (override !== null) {
    return { outsideMm: override, insideMm: override, source: 'OVERRIDE' };
  }

  const explicitOutside = numberAttr(arrangement, 'depth_cover_outside');
  const explicitInside = numberAttr(arrangement, 'depth_cover_inside');
  const outsideMm = explicitOutside ?? commonCoverMm;
  // ST-Bridgeでは inside は「内外異なるとき」の指定なので、outsideだけある場合は同値扱い。
  const insideMm = explicitInside ?? explicitOutside ?? commonCoverMm;
  const source =
    explicitOutside != null || explicitInside != null
      ? 'SECTION'
      : commonCoverMm != null
        ? 'COMMON'
        : 'NONE';
  return { outsideMm, insideMm, source };
}

function detectPattern(arrangement) {
  const found = Object.entries(PATTERN_TAGS).filter(
    ([, tagName]) => directChildren(arrangement, tagName).length,
  );
  return found.length === 1 ? found[0][0] : found.length > 1 ? 'AMBIGUOUS' : null;
}

function parseSimpleBars(arrangement, tagName) {
  return directChildren(arrangement, tagName).map(parseBarElement).filter(Boolean);
}

function parseInsideOutsideBars(arrangement) {
  const result = [];
  let specialCode = null;

  for (const element of directChildren(arrangement, PATTERN_TAGS.INSIDE_OUTSIDE)) {
    const pos = element.getAttribute('pos') || '';
    if (!/^(VERTICAL|HORIZONTAL)_(OUTSIDE|INSIDE)$/.test(pos)) {
      specialCode ||= 'WALL_REBAR_INVALID_INSIDE_OUTSIDE_POSITION';
      continue;
    }

    // 2.0.2: D/pitch are direct attributes and pos2=ALL/TOP_START/MIDDLE/BOTTOM_END.
    if (element.hasAttribute('D')) {
      const pos2 = (element.getAttribute('pos2') || 'ALL').toUpperCase();
      if (pos2 !== 'ALL') {
        specialCode ||= 'WALL_REBAR_SEGMENTED_INSIDE_OUTSIDE';
        continue;
      }
      const bar = parseBarElement(element, { pos, pos2: 'ALL' });
      if (bar) result.push(bar);
      else specialCode ||= 'WALL_REBAR_INVALID_BAR_FACTS';
      continue;
    }

    // 2.1: pos2 is layer number and D/pitch are carried by the child element.
    const layer = numberAttr(element, 'pos2');
    if (layer !== 1) {
      specialCode ||= 'WALL_REBAR_MULTI_LAYER_INSIDE_OUTSIDE';
      continue;
    }
    const all = directChildren(element, 'StbSecBarWall_RC_All');
    const segmented = [
      ...directChildren(element, 'StbSecBarWall_RC_TopStart'),
      ...directChildren(element, 'StbSecBarWall_RC_Middle'),
      ...directChildren(element, 'StbSecBarWall_RC_BottomEnd'),
    ];
    if (segmented.length > 0 || all.length !== 1) {
      specialCode ||= 'WALL_REBAR_SEGMENTED_INSIDE_OUTSIDE';
      continue;
    }
    if (
      ['length1', 'length1_ex', 'length2', 'length2_ex'].some((name) => element.hasAttribute(name))
    ) {
      specialCode ||= 'WALL_REBAR_SEGMENTED_INSIDE_OUTSIDE';
      continue;
    }
    const bar = parseBarElement(all[0], { pos, pos2: 1 });
    if (bar) result.push(bar);
    else specialCode ||= 'WALL_REBAR_INVALID_BAR_FACTS';
  }

  return { bars: result, specialCode };
}

function parseSectionMap(xmlDoc, options = {}) {
  const result = new Map();
  const commonCoverMm = resolveCommonCover(xmlDoc);

  for (const section of Array.from(xmlDoc?.getElementsByTagName?.('StbSecWall_RC') || [])) {
    const id = section.getAttribute('id');
    if (!id) continue;
    const shape = parseStraightShape(section);
    const arrangement = firstDescendant(section, ['StbSecBarArrangementWall_RC']);
    if (!shape || !arrangement) continue;

    const pattern = detectPattern(arrangement);
    let bars = [];
    let specialCode = null;
    if (pattern === 'SINGLE') bars = parseSimpleBars(arrangement, PATTERN_TAGS.SINGLE);
    else if (pattern === 'ZIGZAG') bars = parseSimpleBars(arrangement, PATTERN_TAGS.ZIGZAG);
    else if (pattern === 'DOUBLE_NET') bars = parseSimpleBars(arrangement, PATTERN_TAGS.DOUBLE_NET);
    else if (pattern === 'INSIDE_OUTSIDE') {
      const parsed = parseInsideOutsideBars(arrangement);
      bars = parsed.bars;
      specialCode = parsed.specialCode;
    } else if (pattern === 'AMBIGUOUS') {
      specialCode = 'WALL_REBAR_AMBIGUOUS_PATTERN';
    } else {
      specialCode = 'WALL_REBAR_UNSUPPORTED_PATTERN';
    }

    const requiredDirections =
      pattern === 'INSIDE_OUTSIDE'
        ? ['VERTICAL_OUTSIDE', 'VERTICAL_INSIDE', 'HORIZONTAL_OUTSIDE', 'HORIZONTAL_INSIDE']
        : ['VERTICAL', 'HORIZONTAL'];
    if (!specialCode && requiredDirections.some((pos) => !bars.some((bar) => bar.pos === pos))) {
      specialCode = 'WALL_REBAR_INCOMPLETE_PATTERN';
    }

    const hasEdgeBars = directChildren(arrangement, 'StbSecBarWall_RC_Edge').length > 0;
    const openBars = parseOpeningBars(arrangement, 'StbSecBarWall_RC_Open');
    const covers = resolveCovers(arrangement, commonCoverMm, options);

    result.set(String(id), {
      id: String(id),
      name: section.getAttribute('name') || '',
      shape,
      pattern,
      bars,
      covers,
      outerBarDirection: arrangement.getAttribute('outer_bar_direction') || 'VERTICAL',
      hasEdgeBars,
      hasOpenBars: openBars.elementCount > 0,
      openBars: openBars.bars,
      openBarsInvalid: openBars.invalid,
      specialCode,
    });
  }
  return result;
}

function parseOpenSectionMap(xmlDoc) {
  const result = new Map();
  for (const section of Array.from(xmlDoc?.getElementsByTagName?.('StbSecOpen_RC') || [])) {
    const id = section.getAttribute('id');
    if (!id) continue;
    const arrangement = firstDescendant(section, ['StbSecBarArrangementOpen_RC']);
    const parsed = arrangement
      ? parseOpeningBars(arrangement, 'StbSecBarOpen_RC_Wall')
      : { bars: [], invalid: false, elementCount: 0 };
    result.set(String(id), {
      id: String(id),
      name: section.getAttribute('name') || '',
      widthMm: numberAttr(section, 'length_X'),
      heightMm: numberAttr(section, 'length_Y'),
      hasBarArrangement: Boolean(arrangement),
      bars: parsed.bars,
      barsInvalid: parsed.invalid,
    });
  }
  return result;
}

function readNodeMap(xmlDoc) {
  const nodes = new Map();
  for (const element of Array.from(xmlDoc?.getElementsByTagName?.('StbNode') || [])) {
    const id = element.getAttribute('id');
    const x = numberAttr(element, 'X');
    const y = numberAttr(element, 'Y');
    const z = numberAttr(element, 'Z');
    if (!id || ![x, y, z].every(Number.isFinite)) continue;
    nodes.set(String(id), { id: String(id), x, y, z });
  }
  return nodes;
}

function getNodeIds(wall) {
  const order = directChildren(wall, 'StbNodeIdOrder')[0];
  return String(order?.textContent || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function readOffsetMap(wall) {
  const result = new Map();
  const list = directChildren(wall, 'StbWallOffsetList')[0];
  for (const element of directChildren(list, 'StbWallOffset')) {
    const id = element.getAttribute('id_node');
    if (!id) continue;
    result.set(String(id), {
      x: numberAttr(element, 'offset_X') ?? 0,
      y: numberAttr(element, 'offset_Y') ?? 0,
      z: numberAttr(element, 'offset_Z') ?? 0,
    });
  }
  return result;
}

function legacyOpenIds(wall) {
  const list = directChildren(wall, 'StbOpenIdList')[0];
  return directChildren(list, 'StbOpenId')
    .map((element) => element.getAttribute('id'))
    .filter(Boolean)
    .map(String);
}

function readModernOpenings(xmlDoc, openSections) {
  const byWall = new Map();
  for (const element of Array.from(xmlDoc?.getElementsByTagName?.('StbOpenArrangement') || [])) {
    if ((element.getAttribute('kind_member') || '').toUpperCase() !== 'WALL') continue;
    const memberId = element.getAttribute('id_member');
    if (!memberId) continue;
    const sectionId = element.getAttribute('id_section') || '';
    const openSection = openSections.get(String(sectionId));
    const opening = {
      id: String(element.getAttribute('id') || ''),
      name: element.getAttribute('name') || '',
      sectionId: String(sectionId),
      sourceVersion: '2.1',
      positionXMm: numberAttr(element, 'position_X'),
      positionYMm: numberAttr(element, 'position_Y'),
      widthMm: openSection?.widthMm ?? null,
      heightMm: openSection?.heightMm ?? null,
      rotateDeg: numberAttr(element, 'rotate') ?? 0,
      openSection,
    };
    if (!byWall.has(String(memberId))) byWall.set(String(memberId), []);
    byWall.get(String(memberId)).push(opening);
  }
  return byWall;
}

function readLegacyOpenings(xmlDoc, openSections) {
  const result = new Map();
  for (const element of Array.from(xmlDoc?.getElementsByTagName?.('StbOpen') || [])) {
    const id = element.getAttribute('id');
    if (!id) continue;
    const sectionId = element.getAttribute('id_section') || '';
    const openSection = openSections.get(String(sectionId));
    result.set(String(id), {
      id: String(id),
      name: element.getAttribute('name') || '',
      sectionId: String(sectionId),
      sourceVersion: '2.0.2',
      positionXMm: numberAttr(element, 'position_X') ?? numberAttr(element, 'offset_X'),
      positionYMm: numberAttr(element, 'position_Y') ?? numberAttr(element, 'offset_Y'),
      widthMm: numberAttr(element, 'length_X') ?? openSection?.widthMm ?? null,
      heightMm: numberAttr(element, 'length_Y') ?? openSection?.heightMm ?? null,
      rotateDeg: numberAttr(element, 'rotate') ?? 0,
      openSection,
    });
  }
  return result;
}

function openingSpecialCode(opening, wallSection) {
  if (
    !Number.isFinite(opening.positionXMm) ||
    !Number.isFinite(opening.positionYMm) ||
    !(opening.widthMm > 0) ||
    !(opening.heightMm > 0) ||
    !Number.isFinite(opening.rotateDeg)
  ) {
    return 'WALL_REBAR_OPENING_GEOMETRY_UNRESOLVED';
  }
  if (opening.openSection?.hasBarArrangement && opening.openSection.barsInvalid) {
    return 'WALL_REBAR_OPENING_BAR_INVALID';
  }
  if (!opening.openSection?.hasBarArrangement && wallSection?.openBarsInvalid) {
    return 'WALL_REBAR_OPENING_BAR_INVALID';
  }
  return null;
}

function finalizeOpening(opening, wallSection) {
  const useOpenSectionBars = Boolean(opening.openSection?.hasBarArrangement);
  const bars = useOpenSectionBars ? opening.openSection.bars : wallSection?.openBars || [];
  return {
    ...opening,
    bars,
    barSource: useOpenSectionBars ? 'OPEN_SECTION' : 'WALL_SECTION',
    specialCode: openingSpecialCode(opening, wallSection),
  };
}

function hasAnyNumericAttribute(element, names) {
  return names.some((name) => element.hasAttribute(name));
}

/**
 * RC壁3D配筋生成に必要なST-Bridge factsを返す。
 */
export function collectWallRebarFacts(xmlDoc, options = {}) {
  const nodes = readNodeMap(xmlDoc);
  const sections = parseSectionMap(xmlDoc, options);
  const openSections = parseOpenSectionMap(xmlDoc);
  const modernOpenings = readModernOpenings(xmlDoc, openSections);
  const legacyOpenings = readLegacyOpenings(xmlDoc, openSections);
  const walls = [];

  for (const wall of Array.from(xmlDoc?.getElementsByTagName?.('StbWall') || [])) {
    const id = wall.getAttribute('id');
    if (!id || (wall.getAttribute('kind_structure') || '').toUpperCase() !== 'RC') continue;
    const sectionId = wall.getAttribute('id_section') || '';
    const section = sections.get(String(sectionId));
    const modern = modernOpenings.get(String(id)) || [];
    const legacy = legacyOpenIds(wall)
      .map((openId) => legacyOpenings.get(String(openId)))
      .filter(Boolean);
    const sourceOpenings = modern.length > 0 ? modern : legacy;
    const openings = sourceOpenings.map((opening) => finalizeOpening(opening, section));

    walls.push({
      id: String(id),
      name: wall.getAttribute('name') || '',
      sectionId,
      nodeIds: getNodeIds(wall),
      offsets: readOffsetMap(wall),
      typeOutside: wall.getAttribute('type_outside') || null,
      kindWall: wall.getAttribute('kind_wall') || 'WALL_NORMAL',
      kindLayout: wall.getAttribute('kind_layout') || '',
      openings,
      hasOpening: openings.length > 0,
      hasFukashi: hasAnyNumericAttribute(wall, ['thickness_add_right', 'thickness_add_left']),
      hasSlit: hasAnyNumericAttribute(wall, [
        'slit_upper',
        'slit_bottom',
        'slit_right',
        'slit_left',
      ]),
    });
  }

  return { nodes, sections, openSections, walls };
}

export const __testOnly = {
  parseBarDiameters,
  parseOpeningBarElement,
  parseSectionMap,
  parseOpenSectionMap,
  readNodeMap,
};
