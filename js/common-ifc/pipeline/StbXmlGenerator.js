/**
 * @fileoverview Stage 7: STB 2.1.0 XML生成
 *
 * パイプラインで収集したデータからSTB形式のXMLを生成する。
 * DOM非依存の文字列ベース実装。
 *
 * @module StbXmlGenerator
 */

import { serializeSteelSections } from './StbSteelSectionXml.js';
import { serializePileNumericAttr } from './StbPileNumericAttrs.js';
import { orderPileSectionUsages } from './StbPileSectionOrder.js';
import { serializeSurfaceNodeOrder, validateSurfaceNodeReferences } from './StbSurfaceNodeOrder.js';
import { validateSurfaceRequiredAttrs } from './StbSurfaceRequiredAttrs.js';
import { validateBeamRequiredAttrs } from './StbBeamRequiredAttrs.js';
import { validateLineMemberRequiredAttrs } from './StbLineMemberRequiredAttrs.js';
import { validateBeamNodeReferences } from './StbBeamNodeReferences.js';
import { validateOtherMemberNodeReferences } from './StbOtherMemberNodeReferences.js';
import { validateStbNodeRecords } from './StbNodeValidation.js';
import { validateStbStoryRecords } from './StbStoryValidation.js';
import { STB_TAG_NAMES } from '../../constants/elementTypes.js';

/** Reject non-finite, blank and boolean geometry; do not turn unknown IFC values into 0. */
function isMeasuredNumber(value, positive = false) {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim()))
    return false;
  const number = Number(value);
  return Number.isFinite(number) && (!positive || number > 0);
}

/** Preserve opening IDs and measured geometry without fabricating missing data. */
function collectWallOpenings(elements) {
  const ids = new Set();
  return elements
    .filter((el) => el.stbType === STB_TAG_NAMES.WALL)
    .flatMap((el) =>
      (el.openings || []).map((op) => {
        const wallId = String(el.id);
        const openingId = String(op.id);
        if (!/^[1-9]\d*$/.test(openingId) || ids.has(openingId))
          throw new Error(`Invalid or duplicated wall opening id: ${openingId}`);
        ids.add(openingId);
        if (op.wallId != null && String(op.wallId) !== wallId)
          throw new Error(`Opening ${openingId} belongs to an unexpected wall`);
        if (!isMeasuredNumber(op.width, true) || !isMeasuredNumber(op.height, true))
          throw new Error(`Opening ${openingId} is missing measured dimensions`);
        if (![op.positionX, op.positionY, op.rotate ?? 0].every((value) => isMeasuredNumber(value)))
          throw new Error(`Opening ${openingId} has invalid placement`);
        const rotate = Number(op.rotate ?? 0);
        if (rotate < 0 || rotate >= 360)
          throw new Error(`Opening ${openingId} has angle outside STB 2.1 range`);
        return { ...op, wallId };
      }),
    );
}

/**
 * STB XMLを生成
 * @param {Object} data - 変換済みデータ
 * @param {Array} data.nodes - 節点リスト [{id, x, y, z}]
 * @param {Array} data.stories - 階リスト [{id, name, height, kind}]
 * @param {Array} data.elements - 要素リスト [{stbType, id, ...}]
 * @param {Array} data.sections - 断面リスト [{id, stbType, name, params}]
 * @param {Object} [data.meta] - メタ情報
 * @returns {string} STB XML文字列
 */
export function generateStbXml(data) {
  validateStbNodeRecords(data.nodes);
  validateStbStoryRecords(data.stories);
  validateSurfaceNodeReferences(data.nodes, data.elements);
  validateBeamNodeReferences(data.nodes, data.elements);
  validateOtherMemberNodeReferences(data.nodes, data.elements);
  const lines = [];
  const indent = (level) => '  '.repeat(level);

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<ST_BRIDGE version="2.1.0" xmlns="https://www.building-smart.or.jp/dl">');

  const openings = collectWallOpenings(data.elements);

  // StbCommon
  const projectName = data.meta?.projectName || 'IFC-Converted';
  lines.push(
    `${indent(1)}<StbCommon project_name="${escXml(projectName)}" app_name="IFC-STB-Converter" app_version="1.0.0"/>`,
  );

  // StbModel
  lines.push(`${indent(1)}<StbModel>`);

  // XSD: StbNodes/StbStories are optional, but if present their respective
  // StbNode/StbStory child lists must contain at least one element.
  // Omit only empty wrappers; never synthesize a node or a story.
  if (data.nodes.length > 0) {
    lines.push(`${indent(2)}<StbNodes>`);
    for (const n of data.nodes) {
      lines.push(
        `${indent(3)}<StbNode id="${n.id}" X="${fmtNumber(n.x)}" Y="${fmtNumber(n.y)}" Z="${fmtNumber(n.z)}" kind="${n.kind || 'OTHER'}"/>`,
      );
    }
    lines.push(`${indent(2)}</StbNodes>`);
  }

  if (data.stories.length > 0) {
    lines.push(`${indent(2)}<StbStories>`);
    for (const s of data.stories) {
      lines.push(
        `${indent(3)}<StbStory id="${s.id}" name="${escXml(s.name)}" height="${fmtNumber(s.height)}" kind="${s.kind}"/>`,
      );
    }
    lines.push(`${indent(2)}</StbStories>`);
  }

  // -- StbMembers
  lines.push(`${indent(2)}<StbMembers>`);
  generateMembers(lines, data.elements, openings, 3);
  lines.push(`${indent(2)}</StbMembers>`);

  // STB 2.1.0 requires StbSections inside StbModel, after StbMembers.
  lines.push(`${indent(2)}<StbSections>`);
  generateSections(lines, data.sections, data.elements, openings, 3);
  lines.push(`${indent(2)}</StbSections>`);

  lines.push(`${indent(1)}</StbModel>`);

  lines.push('</ST_BRIDGE>');

  return lines.join('\n');
}

