/**
 * @fileoverview StbStripFooting / StbSecFoundation_RC_Continuous の3D配筋用facts抽出。
 *
 * ST-Bridgeで明示された値だけを正本とし、Continuous固有の切替・テーパー・片側L形を
 * 推定しない。未対応条件はplacement層でSPECIAL_REQUIREDへ送る。
 *
 * @module data/extractors/rebar3d/stripFootingRebarSectionFacts
 */

import { barDiameterMm } from '../../../constants/beamOpeningRules.js';
import { querySelector, querySelectorAll } from '../sectionListUtils.js';

const CONTINUOUS_TYPES = new Set(['RIGHT_L', 'LEFT_L', 'REVERSE_T']);
const CONTINUOUS_POSITIONS = new Set([
  'MAIN_BASE_TOP',
  'MAIN_BASE_BOTTOM',
  'MAIN_TIP_TOP',
  'MAIN_TIP_BOTTOM',
  'TRANSVERSE_TOP',
  'TRANSVERSE_BOTTOM',
  'HORIZONTAL',
]);

export function numberAttr(element, name) {
  const raw = element?.getAttribute?.(name);
  if (raw == null || raw === '') return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function positiveIntegerAttr(element, name) {
  const value = numberAttr(element, name);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function textAttr(element, name) {
  const raw = element?.getAttribute?.(name);
  return raw == null || raw === '' ? null : String(raw);
}

function booleanAttr(element, name) {
  const raw = textAttr(element, name);
  if (raw == null) return false;
  return raw.toLowerCase() === 'true';
}

function legacyFoundationCover(xmlDoc) {
  const applyList = querySelector(xmlDoc, 'StbApplyConditionsList');
  if (!applyList) return null;
  const apply = querySelector(applyList, 'StbFoundation_RC_BarPositionApply');
  if (!apply || !booleanAttr(apply, 'set_default')) return null;
  const value = numberAttr(apply, 'depth_cover');
  return value >= 0 ? value : null;
}

function parseContinuousShape(section) {
  const figure = querySelector(section, 'StbSecFigureFoundation_RC') || section;
  const element = querySelector(figure, 'StbSecFoundation_RC_Continuous');
  if (!element) return null;

  const type = textAttr(element, 'type')?.toUpperCase() || null;
  const widthMm = numberAttr(element, 'width');
  const depthBaseMm = numberAttr(element, 'depth_base');
  const depthTipMm = numberAttr(element, 'depth_tip');
  const valid = CONTINUOUS_TYPES.has(type) && widthMm > 0 && depthBaseMm > 0 && depthTipMm > 0;

  return {
    kind: 'CONTINUOUS',
    type,
    widthMm,
    depthBaseMm,
    depthTipMm,
    valid,
  };
}

function parseContinuousBar(element) {
  const pos = textAttr(element, 'pos')?.toUpperCase() || null;
  const designation = textAttr(element, 'D');
  const diaMm = designation ? barDiameterMm(designation, 0) : 0;
  const count = positiveIntegerAttr(element, 'N');
  const pitchMm = numberAttr(element, 'pitch');
  const lengthMm = numberAttr(element, 'length');
  const mainType = textAttr(element, 'main_type')?.toUpperCase() || null;
  const isVertical = booleanAttr(element, 'isVertical');
  const lengthVerticalMm = numberAttr(element, 'length_vertical');
  const hasLengthVertical = textAttr(element, 'length_vertical') != null;
  const hasIsVertical = textAttr(element, 'isVertical') != null;

  const invalidVerticalSemantics =
    pos === 'HORIZONTAL'
      ? hasIsVertical || hasLengthVertical
      : (!isVertical && hasLengthVertical) ||
        (isVertical && hasLengthVertical && !(lengthVerticalMm > 0));

  const isMain = pos?.startsWith('MAIN_') === true;
  const usesPitch = isMain;
  const distributionValid = usesPitch ? pitchMm > 0 : count > 0;
  const irrelevantDistributionInvalid = usesPitch
    ? count != null && !(count > 0)
    : pitchMm != null && !(pitchMm > 0);

  const valid =
    CONTINUOUS_POSITIONS.has(pos) &&
    diaMm > 0 &&
    distributionValid &&
    !irrelevantDistributionInvalid &&
    !invalidVerticalSemantics;

  return {
    pos,
    designation,
    diaMm,
    count,
    pitchMm,
    lengthMm,
    mainType,
    isVertical,
    lengthVerticalMm,
    strength: textAttr(element, 'strength'),
    valid,
  };
}

export function parseStripFootingSectionMap(xmlDoc) {
  const fallbackCoverMm = legacyFoundationCover(xmlDoc);
  const sections = new Map();

  for (const section of querySelectorAll(xmlDoc, 'StbSecFoundation_RC')) {
    const id = textAttr(section, 'id');
    if (!id) continue;

    const shape = parseContinuousShape(section);
    if (!shape) continue;

    const arrangement = querySelector(section, 'StbSecBarArrangementFoundation_RC');
    const bars = arrangement
      ? querySelectorAll(arrangement, 'StbSecBarFoundation_RC_Continuous').map(parseContinuousBar)
      : [];

    const coverTopMm = arrangement
      ? (numberAttr(arrangement, 'depth_cover_top') ?? fallbackCoverMm)
      : fallbackCoverMm;
    const coverBottomMm = arrangement
      ? (numberAttr(arrangement, 'depth_cover_bottom') ?? fallbackCoverMm)
      : fallbackCoverMm;
    const coverSideMm = arrangement
      ? (numberAttr(arrangement, 'depth_cover_side') ?? fallbackCoverMm)
      : fallbackCoverMm;

    sections.set(id, {
      id,
      name: textAttr(section, 'name'),
      shape,
      bars,
      coverTopMm,
      coverBottomMm,
      coverSideMm,
      invalidBarCount: bars.filter((bar) => !bar.valid).length,
      duplicatePositions: [...new Set(bars.map((bar) => bar.pos).filter(Boolean))].filter(
        (pos) => bars.filter((bar) => bar.pos === pos).length > 1,
      ),
    });
  }

  return sections;
}

export function readStripFootingNodeMap(xmlDoc) {
  const nodes = new Map();
  for (const element of querySelectorAll(xmlDoc, 'StbNode')) {
    const id = textAttr(element, 'id');
    const x = numberAttr(element, 'X');
    const y = numberAttr(element, 'Y');
    const z = numberAttr(element, 'Z');
    if (!id || ![x, y, z].every(Number.isFinite)) continue;
    nodes.set(id, { id, x, y, z });
  }
  return nodes;
}

function referenceKey(startNodeId, endNodeId) {
  return `${startNodeId || ''}->${endNodeId || ''}`;
}

function optionalNumberAttrOrZero(element, name) {
  if (!element?.hasAttribute?.(name)) return 0;
  const raw = element.getAttribute(name);
  if (raw == null || raw === '') return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function nodeWithBeamOffset(node, element, prefix) {
  if (!node) return null;
  const dx = optionalNumberAttrOrZero(element, `offset_${prefix}_X`);
  const dy = optionalNumberAttrOrZero(element, `offset_${prefix}_Y`);
  const dz = optionalNumberAttrOrZero(element, `offset_${prefix}_Z`);
  if (![dx, dy, dz].every(Number.isFinite)) return null;
  return {
    x: node.x + dx,
    y: node.y + dy,
    z: node.z + dz,
  };
}

function sideCoordinates(widthMm, horizontalOffsetMm) {
  if (!(widthMm > 0) || !Number.isFinite(horizontalOffsetMm)) return null;
  return {
    leftY: horizontalOffsetMm + widthMm / 2,
    rightY: horizontalOffsetMm - widthMm / 2,
  };
}

function parseFoundationBeamSectionProfile(section) {
  const id = textAttr(section, 'id');
  const figures = querySelectorAll(section, 'StbSecFigureBeam_RC');
  if (figures.length !== 1) {
    return {
      id,
      status: 'UNRESOLVED',
      reason: figures.length === 0 ? 'FIGURE_MISSING' : 'MULTIPLE_FIGURES_UNSUPPORTED',
      figureCount: figures.length,
    };
  }

  const figure = figures[0];
  const straight = querySelector(figure, 'StbSecBeamStraight');
  const taper = querySelector(figure, 'StbSecBeamTaper');
  if (Boolean(straight) === Boolean(taper)) {
    return { id, status: 'UNRESOLVED', reason: 'FIGURE_KIND_UNRESOLVED' };
  }

  if (straight) {
    const widthMm = numberAttr(straight, 'width');
    const horizontalOffsetMm = optionalNumberAttrOrZero(straight, 'horizontal_offset');
    const sides = sideCoordinates(widthMm, horizontalOffsetMm);
    if (!sides) return { id, status: 'UNRESOLVED', reason: 'STRAIGHT_GEOMETRY_INVALID' };
    return {
      id,
      status: 'READY',
      profileKind: 'STRAIGHT',
      startWidthMm: widthMm,
      endWidthMm: widthMm,
      startHorizontalOffsetMm: horizontalOffsetMm,
      endHorizontalOffsetMm: horizontalOffsetMm,
      startLeftY: sides.leftY,
      endLeftY: sides.leftY,
      startRightY: sides.rightY,
      endRightY: sides.rightY,
      basis: 'STB_RC_BEAM_SINGLE_FIGURE_TRANSVERSE_FACES',
    };
  }

  const startWidthMm = numberAttr(taper, 'start_width');
  const endWidthMm = numberAttr(taper, 'end_width');
  const startHorizontalOffsetMm = optionalNumberAttrOrZero(taper, 'start_horizontal_offset');
  const endHorizontalOffsetMm = optionalNumberAttrOrZero(taper, 'end_horizontal_offset');
  const startSides = sideCoordinates(startWidthMm, startHorizontalOffsetMm);
  const endSides = sideCoordinates(endWidthMm, endHorizontalOffsetMm);
  if (!startSides || !endSides) {
    return { id, status: 'UNRESOLVED', reason: 'TAPER_GEOMETRY_INVALID' };
  }
  return {
    id,
    status: 'READY',
    profileKind: 'TAPER',
    startWidthMm,
    endWidthMm,
    startHorizontalOffsetMm,
    endHorizontalOffsetMm,
    startLeftY: startSides.leftY,
    endLeftY: endSides.leftY,
    startRightY: startSides.rightY,
    endRightY: endSides.rightY,
    basis: 'STB_RC_BEAM_SINGLE_FIGURE_TRANSVERSE_FACES',
  };
}

export function parseFoundationBeamSectionMap(xmlDoc) {
  const sections = new Map();
  for (const section of querySelectorAll(xmlDoc, 'StbSecBeam_RC')) {
    const id = textAttr(section, 'id');
    if (!id) continue;
    sections.set(id, parseFoundationBeamSectionProfile(section));
  }
  return sections;
}

/**
 * StbStripFooting の位置基準となる基礎梁の始終端基準点を抽出する。
 *
 * ST-Bridgeでは布基礎の offset / level / 余長を、対応する梁の始終端基準点を結ぶ線から
 * 定義するため、節点座標を直接使わない。同一始終端に複数の基礎梁がある場合や、
 * 中間節点を持つ梁はこのsliceでは一意化せず unresolved として保持する。
 */
export function parseFoundationBeamReferenceMap(xmlDoc, nodes) {
  const candidatesByKey = new Map();
  const rcBeamSections = parseFoundationBeamSectionMap(xmlDoc);

  const beamElements = [
    ...querySelectorAll(xmlDoc, 'StbGirder').map((element) => ({
      element,
      elementType: 'StbGirder',
    })),
    ...querySelectorAll(xmlDoc, 'StbBeam').map((element) => ({ element, elementType: 'StbBeam' })),
  ];

  for (const { element, elementType } of beamElements) {
    if (!booleanAttr(element, 'isFoundation')) continue;

    const startNodeId = textAttr(element, 'id_node_start');
    const endNodeId = textAttr(element, 'id_node_end');
    if (!startNodeId || !endNodeId) continue;

    const key = referenceKey(startNodeId, endNodeId);
    const startNode = nodes.get(startNodeId);
    const endNode = nodes.get(endNodeId);
    const viaNodeTag = elementType === 'StbGirder' ? 'StbGirderViaNode' : 'StbBeamViaNode';
    const hasViaNode = Boolean(querySelector(element, viaNodeTag));
    const start = nodeWithBeamOffset(startNode, element, 'start');
    const end = nodeWithBeamOffset(endNode, element, 'end');
    const valid =
      !hasViaNode &&
      start != null &&
      end != null &&
      [start.x, start.y, start.z, end.x, end.y, end.z].every(Number.isFinite);
    const beamSectionId = textAttr(element, 'id_section');
    const beamStructureKind = textAttr(element, 'kind_structure')?.toUpperCase() || null;

    const candidate = {
      beamElementType: elementType,
      beamId: textAttr(element, 'id'),
      beamName: textAttr(element, 'name'),
      beamStructureKind,
      beamSectionId,
      beamSectionProfile:
        beamStructureKind === 'RC' && beamSectionId
          ? rcBeamSections.get(beamSectionId) || null
          : null,
      startNodeId,
      endNodeId,
      start,
      end,
      hasViaNode,
      valid,
    };
    if (!candidatesByKey.has(key)) candidatesByKey.set(key, []);
    candidatesByKey.get(key).push(candidate);
  }

  const references = new Map();
  for (const [key, candidates] of candidatesByKey) {
    if (candidates.length !== 1) {
      references.set(key, {
        status: 'AMBIGUOUS',
        key,
        candidateCount: candidates.length,
        beamRefs: candidates.map((candidate) => ({
          elementType: candidate.beamElementType,
          id: candidate.beamId,
        })),
      });
      continue;
    }

    const [candidate] = candidates;
    if (!candidate.valid) {
      references.set(key, {
        status: 'UNRESOLVED',
        key,
        reason: candidate.hasViaNode ? 'VIA_NODE_UNSUPPORTED' : 'REFERENCE_POINT_UNRESOLVED',
        beamElementType: candidate.beamElementType,
        beamId: candidate.beamId,
      });
      continue;
    }

    references.set(key, {
      status: 'READY',
      key,
      ...candidate,
    });
  }

  return references;
}

export function parseStripFootingMembers(xmlDoc) {
  return querySelectorAll(xmlDoc, 'StbStripFooting').map((element) => ({
    id: textAttr(element, 'id'),
    name: textAttr(element, 'name'),
    sectionId: textAttr(element, 'id_section'),
    startNodeId: textAttr(element, 'id_node_start'),
    endNodeId: textAttr(element, 'id_node_end'),
    levelMm: numberAttr(element, 'level') ?? 0,
    offsetMm: numberAttr(element, 'offset') ?? 0,
    lengthExStartMm: numberAttr(element, 'length_ex_start') ?? 0,
    lengthExEndMm: numberAttr(element, 'length_ex_end') ?? 0,
    referenceKey: referenceKey(
      textAttr(element, 'id_node_start'),
      textAttr(element, 'id_node_end'),
    ),
  }));
}

export const _stripFootingRebarSectionFactsInternals = {
  parseContinuousShape,
  parseContinuousBar,
  legacyFoundationCover,
  referenceKey,
  optionalNumberAttrOrZero,
  nodeWithBeamOffset,
  parseFoundationBeamSectionProfile,
  sideCoordinates,
};
