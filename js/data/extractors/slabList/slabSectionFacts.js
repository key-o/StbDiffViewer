/**
 * Read-only ST-Bridge RC slab-section facts for the slab schedule (#526).
 * This deliberately does not reuse the 3D RebarPath extractor: invalid and
 * unreinforced sections must remain visible to the schedule and its diagnostics.
 */

export const SLAB_PATTERN_POSITIONS = Object.freeze({
  STANDARD: Object.freeze(
    ['SHORT', 'LONG'].flatMap((direction) =>
      ['TOP', 'BOTTOM'].flatMap((face) =>
        ['COLUMN', 'MID_END', 'MID_CENTER'].map((band) => `${direction}_${face}_${band}`),
      ),
    ),
  ),
  '2WAY_202': Object.freeze(['SHORT_TOP', 'SHORT_BOTTOM', 'LONG_TOP', 'LONG_BOTTOM']),
  '2WAY_21X': Object.freeze(
    ['SHORT', 'LONG'].flatMap((direction) =>
      ['TOP', 'BOTTOM'].flatMap((face) =>
        ['END', 'CENTER'].map((band) => `${direction}_${face}_${band}`),
      ),
    ),
  ),
  '1WAY1': Object.freeze(['MAIN_TOP', 'MAIN_BOTTOM', 'TRANSVERSE_TOP', 'TRANSVERSE_BOTTOM']),
  '1WAY2': Object.freeze([
    'MAIN_BASE_TOP',
    'MAIN_BASE_BOTTOM',
    'MAIN_TIP_TOP',
    'MAIN_TIP_BOTTOM',
    'TRANSVERSE_TOP',
    'TRANSVERSE_BOTTOM',
  ]),
});

const BAR_TAGS = new Map([
  ['StbSecBarSlab_RC_Standard', 'STANDARD'],
  ['StbSecBarSlab_RC_ConventionalStandard', 'STANDARD'],
  ['StbSecBarSlab_RC_2Way', '2WAY'],
  ['StbSecBarSlab_RC_Conventional2Way', '2WAY'],
  ['StbSecBarSlab_RC_1Way1', '1WAY1'],
  ['StbSecBarSlab_RC_Conventional1Way1', '1WAY1'],
  ['StbSecBarSlab_RC_1Way2', '1WAY2'],
  ['StbSecBarSlab_RC_Conventional1Way2', '1WAY2'],
]);

const localName = (el) =>
  String(el?.localName || el?.tagName || '')
    .split(':')
    .pop();
const descendants = (root, name) =>
  Array.from(root?.getElementsByTagName?.('*') || []).filter((el) => localName(el) === name);
const childElements = (el) => Array.from(el?.childNodes || []).filter((n) => n.nodeType === 1);
const first = (root, name) => descendants(root, name)[0] || null;
const attr = (el, name) => (el?.hasAttribute?.(name) ? el.getAttribute(name) : null);
const attrs = (el) =>
  Object.fromEntries(Array.from(el?.attributes || []).map((a) => [a.name, a.value]));