/**
 * StbMembers の各カテゴリを生成
 */
function generateMembers(lines, elements, openings, level) {
  const indent = (l) => '  '.repeat(l);

  const groups = {
    [STB_TAG_NAMES.COLUMN]: [],
    [STB_TAG_NAMES.POST]: [],
    [STB_TAG_NAMES.FOUNDATION_COLUMN]: [],
    [STB_TAG_NAMES.GIRDER]: [],
    [STB_TAG_NAMES.BEAM]: [],
    [STB_TAG_NAMES.BRACE]: [],
    [STB_TAG_NAMES.SLAB]: [],
    [STB_TAG_NAMES.WALL]: [],
    [STB_TAG_NAMES.PILE]: [],
    [STB_TAG_NAMES.FOOTING]: [],
  };

  for (const el of elements) {
    if (groups[el.stbType]) {
      groups[el.stbType].push(el);
    }
  }

  // ST-Bridge 2.1.0 requires separate StbColumns and StbPosts groups.
  if (groups[STB_TAG_NAMES.COLUMN].length > 0) {
    lines.push(`${indent(level)}<StbColumns>`);
    for (const el of groups[STB_TAG_NAMES.COLUMN]) {
      lines.push(`${indent(level + 1)}<StbColumn${memberAttrs(el, 'column')}/>`);
    }
    lines.push(`${indent(level)}</StbColumns>`);
  }
  if (groups[STB_TAG_NAMES.POST].length > 0) {
    lines.push(`${indent(level)}<StbPosts>`);
    for (const el of groups[STB_TAG_NAMES.POST]) {
      lines.push(`${indent(level + 1)}<StbPost${memberAttrs(el, 'column')}/>`);
    }
    lines.push(`${indent(level)}</StbPosts>`);
  }

  // Girders
  if (groups[STB_TAG_NAMES.GIRDER].length > 0) {
    lines.push(`${indent(level)}<StbGirders>`);
    for (const el of groups[STB_TAG_NAMES.GIRDER]) {
      lines.push(`${indent(level + 1)}<StbGirder${memberAttrs(el, 'beam')}/>`);
    }
    lines.push(`${indent(level)}</StbGirders>`);
  }

  // Beams
  if (groups[STB_TAG_NAMES.BEAM].length > 0) {
    lines.push(`${indent(level)}<StbBeams>`);
    for (const el of groups[STB_TAG_NAMES.BEAM]) {
      lines.push(`${indent(level + 1)}<StbBeam${memberAttrs(el, 'beam')}/>`);
    }
    lines.push(`${indent(level)}</StbBeams>`);
  }

  // Braces
  if (groups[STB_TAG_NAMES.BRACE].length > 0) {
    lines.push(`${indent(level)}<StbBraces>`);
    for (const el of groups[STB_TAG_NAMES.BRACE]) {
      lines.push(`${indent(level + 1)}<StbBrace${memberAttrs(el, 'brace')}/>`);
    }
    lines.push(`${indent(level)}</StbBraces>`);
  }

  // Slabs
  if (groups[STB_TAG_NAMES.SLAB].length > 0) {
    lines.push(`${indent(level)}<StbSlabs>`);
    for (const el of groups[STB_TAG_NAMES.SLAB]) {
      lines.push(`${indent(level + 1)}<StbSlab${slabAttrs(el)}>`);
      lines.push(
        `${indent(level + 2)}<StbNodeIdOrder>${serializeSurfaceNodeOrder(el)}</StbNodeIdOrder>`,
      );
      lines.push(`${indent(level + 1)}</StbSlab>`);
    }
    lines.push(`${indent(level)}</StbSlabs>`);
  }

  // Walls
  if (groups[STB_TAG_NAMES.WALL].length > 0) {
    lines.push(`${indent(level)}<StbWalls>`);
    for (const el of groups[STB_TAG_NAMES.WALL]) {
      lines.push(`${indent(level + 1)}<StbWall${wallAttrs(el)}>`);
      lines.push(
        `${indent(level + 2)}<StbNodeIdOrder>${serializeSurfaceNodeOrder(el)}</StbNodeIdOrder>`,
      );
      lines.push(`${indent(level + 1)}</StbWall>`);
    }
    lines.push(`${indent(level)}</StbWalls>`);
  }

  // Footings
  if (groups[STB_TAG_NAMES.FOOTING].length > 0) {
    lines.push(`${indent(level)}<StbFootings>`);
    for (const el of groups[STB_TAG_NAMES.FOOTING]) {
      lines.push(`${indent(level + 1)}<StbFooting${footingAttrs(el)}/>`);
    }
    lines.push(`${indent(level)}</StbFootings>`);
  }

  // Piles follow footings in the ST-Bridge 2.1.0 content model.
  if (groups[STB_TAG_NAMES.PILE].length > 0) {
    lines.push(`${indent(level)}<StbPiles>`);
    for (const el of groups[STB_TAG_NAMES.PILE]) {
      lines.push(`${indent(level + 1)}<StbPile${pileAttrs(el)}/>`);
    }
    lines.push(`${indent(level)}</StbPiles>`);
  }

  // Foundation columns are a separate group after piles.
  if (groups[STB_TAG_NAMES.FOUNDATION_COLUMN].length > 0) {
    lines.push(`${indent(level)}<StbFoundationColumns>`);
    for (const el of groups[STB_TAG_NAMES.FOUNDATION_COLUMN]) {
      lines.push(`${indent(level + 1)}<StbFoundationColumn${foundationColumnAttrs(el)}/>`);
    }
    lines.push(`${indent(level)}</StbFoundationColumns>`);
  }
  // ST-Bridge 2.1 openings are arrangements under StbMembers, following columns/piles.
  if (openings.length > 0) {
    lines.push(`${indent(level)}<StbOpenArrangements>`);
    for (const op of openings) {
      lines.push(
        `${indent(level + 1)}<StbOpenArrangement id="${op.id}" name="${escXml(op.name || '')}" ` +
          `id_section="${op.id}" kind_member="WALL" id_member="${op.wallId}" ` +
          `position_X="${fmtNumber(op.positionX)}" position_Y="${fmtNumber(op.positionY)}" ` +
          `rotate="${fmtNumber(op.rotate ?? 0)}"/>`,
      );
    }
    lines.push(`${indent(level)}</StbOpenArrangements>`);
  }
}

/**
 * 線材要素の属性文字列を生成
 */
function memberAttrs(el, category) {
  if (el.stbType === STB_TAG_NAMES.GIRDER || el.stbType === STB_TAG_NAMES.BEAM) {
    validateBeamRequiredAttrs(el);
  }
  if (
    el.stbType === STB_TAG_NAMES.COLUMN ||
    el.stbType === STB_TAG_NAMES.POST ||
    el.stbType === STB_TAG_NAMES.BRACE
  ) {
    validateLineMemberRequiredAttrs(el);
  }
  let attrs = ` id="${el.id}" name="${escXml(el.name || '')}"`;

  if (category === 'column') {
    attrs += ` id_node_bottom="${el.nodeStart}" id_node_top="${el.nodeEnd}"`;
  } else {
    attrs += ` id_node_start="${el.nodeStart}" id_node_end="${el.nodeEnd}"`;
  }

  if (el.sectionId) {
    attrs += ` id_section="${el.sectionId}"`;
  }

  attrs += ` kind_structure="${el.kindStructure}"`;
  if (
    (el.stbType === STB_TAG_NAMES.GIRDER || el.stbType === STB_TAG_NAMES.BEAM) &&
    typeof el.isFoundation === 'boolean'
  )
    attrs += ` isFoundation="${el.isFoundation}"`;

  if (el.rotate) {
    attrs += ` rotate="${fmtNumber(((Number(el.rotate) % 360) + 360) % 360)}"`;
  }

  // Emit only STB-origin analytical-node offsets, not inferred IFC values.
  // ST-Bridge 2.1 StbBrace has aim_offset_* (not legacy offset_*).
  // They are not assumed equivalent: report the representational loss.
  if (
    category === 'brace' &&
    el.sourceLinearOffsets &&
    ['start', 'end'].some((side) =>
      ['x', 'y', 'z'].some((axis) => el.sourceLinearOffsets[side]?.[axis] !== 0),
    )
  ) {
    console.warn(
      `[IFC to STB] StbBrace ${el.id}: legacy physical offsets cannot be represented by STB 2.1; omitting rather than inventing aim_offset_*.`,
    );
  }
  const offsets =
    category === 'beam'
      ? el.sourceBeamOffsets
      : category === 'column'
        ? el.sourceLinearOffsets
        : null;
  const allowedSides = category === 'column' ? ['bottom', 'top'] : ['start', 'end'];
  if (offsets) {
    for (const side of allowedSides) {
      const point = offsets[side];
      if (!point) continue;
      for (const axis of ['x', 'y', 'z']) {
        const value = point[axis];
        if (Number.isFinite(value) && value !== 0)
          attrs += ` offset_${side}_${axis.toUpperCase()}="${fmtNumber(value)}"`;
      }
    }
  }

  // ハンチ属性
  if (el.haunch?.sections) {
    const h = el.haunch.sections;
    if (h.haunchStart > 0) {
      attrs += ` haunch_start="${fmtNumber(h.haunchStart)}"`;
      if (h.kindStart) attrs += ` kind_haunch_start="${h.kindStart}"`;
    }
    if (h.haunchEnd > 0) {
      attrs += ` haunch_end="${fmtNumber(h.haunchEnd)}"`;
      if (h.kindEnd) attrs += ` kind_haunch_end="${h.kindEnd}"`;
    }
  }

  return attrs;
}

/**
 * スラブ要素の属性文字列
 */
function slabAttrs(el) {
  validateSurfaceRequiredAttrs(el, 'slab');
  let attrs = ` id="${el.id}" name="${escXml(el.name || '')}"`;
  attrs += ` id_section="${el.sectionId}"`;
  attrs += ` kind_structure="${el.kindStructure}"`;
  attrs += ` kind_slab="${el.kindSlab}"`;
  attrs += ` isFoundation="${el.isFoundation}"`;
  return attrs;
}

/**
 * 壁要素の属性文字列
 */
function wallAttrs(el) {
  validateSurfaceRequiredAttrs(el, 'wall');
  let attrs = ` id="${el.id}" name="${escXml(el.name || '')}"`;
  attrs += ` id_section="${el.sectionId}"`;
  attrs += ` kind_structure="${el.kindStructure}"`;
  attrs += ` kind_layout="${el.kindLayout}"`;
  return attrs;
}

/**
 * 杭要素の属性文字列
 */