function positiveNumber(raw) {
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function nonnegativeNumber(raw) {
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function parseDiameters(raw) {
  if (!raw || !/^(?:[DR]\d+(?:\.\d+)?)+$/i.test(raw)) return [];
  return [...raw.toUpperCase().matchAll(/[DR]\d+(?:\.\d+)?/g)]
    .map(([designation]) => designation)
    .filter((designation) => Number(designation.slice(1)) > 0);
}

function diag(code, detail = {}) {
  return { code, ...detail };
}

function shapeFacts(section, diagnostics) {
  const figures = descendants(section, 'StbSecFigureSlab_RC');
  const conventionalFigures = descendants(section, 'StbSecFigureSlab_RC_Conventional');
  const figuresRoot = conventionalFigures[0] || figures[0];
  const elements = childElements(figuresRoot);
  const names = elements.map(localName);
  if (!elements.length) {
    diagnostics.push(diag('SHAPE_MISSING_OR_UNSUPPORTED'));
    return { type: 'UNKNOWN', rawElements: [] };
  }
  const isOld = !conventionalFigures.length;
  const type = names[0].endsWith('Straight')
    ? 'STRAIGHT'
    : names[0].endsWith('Taper')
      ? 'TAPER'
      : names[0].endsWith('Haunch')
        ? 'HAUNCH'
        : 'UNKNOWN';
  const rawElements = elements.map((el) => ({ tag: localName(el), attributes: attrs(el) }));
  if (type === 'UNKNOWN' || names.some((name) => name !== names[0])) {
    diagnostics.push(diag('SHAPE_MIXED_OR_UNSUPPORTED'));
    return { type: 'UNKNOWN', rawElements };
  }
  let values = {};
  if (type === 'STRAIGHT') {
    values = { depthMm: positiveNumber(attr(elements[0], 'depth')) };
  } else if (isOld) {
    const depthByPos = {};
    const expected = type === 'TAPER' ? ['BASE', 'TIP'] : ['BASE', 'CENTER', 'HAUNCH'];
    for (const el of elements) {
      const pos = attr(el, 'pos') || '';
      if (!expected.includes(pos) || Object.hasOwn(depthByPos, pos)) {
        diagnostics.push(diag('SHAPE_POS_INVALID', { pos }));
      }
      depthByPos[pos] = positiveNumber(attr(el, 'depth'));
    }
    for (const pos of expected) {
      if (depthByPos[pos] == null) diagnostics.push(diag('SHAPE_DEPTH_MISSING', { pos }));
    }
    values = { depthByPosMm: depthByPos };
  } else if (type === 'TAPER') {
    values = {
      baseDepthMm: positiveNumber(attr(elements[0], 'base_depth')),
      tipDepthMm: positiveNumber(attr(elements[0], 'tip_depth')),
      tipOffsetMm: nonnegativeNumber(attr(elements[0], 'tip_offset') ?? '0'),
    };
  } else {
    values = {
      baseDepthMm: positiveNumber(attr(elements[0], 'base_depth')),
      tipDepthMm: positiveNumber(attr(elements[0], 'tip_depth')),
      haunchLengthMm: positiveNumber(attr(elements[0], 'haunch_length')),
      tipOffsetMm: nonnegativeNumber(attr(elements[0], 'tip_offset') ?? '0'),
    };
  }
  if (
    Object.values(values).some((value) => value === null) ||
    (type !== 'STRAIGHT' && !isOld && elements.length !== 1) ||
    (type === 'STRAIGHT' && elements.length !== 1)
  ) {
    diagnostics.push(diag('SHAPE_INVALID'));
  }
  return { type, ...values, rawElements };
}

function patternFacts(section, version, diagnostics, commonCover) {
  const arrangement =
    first(section, 'StbSecBarArrangementSlab_RC_Conventional') ||
    first(section, 'StbSecBarArrangementSlab_RC');
  if (!arrangement) {
    diagnostics.push(diag('BAR_ARRANGEMENT_MISSING'));
    return {
      pattern: null,
      bars: [],
      openingBars: [],
      unsupportedBars: [],
      cover: { topMm: commonCover, bottomMm: commonCover },
    };
  }
  const topRaw = attr(arrangement, 'depth_cover_top');
  const bottomRaw = attr(arrangement, 'depth_cover_bottom');
  for (const [side, raw] of [
    ['top', topRaw],
    ['bottom', bottomRaw],
  ]) {
    if (raw !== null && positiveNumber(raw) === null)
      diagnostics.push(diag('COVER_INVALID', { side, raw }));
  }
  const cover = {
    topMm: topRaw !== null ? positiveNumber(topRaw) : commonCover,
    bottomMm: bottomRaw !== null ? positiveNumber(bottomRaw) : commonCover,
    sourceTop: topRaw !== null ? 'SECTION' : commonCover === null ? null : 'APPLY',
    sourceBottom: bottomRaw !== null ? 'SECTION' : commonCover === null ? null : 'APPLY',
  };
  const children = childElements(arrangement);
  const positions = children.filter((el) => BAR_TAGS.has(localName(el)));
  const patterns = new Set(positions.map((el) => BAR_TAGS.get(localName(el))));
  const pattern = patterns.size === 1 ? [...patterns][0] : patterns.size > 1 ? 'AMBIGUOUS' : null;
  if (pattern === null) diagnostics.push(diag('BAR_PATTERN_MISSING'));
  if (pattern === 'AMBIGUOUS') diagnostics.push(diag('BAR_PATTERN_AMBIGUOUS'));
  const is202 = String(version || '').startsWith('2.0.2');
  const knownVersion = is202 || /^2\.1\.[01]$/.test(String(version || ''));
  if (!knownVersion) diagnostics.push(diag('VERSION_UNSUPPORTED', { version }));
  const legal =
    pattern === '2WAY'
      ? knownVersion
        ? SLAB_PATTERN_POSITIONS[is202 ? '2WAY_202' : '2WAY_21X']
        : []
      : SLAB_PATTERN_POSITIONS[pattern] || [];
  const expectedCount = { STANDARD: 12, '2WAY': 4, '1WAY1': 4, '1WAY2': 6 }[pattern];
  if (expectedCount !== undefined && positions.length !== expectedCount) {
    diagnostics.push(
      diag('BAR_COUNT_UNEXPECTED', { expectedCount, actualCount: positions.length }),
    );
  }
  const seen = new Map();
  const bars = positions.map((el, index) => {
    const pos = attr(el, 'pos') || '';
    const rawD = attr(el, 'D');
    const rawPitch = attr(el, 'pitch');
    const pitchMm = positiveNumber(rawPitch);
    const designations = parseDiameters(rawD);
    const problems = [];
    if (!legal.includes(pos)) problems.push('BAR_POS_UNKNOWN');
    if (!designations.length) problems.push('BAR_D_INVALID');
    if (pitchMm === null) problems.push('BAR_PITCH_INVALID');
    if (seen.has(pos)) {
      problems.push('BAR_POS_DUPLICATE');
      // The first occurrence is also invalidated after the collection is built.
    } else seen.set(pos, index);
    for (const code of problems) diagnostics.push(diag(code, { pos, index }));
    return {
      pos,
      rawPos: attr(el, 'pos'),
      rawD,
      rawPitch,
      pitchMm,
      designations,
      strength: attr(el, 'strength'),
      rawAttributes: attrs(el),
      tag: localName(el),
      problems,
    };
  });
  for (const [pos, count] of [...seen.entries()]) {
    if (bars.filter((bar) => bar.pos === pos).length > 1) {
      const original = bars[count];
      if (!original.problems.includes('BAR_POS_DUPLICATE')) {
        original.problems.push('BAR_POS_DUPLICATE');
        diagnostics.push(diag('BAR_POS_DUPLICATE', { pos, index: count }));
      }
    }
  }
  const openingBars = children
    .filter((el) => localName(el) === 'StbSecBarSlab_RC_Open')
    .map((el) => ({ tag: localName(el), rawAttributes: attrs(el) }));
  const unknownBars = children.filter(
    (el) =>
      localName(el).startsWith('StbSecBarSlab_RC_') &&
      !BAR_TAGS.has(localName(el)) &&
      localName(el) !== 'StbSecBarSlab_RC_Open',
  );
  for (const el of unknownBars)
    diagnostics.push(diag('BAR_TAG_UNSUPPORTED', { tag: localName(el) }));
  const unsupportedBars = unknownBars.map((el) => ({
    tag: localName(el),
    rawAttributes: attrs(el),
  }));
  return {
    pattern,
    bars,
    openingBars,
    unsupportedBars,
    cover,
    rawArrangementAttributes: attrs(arrangement),
  };
}

function storyNodeIds(story) {
  const list = first(story, 'StbNodeIdList');
  return new Set(
    descendants(list, 'StbNodeId')
      .map((el) => attr(el, 'id'))
      .filter(Boolean),
  );
}

/**
 * Extract a complete schedule dataset. No STB nodes are modified.
 * Usage is inferred only if every listed slab node belongs to the same story node set.
 */
export function extractSlabSectionFacts(xmlDoc, { modelSide = 'A', revision = null } = {}) {
  if (!['A', 'B'].includes(modelSide)) throw new TypeError('modelSide must be A or B');
  const version = attr(xmlDoc?.documentElement, 'version');
  const globalApply =
    first(xmlDoc, 'StbApply_RC_Slab') || first(xmlDoc, 'StbSlab_RC_BarPositionApply');
  const commonCoverRaw = attr(globalApply, 'depth_cover');
  const commonCover = positiveNumber(commonCoverRaw);
  const stories = descendants(xmlDoc, 'StbStory').map((el) => ({
    id: attr(el, 'id'),
    name: attr(el, 'name') || '',
    nodeIds: storyNodeIds(el),
  }));
  const sections = descendants(xmlDoc, 'StbSecSlab_RC').map((section) => {
    const sectionId = attr(section, 'id');
    const diagnostics = [];
    const shape = shapeFacts(section, diagnostics);
    const { pattern, bars, openingBars, unsupportedBars, cover, rawArrangementAttributes } =
      patternFacts(section, version, diagnostics, commonCover);
    if (!sectionId) diagnostics.push(diag('SECTION_ID_MISSING'));
    return {
      id: `slab-section:${modelSide}:${sectionId || 'missing'}`,
      modelSide,
      version,
      stb: { sectionId, revision, memberIds: [], storyIds: [] },
      symbol: attr(section, 'name') || '',
      concrete: attr(section, 'strength_concrete'),
      sectionAttributes: attrs(section),
      shape,
      cover,
      barPattern: pattern,
      barPositions: bars,
      openingBars,
      unsupportedBars,
      rawArrangementAttributes: rawArrangementAttributes || null,
      members: [],
      usage: 'UNUSED',
      diagnostics,
    };
  });
  const byId = new Map();
  const duplicateIds = new Set();
  for (const section of sections) {
    const id = section.stb.sectionId;
    if (!id) continue; // Missing IDs must never become linkable section references.
    if (byId.has(id)) {
      duplicateIds.add(id);
      section.diagnostics.push(diag('SECTION_ID_DUPLICATE', { id }));
      byId.get(id).diagnostics.push(diag('SECTION_ID_DUPLICATE', { id }));
    } else byId.set(id, section);
  }
  // Invalid or duplicated STB identifiers must not collapse distinct schedule rows.
  // Valid unique sections retain their stable, scoped identity.
  sections.forEach((section, index) => {
    if (!section.stb.sectionId || duplicateIds.has(section.stb.sectionId)) {
      section.id = `${section.id}:row:${index + 1}`;
    }
  });
  const diagnostics = [];
  for (const slab of descendants(xmlDoc, 'StbSlab')) {
    if (attr(slab, 'kind_structure') !== 'RC') continue;
    const sectionId = attr(slab, 'id_section');
    const section = byId.get(sectionId);
    const memberId = attr(slab, 'id');
    if (duplicateIds.has(sectionId)) {
      diagnostics.push(diag('MEMBER_SECTION_AMBIGUOUS', { memberId, sectionId }));
      continue;
    }
    if (!section) {
      diagnostics.push(diag('MEMBER_SECTION_UNRESOLVED', { memberId, sectionId }));
      continue;
    }
    const order = first(slab, 'StbNodeIdOrder');
    const nodeIds = String(order?.textContent || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const matchedStories = nodeIds.length
      ? stories.filter(({ nodeIds: nodes }) => nodeIds.every((id) => nodes.has(id)))
      : [];
    if (matchedStories.length !== 1) {
      section.diagnostics.push(
        diag('MEMBER_STORY_UNRESOLVED', {
          memberId,
          matchedStoryIds: matchedStories.map((story) => story.id),
        }),
      );
    }
    const reference = {
      id: memberId,
      name: attr(slab, 'name') || '',
      nodeIds,
      sectionId,
      storyIds: matchedStories.length === 1 ? [matchedStories[0].id] : [],
      kindSlab: attr(slab, 'kind_slab'),
      strengthConcrete: attr(slab, 'strength_concrete'),
      directionLoad: attr(slab, 'direction_load'),
      angleMainBarDirection: attr(slab, 'angle_main_bar_direction'),
    };
    section.members.push(reference);
    section.stb.memberIds = [...new Set([...section.stb.memberIds, memberId])];
    section.stb.storyIds = [...new Set([...section.stb.storyIds, ...reference.storyIds])];
    section.usage = 'USED';
  }
  return { version, modelSide, revision, sections, diagnostics };
}