function pileAttrs(el) {
  const positiveId = (value) => {
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value)))
      return false;
    const id = String(value).trim();
    return /^\+?\d+$/.test(id) && /[1-9]/.test(id);
  };
  if (el.pileFormat !== '1node' || !el.nodeSingle) {
    throw new Error('STB 2.1 StbPile requires a measured single-node representation');
  }
  if (!positiveId(el.id) || !positiveId(el.nodeSingle) || !positiveId(el.sectionId)) {
    throw new Error('STB 2.1 StbPile requires positive id, id_node and id_section');
  }
  if (!['RC', 'S', 'PC'].includes(el.kindStructure)) {
    throw new Error('STB 2.1 StbPile requires sourced RC/S/PC kind_structure');
  }
  let attrs = ` id="${el.id}" name="${escXml(el.name || '')}"`;
  attrs += ` id_node="${el.nodeSingle}"`;
  attrs += serializePileNumericAttr(el.levelTop, 'level_top');
  attrs += serializePileNumericAttr(el.offsetX, 'offset_X');
  attrs += serializePileNumericAttr(el.offsetY, 'offset_Y');
  if (el.sectionId) attrs += ` id_section="${el.sectionId}"`;
  attrs += serializePileNumericAttr(el.lengthAll, 'length_all', true);
  attrs += serializePileNumericAttr(el.lengthHead, 'length_head', true);
  attrs += serializePileNumericAttr(el.lengthFoot, 'length_foot', true);
  attrs += ` kind_structure="${el.kindStructure}"`;
  // kind_pile / rotate are not StbPile attributes in the ST-Bridge 2.1.0 schema.
  return attrs;
}

/**
 * フーチング要素の属性文字列
 */
function footingAttrs(el) {
  let attrs = ` id="${el.id}" name="${escXml(el.name || '')}"`;
  attrs += ` id_node="${el.nodeStart}"`;
  if (el.sectionId) attrs += ` id_section="${el.sectionId}"`;
  if (el.rotate) attrs += ` rotate="${fmtNumber(((Number(el.rotate) % 360) + 360) % 360)}"`;
  if (el.offsetX !== undefined) attrs += ` offset_X="${fmtNumber(el.offsetX)}"`;
  if (el.offsetY !== undefined) attrs += ` offset_Y="${fmtNumber(el.offsetY)}"`;
  if (el.levelBottom !== undefined) attrs += ` level_bottom="${fmtNumber(el.levelBottom)}"`;
  if (el.kindStructure) attrs += ` kind_structure="${el.kindStructure}"`;
  if (el.kindFooting) attrs += ` kind_footing="${el.kindFooting}"`;
  return attrs;
}

/**
 * 基礎柱要素の属性文字列
 */
function foundationColumnAttrs(el) {
  let attrs = ` id="${el.id}" name="${escXml(el.name || '')}"`;
  attrs += ` id_node="${el.nodeStart}"`;
  if (el.rotate) attrs += ` rotate="${fmtNumber(((Number(el.rotate) % 360) + 360) % 360)}"`;
  if (el.idSectionFD) attrs += ` id_section_FD="${el.idSectionFD}"`;
  if (el.lengthFD) attrs += ` length_FD="${fmtNumber(el.lengthFD)}"`;
  if (el.idSectionWR) attrs += ` id_section_WR="${el.idSectionWR}"`;
  if (el.lengthWR) attrs += ` length_WR="${fmtNumber(el.lengthWR)}"`;
  if (el.offsetFDX !== undefined) attrs += ` offset_FD_X="${fmtNumber(el.offsetFDX)}"`;
  if (el.offsetFDY !== undefined) attrs += ` offset_FD_Y="${fmtNumber(el.offsetFDY)}"`;
  if (el.offsetZ !== undefined && el.offsetZ !== 0) attrs += ` offset_Z="${fmtNumber(el.offsetZ)}"`;
  if (el.kindStructure) attrs += ` kind_structure="${el.kindStructure}"`;
  return attrs;
}

/**
 * StbSections を生成
 */
function generateSections(lines, sections, elements, openings, level) {
  const indent = (l) => '  '.repeat(l);

  // 鋼材断面定義（StbSecSteel）
  const steelSections = sections.filter((s) =>
    ['H', 'BOX', 'PIPE', 'L', 'T', 'C', 'FB', 'CIRCLE'].includes(s.stbType),
  );

  // 要素カテゴリ別の断面参照
  generateMemberSections(lines, elements, sections, level);

  // STB 2.1 stores opening dimensions in separate RC opening section definitions.
  for (const op of openings) {
    lines.push(
      `${indent(level)}<StbSecOpen_RC id="${op.id}" name="${escXml(op.name || '')}" ` +
        `length_X="${fmtNumber(op.width)}" length_Y="${fmtNumber(op.height)}"/>`,
    );
  }

  // StbSecSteel follows member-section declarations in XSD sequence.
  if (steelSections.length > 0) {
    lines.push(`${indent(level)}<StbSecSteel>`);
    for (const sec of serializeSteelSections(steelSections)) {
      lines.push(`${indent(level + 1)}${sec.xml}`);
    }
    lines.push(`${indent(level)}</StbSecSteel>`);
  }
}

/**
 * 要素別の断面参照を生成（StbSecColumn_S, StbSecBeam_S 等）
 */
function generateMemberSections(lines, elements, sections, level) {
  const indent = (l) => '  '.repeat(l);

  // セクションIDで使われている断面をグループ化
  const sectionUsage = new Map();
  for (const el of elements) {
    if (!el.sectionId) continue;
    const key = `${el.stbCategory}_${el.sectionId}`;
    if (!sectionUsage.has(key)) {
      sectionUsage.set(key, { category: el.stbCategory, sectionId: el.sectionId, elements: [] });
    }
    sectionUsage.get(key).elements.push(el);
  }

  // 断面ID → 断面情報
  const sectionById = new Map();
  for (const sec of sections) {
    sectionById.set(sec.id, sec);
  }

  // カテゴリ別にグループ
  const categoryGroups = new Map();
  for (const usage of sectionUsage.values()) {
    if (!categoryGroups.has(usage.category)) {
      categoryGroups.set(usage.category, []);
    }
    categoryGroups.get(usage.category).push(usage);
  }

  // 柱断面
  const isRcColumn = (usage) => {
    const sec = sectionById.get(usage.sectionId);
    return (
      sec &&
      ['RECTANGLE', 'CIRCLE'].includes(sec.stbType) &&
      inferSectionKindStructure(usage.elements, sec) === 'RC'
    );
  };
  const columnUsages = [...(categoryGroups.get('column') || [])].sort(
    (a, b) => Number(isRcColumn(b)) - Number(isRcColumn(a)),
  );
  const columnSecIdsDone = new Set();
  for (const usage of columnUsages) {
    if (columnSecIdsDone.has(usage.sectionId)) continue;
    columnSecIdsDone.add(usage.sectionId);

    const sec = sectionById.get(usage.sectionId);
    if (!sec) continue;
    const kindStructure = inferSectionKindStructure(usage.elements, sec);

    if (kindStructure === 'RC' && ['RECTANGLE', 'CIRCLE'].includes(sec.stbType)) {
      generateRcColumnSection(lines, usage.sectionId, sec, level);
    } else {
      generateSteelColumnSection(lines, usage.sectionId, sec, level);
    }
  }

  // 大梁断面
  // STB 2.1 StbSections is an xs:sequence: RC beams precede steel beams
  // regardless of the order in which IFC elements were encountered.
  const beamUsages = [...(categoryGroups.get('beam') || [])].sort((left, right) => {
    const isRc = (usage) => {
      const section = sectionById.get(usage.sectionId);
      return (
        section?.stbType === 'RECTANGLE' &&
        inferSectionKindStructure(usage.elements, section) === 'RC'
      );
    };
    return Number(isRc(right)) - Number(isRc(left));
  });
  const beamSecIdsDone = new Set();
  for (const usage of beamUsages) {
    if (beamSecIdsDone.has(usage.sectionId)) continue;
    beamSecIdsDone.add(usage.sectionId);

    const sec = sectionById.get(usage.sectionId);
    if (!sec) continue;

    // IFC profile XDim/YDim are measured RC beam geometry, not a steel section.
    const structure = inferSectionKindStructure(usage.elements, sec);
    if (structure === 'RC' && sec.stbType === 'RECTANGLE') {
      const width = Number(sec.params?.width_X);
      const depth = Number(sec.params?.width_Y);
      if (!(width > 0) || !(depth > 0))
        throw new Error(`Invalid measured RC beam dimensions: ${usage.sectionId}`);
      const kindBeam = usage.elements.some((member) => member.stbType === STB_TAG_NAMES.BEAM)
        ? 'BEAM'
        : 'GIRDER';
      lines.push(
        `${indent(level)}<StbSecBeam_RC id="${usage.sectionId}" name="${escXml(sec.name)}" kind_beam="${kindBeam}">`,
      );
      lines.push(`${indent(level + 1)}<StbSecFigureBeam_RC order="1">`);
      lines.push(
        `${indent(level + 2)}<StbSecBeamStraight width="${fmtNumber(width)}" depth="${fmtNumber(depth)}"/>`,
      );
      lines.push(`${indent(level + 1)}</StbSecFigureBeam_RC>`);
      lines.push(`${indent(level)}</StbSecBeam_RC>`);
      continue;
    }

    // ハンチ付き要素があるかチェック
    const haunchEl = usage.elements.find((e) => e.haunch && e.haunch.pattern !== 'SAME');

    lines.push(
      `${indent(level)}<StbSecBeam_S id="${usage.sectionId}" name="Beam-S-${usage.sectionId}" floor="ALL">`,
    );
    lines.push(`${indent(level + 1)}<StbSecSteelFigureBeam_S>`);

    if (haunchEl && haunchEl.haunch.sections) {
      // ハンチ断面出力（StbSecSteelBeam_S_Haunch）
      generateHaunchBeamFigure(lines, sec, haunchEl.haunch, level + 2);
    } else {
      lines.push(`${indent(level + 2)}<StbSecSteelBeam_S_Shape order="1">`);
      lines.push(
        `${indent(level + 3)}<StbSecSteelBeamStraight shape="${escXml(sec.name)}" strength_main="${escXml(sec.params?.strength_main || '')}"/>`,
      );
      lines.push(`${indent(level + 2)}</StbSecSteelBeam_S_Shape>`);
    }

    lines.push(`${indent(level + 1)}</StbSecSteelFigureBeam_S>`);
    lines.push(`${indent(level)}</StbSecBeam_S>`);
  }

  // ブレース断面
  const braceUsages = categoryGroups.get('brace') || [];
  for (const usage of braceUsages) {
    const sec = sectionById.get(usage.sectionId);
    if (!sec) continue;
    lines.push(
      `${indent(level)}<StbSecBrace_S id="${usage.sectionId}" name="Brace-S-${usage.sectionId}" floor="ALL">`,
    );
    lines.push(`${indent(level + 1)}<StbSecSteelFigureBrace_S>`);
    lines.push(
      `${indent(level + 2)}<StbSecSteelBrace_S_Same shape="${escXml(sec.name)}" strength_main="${escXml(sec.params?.strength_main || '')}"/>`,
    );
    lines.push(`${indent(level + 1)}</StbSecSteelFigureBrace_S>`);
    lines.push(`${indent(level)}</StbSecBrace_S>`);
  }

  // Supported RC slab sections contain only measured IFC extrusion depth.
  const slabUsages = categoryGroups.get('slab') || [];
  const slabDone = new Set();
  for (const usage of slabUsages) {
    if (slabDone.has(usage.sectionId)) continue;
    slabDone.add(usage.sectionId);
    const sec = sectionById.get(usage.sectionId);
    if (sec?.stbType !== 'SLAB_RC' || !(Number(sec.params?.depth) > 0)) continue;
    lines.push(
      `${indent(level)}<StbSecSlab_RC id="${usage.sectionId}" name="${escXml(sec.name)}">`,
    );
    lines.push(`${indent(level + 1)}<StbSecSlab_RC_Conventional>`);
    lines.push(`${indent(level + 2)}<StbSecFigureSlab_RC_Conventional>`);
    lines.push(
      `${indent(level + 3)}<StbSecSlab_RC_ConventionalStraight depth="${fmtNumber(sec.params.depth)}"/>`,
    );
    lines.push(`${indent(level + 2)}</StbSecFigureSlab_RC_Conventional>`);
    lines.push(`${indent(level + 1)}</StbSecSlab_RC_Conventional>`);
    lines.push(`${indent(level)}</StbSecSlab_RC>`);
  }

  // Reproduce only the measured IFC wall thickness. Unknown wall layout remains
  // an explicit XSD blocker rather than a fabricated placement classification.
  const wallUsages = categoryGroups.get('wall') || [];
  const wallIdsDone = new Set();
  for (const usage of wallUsages) {
    if (wallIdsDone.has(usage.sectionId)) continue;
    wallIdsDone.add(usage.sectionId);
    const sec = sectionById.get(usage.sectionId);
    if (sec?.stbType !== 'WALL_RC' || !(Number(sec.params?.t) > 0)) continue;
    lines.push(
      `${indent(level)}<StbSecWall_RC id="${usage.sectionId}" name="${escXml(sec.name)}">`,
    );
    lines.push(`${indent(level + 1)}<StbSecFigureWall_RC>`);
    lines.push(`${indent(level + 2)}<StbSecWall_RC_Straight t="${fmtNumber(sec.params.t)}"/>`);
    lines.push(`${indent(level + 1)}</StbSecFigureWall_RC>`);
    lines.push(`${indent(level)}</StbSecWall_RC>`);
  }

  const footingUsages = categoryGroups.get('footing') || [];
  const footingSecIdsDone = new Set();
  for (const usage of footingUsages) {
    if (footingSecIdsDone.has(usage.sectionId)) continue;
    footingSecIdsDone.add(usage.sectionId);

    const sec = sectionById.get(usage.sectionId);
    if (!sec) continue;

    generateRcFootingSection(lines, usage.sectionId, sec, usage.elements[0], level);
  }

  // StbSections xs:sequence: RC piles, then steel piles, then precast piles.
  // Sorting usage references does not alter any measured IFC section geometry.
  const pileUsages = orderPileSectionUsages(
    categoryGroups.get('pile') || [],
    sectionById,
    inferSectionKindStructure,
  );
  const pileSecIdsDone = new Set();
  for (const usage of pileUsages) {
    if (pileSecIdsDone.has(usage.sectionId)) continue;
    pileSecIdsDone.add(usage.sectionId);

    const sec = sectionById.get(usage.sectionId);
    if (!sec) continue;

    const kindStructure = inferSectionKindStructure(usage.elements, sec);
    if (sec.stbType === 'PILE_PRODUCT' || kindStructure === 'PC') {
      generatePileProductSection(lines, usage.sectionId, sec, level);
    } else if (kindStructure === 'RC' && ['PILE_RC', 'CIRCLE'].includes(sec.stbType)) {
      generateRcPileSection(lines, usage.sectionId, sec, level);
    } else if (kindStructure === 'S' && ['PILE_S', 'PIPE'].includes(sec.stbType)) {
      generateSteelPileSection(lines, usage.sectionId, sec, usage.elements[0], level);
    }
  }
}

/*
 * ハンチ付き梁の断面図描写を生成
 * @param {string[]} lines
 * @param {Object} sec - 中央断面情報
 * @param {Object} haunch - ハンチ検出結果
 * @param {number} level - インデントレベル
 */
function inferSectionKindStructure(elements, sec) {
  const explicit = elements.find(
    (el) => el.kindStructure && el.kindStructure !== 'UNDEFINED',
  )?.kindStructure;
  if (explicit) return explicit;

  if (['RECTANGLE', 'CIRCLE', 'PILE_RC'].includes(sec.stbType)) return 'RC';
  if (sec.stbType === 'PILE_PRODUCT') return 'PC';
  return 'S';
}

function generateSteelColumnSection(lines, sectionId, sec, level) {
  const indent = (l) => '  '.repeat(l);
  lines.push(
    `${indent(level)}<StbSecColumn_S id="${sectionId}" name="Column-S-${sectionId}" floor="ALL">`,
  );
  lines.push(`${indent(level + 1)}<StbSecSteelFigureColumn_S>`);
  lines.push(
    `${indent(level + 2)}<StbSecSteelColumn_S_Same shape="${escXml(sec.name)}" strength_main="${escXml(sec.params?.strength_main || '')}"/>`,
  );
  lines.push(`${indent(level + 1)}</StbSecSteelFigureColumn_S>`);
  lines.push(`${indent(level)}</StbSecColumn_S>`);
}

/**
 * IFC-derived section material metadata is optional. Never fabricate Fc21
 * when the IFC source has no verifiable concrete strength.
 */
function concreteStrengthAttr(section) {
  const value = section?.params?.strength_concrete ?? section?.strength_concrete;
  return typeof value === 'string' && value.trim() ? ` strength_concrete="${escXml(value)}"` : '';
}

function generateRcColumnSection(lines, sectionId, sec, level) {
  const indent = (l) => '  '.repeat(l);
  lines.push(
    `${indent(level)}<StbSecColumn_RC id="${sectionId}" name="Column-RC-${sectionId}" floor="ALL" kind_column="COLUMN"${concreteStrengthAttr(sec)}>`,
  );
  lines.push(`${indent(level + 1)}<StbSecFigureColumn_RC>`);

  if (sec.stbType === 'CIRCLE') {
    lines.push(`${indent(level + 2)}<StbSecColumnCircle D="${fmtNumber(sec.params.D)}"/>`);
  } else {
    lines.push(
      `${indent(level + 2)}<StbSecColumnRect width_X="${fmtNumber(sec.params.width_X)}" width_Y="${fmtNumber(sec.params.width_Y)}"/>`,
    );
  }

  lines.push(`${indent(level + 1)}</StbSecFigureColumn_RC>`);
  lines.push(`${indent(level)}</StbSecColumn_RC>`);
}

function generateRcFootingSection(lines, sectionId, sec, element, level) {
  const indent = (l) => '  '.repeat(l);
  const depth = sec.params.depth ?? Math.abs(element?.levelBottom ?? 0);
  const widthX = sec.params.width_X ?? sec.params.width ?? 0;
  const widthY = sec.params.width_Y ?? sec.params.height ?? widthX;

  lines.push(
    `${indent(level)}<StbSecFoundation_RC id="${sectionId}" name="Foundation-RC-${sectionId}"${concreteStrengthAttr(sec)}>`,
  );
  lines.push(`${indent(level + 1)}<StbSecFigureFoundation_RC>`);
  lines.push(
    `${indent(level + 2)}<StbSecFoundation_RC_Rect width_X="${fmtNumber(widthX)}" width_Y="${fmtNumber(widthY)}" depth="${fmtNumber(depth)}"/>`,
  );
  lines.push(`${indent(level + 1)}</StbSecFigureFoundation_RC>`);
  // Bar placement cannot be reconstructed from an IFC extrusion; omit the optional
  // bar arrangement instead of publishing fabricated 0 mm cover/reinforcement.
  lines.push(`${indent(level)}</StbSecFoundation_RC>`);
}

function generateRcPileSection(lines, sectionId, sec, level) {
  const indent = (l) => '  '.repeat(l);
  const sourceTag = sec.pileTagName || 'StbSecPile_RC_Straight';
  const suffix = sourceTag.replace(/^StbSecPile_RC_/, '');
  const tags = new Set(['Straight', 'ExtendedTop', 'ExtendedFoot', 'ExtendedTopFoot']);
  // Fail closed rather than changing an unknown RC pile to an invented straight shape.
  if (!tags.has(suffix)) throw new Error(`Unsupported RC pile cross-section: ${sourceTag}`);
  const tagName = `StbSecPile_RC_Conventional${suffix}`;
  const params = sec.params || {};
  const paramStr = Object.entries(params)
    .map(([k, v]) => `${k}="${fmtNumber(v)}"`)
    .join(' ');
  lines.push(
    `${indent(level)}<StbSecPile_RC id="${sectionId}" name="${escXml(sec.name || `Pile-RC-${sectionId}`)}">`,
  );
  lines.push(`${indent(level + 1)}<StbSecPile_RC_Conventional>`);
  lines.push(`${indent(level + 2)}<StbSecFigurePile_RC_Conventional>`);
  lines.push(`${indent(level + 3)}<${tagName}${paramStr ? ` ${paramStr}` : ''}/>`);
  lines.push(`${indent(level + 2)}</StbSecFigurePile_RC_Conventional>`);
  lines.push(`${indent(level + 1)}</StbSecPile_RC_Conventional>`);
  lines.push(`${indent(level)}</StbSecPile_RC>`);
}

function generateSteelPileSection(lines, sectionId, sec, element, level) {
  const indent = (l) => '  '.repeat(l);
  const segments = Array.isArray(sec.segments) ? sec.segments : [];
  const lengthPile = Number.isFinite(element?.lengthAll) ? element.lengthAll : 0;
  lines.push(
    `${indent(level)}<StbSecPile_S id="${sectionId}" name="${escXml(sec.name || `Pile-S-${sectionId}`)}">`,
  );
  lines.push(`${indent(level + 1)}<StbSecPile_S_Conventional>`);
  lines.push(`${indent(level + 2)}<StbSecFigurePile_S>`);
  if (segments.length > 0) {
    for (const segment of segments) {
      lines.push(
        `${indent(level + 3)}<StbSecPile_S_Straight id_order="${segment.id_order}" length_pile="${fmtNumber(segment.length_pile)}" D="${fmtNumber(segment.D)}" t="${fmtNumber(segment.t)}" strength="${escXml(segment.strength || '')}"/>`,
      );
    }
  } else {
    lines.push(
      `${indent(level + 3)}<StbSecPile_S_Straight id_order="1" length_pile="${fmtNumber(sec.params.length_pile ?? lengthPile)}" D="${fmtNumber(sec.params.D)}" t="${fmtNumber(sec.params.t)}" strength=""/>`,
    );
  }
  lines.push(`${indent(level + 2)}</StbSecFigurePile_S>`);
  lines.push(`${indent(level + 1)}</StbSecPile_S_Conventional>`);
  lines.push(`${indent(level)}</StbSecPile_S>`);
}

function generatePileProductSection(lines, sectionId, sec, level) {
  const indent = (l) => '  '.repeat(l);
  const segments = Array.isArray(sec.segments) ? sec.segments : [];

  lines.push(
    `${indent(level)}<StbSecPilePrecast id="${sectionId}" name="${escXml(sec.name || `Pile-PC-${sectionId}`)}">`,
  );
  lines.push(`${indent(level + 1)}<StbSecPilePrecastConventional>`);
  lines.push(`${indent(level + 2)}<StbSecFigurePilePrecast>`);

  if (segments.length > 0) {
    const typeOrder = [
      'StbSecPilePrecast_PHC',
      'StbSecPilePrecast_ST',
      'StbSecPilePrecast_SC',
      'StbSecPilePrecast_PRC',
      'StbSecPilePrecast_CPRC',
      'StbSecPilePrecastNodular_PHC',
      'StbSecPilePrecastNodular_PRC',
      'StbSecPilePrecastNodular_CPRC',
      'StbSecPilePrecastProduct',
    ];
    const tagFor = (segment) =>
      (segment.tagName || 'StbSecPileProduct_PHC')
        .replace(/^StbSecPileProductNodular_/, 'StbSecPilePrecastNodular_')
        .replace(/^StbSecPileProduct_/, 'StbSecPilePrecast_');
    for (const segment of [...segments].sort(
      (a, b) => typeOrder.indexOf(tagFor(a)) - typeOrder.indexOf(tagFor(b)),
    )) {
      const tagName = tagFor(segment);
      if (!typeOrder.includes(tagName))
        throw new Error(`Unsupported precast pile segment: ${tagName}`);
      if (/_PHC$|_ST$/.test(tagName) && !segment.kind) {
        throw new Error(`Precast pile ${sec.name}: missing mandatory kind for ${tagName}`);
      }
      if (/_SC$/.test(tagName) && !(Number(segment.ts) > 0)) {
        throw new Error(`Precast pile ${sec.name}: missing positive steel-pipe thickness ts`);
      }
      if (/(Nodular_|_ST$)/.test(tagName) && !(Number(segment.D2) > 0)) {
        throw new Error(`Precast pile ${sec.name}: missing required secondary diameter D2`);
      }
      const attrs = [
        `id_order="${segment.id_order}"`,
        `length_pile="${fmtNumber(segment.length_pile)}"`,
      ];

      if (/Nodular_.*PRC/i.test(tagName)) {
        attrs.push(
          `D1="${fmtNumber(segment.D)}"`,
          `D2="${fmtNumber(segment.D2 ?? segment.D)}"`,
          `tc="${fmtNumber(segment.t)}"`,
        );
      } else if (/Nodular_/i.test(tagName)) {
        attrs.push(
          `D1="${fmtNumber(segment.D)}"`,
          `D2="${fmtNumber(segment.D2 ?? segment.D)}"`,
          `t="${fmtNumber(segment.t)}"`,
        );
      } else if (/_ST$/i.test(tagName)) {
        attrs.push(
          `D1="${fmtNumber(segment.D)}"`,
          `D2="${fmtNumber(segment.D2 ?? segment.D)}"`,
          `t1="${fmtNumber(segment.t1 ?? segment.t)}"`,
          `t2="${fmtNumber(segment.t2 ?? segment.t)}"`,
        );
      } else if (/_SC$/i.test(tagName)) {
        attrs.push(
          `D="${fmtNumber(segment.D)}"`,
          `tc="${fmtNumber(segment.t)}"`,
          `ts="${fmtNumber(segment.ts)}"`,
        );
      } else if (/_PRC$/i.test(tagName) || /_CPRC$/i.test(tagName)) {
        attrs.push(`D="${fmtNumber(segment.D)}"`, `tc="${fmtNumber(segment.t)}"`);
      } else {
        attrs.push(`D="${fmtNumber(segment.D)}"`, `t="${fmtNumber(segment.t)}"`);
      }

      if (segment.kind !== undefined) attrs.push(`kind="${escXml(segment.kind)}"`);
      lines.push(`${indent(level + 3)}<${tagName} ${attrs.join(' ')}/>`);
    }
  } else {
    throw new Error(`Precast pile ${sec.name}: section segments are unavailable`);
  }

  lines.push(`${indent(level + 2)}</StbSecFigurePilePrecast>`);
  lines.push(`${indent(level + 1)}</StbSecPilePrecastConventional>`);
  lines.push(`${indent(level)}</StbSecPilePrecast>`);
}

function generateHaunchBeamFigure(lines, sec, haunch, level) {
  const indent = (l) => '  '.repeat(l);
  const h = haunch.sections;
  let shapes;
  if (haunch.pattern === 'TAPER') {
    shapes = [h.start?.name || sec.name, h.end?.name || sec.name];
  } else {
    const center = sec.name;
    shapes = [
      haunch.haunchStart > 0 ? `${center}-H` : center,
      center,
      haunch.haunchEnd > 0 ? `${center}-H` : center,
    ];
  }
  // Preserve each original station label, without inventing a steel strength grade.
  for (const [index, shape] of shapes.entries()) {
    lines.push(`${indent(level)}<StbSecSteelBeam_S_Shape order="${index + 1}">`);
    lines.push(
      `${indent(level + 1)}<StbSecSteelBeamStraight shape="${escXml(shape)}" strength_main="${escXml(sec.params?.strength_main || '')}"/>`,
    );
    lines.push(`${indent(level)}</StbSecSteelBeam_S_Shape>`);
  }
}
/** XML特殊文字エスケープ */
function escXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fmtNumber(value) {
  if (value === null || value === undefined || value === '') return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);

  const nearestInteger = Math.round(numeric);
  if (Math.abs(numeric - nearestInteger) < 1e-9) return String(nearestInteger);

  return String(Number(numeric.toFixed(6)));
}
