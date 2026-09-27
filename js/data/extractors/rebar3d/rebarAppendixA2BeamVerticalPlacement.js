/**
 * @fileoverview 配筋指針2010 付録A A2の直交梁組立順をproduction主筋高さへ接続する。
 *
 * 付録A2の組立順による上端/下端かぶりstackingを、section-level layoutそのものは
 * 変更せず、memberごとのrender-time layout cloneへ適用する。
 *
 * precedence:
 * - STB明示の主筋芯/かぶりは保護し、A2標準値で上書きしない。
 * - global X/Y軸へ解決できない梁、断面rotateを持つ梁、端部ごとに矛盾する要求は
 *   production自動適用せずUNRESOLVEDとする。
 */

import { getRebarCommonConfig } from '../../../config/rebarCommonConfig.js';
import { barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';
import { resolveAppendixA2OrthogonalBeamCoverStacking } from './rebarAppendixA2BeamLayering.js';
import { collectRebarAppendixA2JointAssemblyChecks } from './rebarAppendixA2JointAssemblyChecks.js';
import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';

const EPS = 1e-8;
const A2_LAYERING_RULE = rebarRuleTraceMetadata('APPENDIX-A2-ORTHOGONAL-BEAM-COVER-STACKING');

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function endpointPositionFact(layout, endpoint) {
  const facts = layout?.positionFacts || {};
  const preferred =
    endpoint === 'start'
      ? ['LEFT', 'START', 'SAME', 'CENTER', 'RIGHT', 'END']
      : ['RIGHT', 'END', 'SAME', 'CENTER', 'LEFT', 'START'];
  for (const key of preferred) {
    if (facts[key]) return { key, fact: facts[key] };
  }
  const first = Object.entries(facts)[0];
  return first ? { key: first[0], fact: first[1] } : null;
}

function layoutForBeamFact(beamFact, beamLayoutMaps) {
  const sectionId = normalizeId(beamFact?.sectionId);
  if (!sectionId) return null;
  const map = beamFact?.tagName === 'StbBeam' ? beamLayoutMaps?.beam : beamLayoutMaps?.girder;
  return map?.get(sectionId) || null;
}

function firstLayerBarsAtEndpoint(beamFact, beamLayoutMaps) {
  const layout = layoutForBeamFact(beamFact, beamLayoutMaps);
  const selected = endpointPositionFact(layout, beamFact?.endpoint);
  if (!selected?.fact) return [];
  return (selected.fact.mainBars || []).filter(
    (bar) =>
      Number(bar?.layer) === 1 && ['top', 'bottom'].includes(String(bar?.role || '').toLowerCase()),
  );
}

function maxFirstLayerOuterDiameter(facts, beamLayoutMaps) {
  let max = null;
  for (const fact of facts || []) {
    for (const bar of firstLayerBarsAtEndpoint(fact, beamLayoutMaps)) {
      const outer = barOuterDiameterMm(bar?.diaName, Number(bar?.dia));
      if (Number.isFinite(outer) && outer > 0) max = Math.max(max || 0, outer);
    }
  }
  return max;
}

function firstLayerDatumSources(layout, role) {
  const normalizedRole = String(role || '').toLowerCase();
  const sources = [];
  for (const fact of Object.values(layout?.positionFacts || {})) {
    const layers = normalizedRole === 'top' ? fact?.topLayers : fact?.bottomLayers;
    const source = layers?.[0]?.positionSource;
    if (source) sources.push(String(source));
  }
  return [...new Set(sources)];
}

function protectedByExplicitDatum(layout, role) {
  const sources = firstLayerDatumSources(layout, role);
  if (sources.length === 0) {
    return {
      protected: true,
      reason: 'appendix-a2-vertical-datum-source-unresolved',
      sources,
    };
  }
  const explicit = sources.filter((source) => source.startsWith('stb-'));
  if (explicit.length > 0) {
    return {
      protected: true,
      reason: 'appendix-a2-explicit-stb-vertical-datum-protected',
      sources,
    };
  }
  if (sources.includes('unresolved')) {
    return {
      protected: true,
      reason: 'appendix-a2-vertical-datum-source-unresolved',
      sources,
    };
  }
  return { protected: false, reason: null, sources };
}

function roleShiftForAxis(stacking, axis) {
  const cover = stacking?.roundedCoverMm?.[axis];
  const base = Number(stacking?.baseCoverMm);
  if (!cover || !Number.isFinite(base)) return null;
  return {
    top: Math.max(0, Number(cover.top) - base),
    bottom: Math.max(0, Number(cover.bottom) - base),
  };
}

function createMemberDraft(fact) {
  return {
    memberId: normalizeId(fact?.id),
    memberTag: fact?.tagName || null,
    sectionId: normalizeId(fact?.sectionId),
    axis: fact?.axis || null,
    status: 'READY',
    reason: null,
    roleShiftsMm: { top: 0, bottom: 0 },
    endpointRequirements: [],
    protectedRoles: [],
    appliedRules: [A2_LAYERING_RULE],
  };
}

function mergeRequirement(draft, role, deltaMm, requirement) {
  if (!(deltaMm > EPS)) return;

  const previous = Number(draft.roleShiftsMm[role]) || 0;
  if (previous > EPS && Math.abs(previous - deltaMm) > EPS) {
    draft.status = 'UNRESOLVED';
    draft.reason = 'appendix-a2-member-end-vertical-shift-conflict';
    draft.endpointRequirements.push({
      ...requirement,
      role,
      deltaMm,
      conflictWithMm: previous,
    });
    return;
  }
  draft.roleShiftsMm[role] = deltaMm;
  draft.endpointRequirements.push({ ...requirement, role, deltaMm });
}

function finalizeMemberDraft(draft, layout) {
  if (draft.status !== 'READY') return draft;
  if (!layout) {
    return {
      ...draft,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-member-layout-unresolved',
    };
  }

  for (const role of ['top', 'bottom']) {
    const delta = Number(draft.roleShiftsMm[role]) || 0;
    if (!(delta > EPS)) continue;
    const protection = protectedByExplicitDatum(layout, role);
    if (protection.protected) {
      draft.status = 'UNRESOLVED';
      draft.reason = protection.reason;
      draft.protectedRoles.push({ role, sources: protection.sources });
    }
  }

  if (draft.status === 'READY' && !Object.values(draft.roleShiftsMm).some((value) => value > EPS)) {
    draft.status = 'NO_SHIFT';
  }
  return draft;
}

export function buildAppendixA2BeamVerticalPlacementPlanFromChecks(
  checks,
  beamLayoutMaps,
  options = {},
) {
  const members = new Map();
  const unresolved = [];
  const baseCoverMm =
    Number.isFinite(Number(options.baseCoverMm)) && Number(options.baseCoverMm) > 0
      ? Number(options.baseCoverMm)
      : 40;

  for (const check of checks || []) {
    if (
      check?.status !== 'RESOLVED' ||
      !['X', 'Y'].includes(check?.firstAxis) ||
      !['X', 'Y'].includes(check?.secondAxis)
    ) {
      continue;
    }

    const xOuter = maxFirstLayerOuterDiameter(check.xBeams, beamLayoutMaps);
    const yOuter = maxFirstLayerOuterDiameter(check.yBeams, beamLayoutMaps);
    const stacking = resolveAppendixA2OrthogonalBeamCoverStacking({
      assemblyOrder: check.assemblyOrder,
      baseCoverMm,
      xMainBarOuterDiameterMm: xOuter,
      yMainBarOuterDiameterMm: yOuter,
    });
    if (!stacking.ok) {
      unresolved.push({
        nodeId: check.nodeId,
        reason: stacking.reason,
        assemblyOrder: check.assemblyOrder,
      });
      continue;
    }

    for (const fact of [...(check.xBeams || []), ...(check.yBeams || [])]) {
      if (!fact?.id || !['X', 'Y'].includes(fact.axis)) continue;
      const memberId = String(fact.id);
      let draft = members.get(memberId);
      if (!draft) {
        draft = createMemberDraft(fact);
        members.set(memberId, draft);
      }

      const rollAngleDeg = Number(fact.rollAngleDeg || 0);
      if (Math.abs(rollAngleDeg) > EPS) {
        draft.status = 'UNRESOLVED';
        draft.reason = 'appendix-a2-beam-section-roll-not-supported';
        continue;
      }

      const shift = roleShiftForAxis(stacking, fact.axis);
      if (!shift) {
        draft.status = 'UNRESOLVED';
        draft.reason = 'appendix-a2-vertical-shift-unresolved';
        continue;
      }

      for (const role of ['top', 'bottom']) {
        mergeRequirement(draft, role, shift[role], {
          nodeId: check.nodeId,
          endpoint: fact.endpoint,
          axis: fact.axis,
          assemblyOrder: check.assemblyOrder,
          baseCoverMm: stacking.baseCoverMm,
          roundedCoverMm: stacking.roundedCoverMm[fact.axis][role],
        });
      }
    }
  }

  for (const [memberId, draft] of members) {
    const map = draft.memberTag === 'StbBeam' ? beamLayoutMaps?.beam : beamLayoutMaps?.girder;
    members.set(memberId, finalizeMemberDraft(draft, map?.get(draft.sectionId) || null));
  }

  return {
    members,
    unresolved,
    baseCoverMm,
    geometryApplication: 'PRODUCTION_MEMBER_LAYOUT_READY',
    appliedRules: [A2_LAYERING_RULE],
  };
}

export function buildAppendixA2BeamVerticalPlacementPlan(xmlDoc, options = {}) {
  if (!xmlDoc) {
    return {
      members: new Map(),
      unresolved: [],
      baseCoverMm: 40,
      geometryApplication: 'PRODUCTION_MEMBER_LAYOUT_READY',
      appliedRules: [A2_LAYERING_RULE],
    };
  }

  const commonConfig = options.commonConfig || getRebarCommonConfig();
  const choice = options.choice ?? commonConfig.detailing?.choice;
  const checks =
    options.checks ||
    collectRebarAppendixA2JointAssemblyChecks(xmlDoc, {
      choice,
      beamLayoutMaps: options.beamLayoutMaps,
      columnLayoutMap: options.columnLayoutMap,
      geometryChecks: options.geometryChecks !== false,
    });

  return buildAppendixA2BeamVerticalPlacementPlanFromChecks(checks, options.beamLayoutMaps, {
    baseCoverMm: options.baseCoverMm,
  });
}

function shiftBar(bar, roleShiftsMm) {
  const role = String(bar?.role || '').toLowerCase();
  const delta = Number(roleShiftsMm?.[role]) || 0;
  if (!(delta > EPS) || !['top', 'bottom'].includes(role)) return { ...bar };

  const direction = role === 'top' ? -1 : 1;
  const centerFromTop = Number(bar?.centerFromTopMm);
  return {
    ...bar,
    v: Number(bar.v) + direction * delta,
    ...(Number.isFinite(centerFromTop)
      ? { centerFromTopMm: centerFromTop + (role === 'top' ? delta : -delta) }
      : {}),
    appendixA2VerticalShiftMm: delta,
    appendixA2VerticalPlacementApplied: true,
  };
}

function verticalShiftForRole(roleShiftsMm, role) {
  const normalizedRole = String(role || '').toLowerCase();
  const delta = Number(roleShiftsMm?.[normalizedRole]) || 0;
  if (!(delta > EPS) || !['top', 'bottom'].includes(normalizedRole)) return 0;
  return normalizedRole === 'top' ? -delta : delta;
}

function verticalAnchorageKey(endpoint, item, originalV = item?.v) {
  const u = Number(item?.u);
  const v = Number(originalV);
  const dia = Number(item?.dia);
  if (!['start', 'end'].includes(endpoint) || ![u, v, dia].every(Number.isFinite)) return null;
  return [endpoint, u.toFixed(6), v.toFixed(6), dia.toFixed(6)].join('|');
}

/**
 * A2 vertical placementをgeneric beam anchorageのbar/pieceにも同じmember role shiftで適用する。
 * Appendix A2 corner explicit path自体はここでは変更せず、既存world resolverのvertical shiftへ委ねる。
 */
export function applyAppendixA2VerticalPlacementToAnchorage(anchorage, memberPlan) {
  if (!anchorage || memberPlan?.status !== 'READY') return anchorage;
  const roleShiftsMm = memberPlan.roleShiftsMm || {};
  if (!Object.values(roleShiftsMm).some((value) => Number(value) > EPS)) return anchorage;

  const pieceShiftByKey = new Map();
  const ends = (anchorage.ends || []).map((end) => ({
    ...end,
    bars: (end.bars || []).map((bar) => {
      const deltaV = verticalShiftForRole(roleShiftsMm, bar?.role);
      if (Math.abs(deltaV) <= EPS) return { ...bar };
      const key = verticalAnchorageKey(end.side, bar);
      if (key) pieceShiftByKey.set(key, deltaV);
      return {
        ...bar,
        v: Number(bar.v) + deltaV,
        appendixA2VerticalPlacementOriginalV: Number(bar.v),
        appendixA2VerticalShiftMm: Math.abs(deltaV),
        appendixA2VerticalPlacementApplied: true,
      };
    }),
  }));

  const pieces = (anchorage.pieces || []).map((piece) => {
    const key = verticalAnchorageKey(piece?.anchor, piece);
    const deltaV = key ? Number(pieceShiftByKey.get(key)) || 0 : 0;
    if (Math.abs(deltaV) <= EPS) return { ...piece };
    return {
      ...piece,
      v: Number(piece.v) + deltaV,
      appendixA2VerticalPlacementOriginalV: Number(piece.v),
      appendixA2VerticalShiftMm: Math.abs(deltaV),
      appendixA2VerticalPlacementApplied: true,
    };
  });

  return {
    ...anchorage,
    ends,
    pieces,
    appendixA2VerticalPlacement: {
      memberId: memberPlan.memberId,
      axis: memberPlan.axis,
      roleShiftsMm: { ...roleShiftsMm },
      source: 'RC_DETAILING_GUIDE_2010_APPENDIX_A2',
    },
  };
}

export function applyAppendixA2VerticalPlacementToAnchorageMaps(anchorageMaps, plan) {
  if (!anchorageMaps || !(plan?.members instanceof Map)) return anchorageMaps;
  const result = {
    ...anchorageMaps,
    girder: new Map(anchorageMaps.girder || []),
    beam: new Map(anchorageMaps.beam || []),
  };
  // Current A2 vertical production is connected only to StbGirder rendering.
  // Keep the anchorage adapter at the same scope; do not mutate StbBeam entries
  // that are not receiving the corresponding main-bar vertical placement.
  for (const [memberId, anchorage] of result.girder) {
    const memberPlan = plan.members.get(String(memberId)) || null;
    if (memberPlan?.status !== 'READY' || memberPlan.memberTag !== 'StbGirder') continue;
    result.girder.set(memberId, applyAppendixA2VerticalPlacementToAnchorage(anchorage, memberPlan));
  }
  return result;
}

/**
 * member-specific A2 planをsection layout cloneへ適用する。
 * 元layoutは変更しない。
 */
export function applyAppendixA2VerticalPlacementToLayout(layout, memberPlan) {
  if (!layout || memberPlan?.status !== 'READY') return layout;
  const roleShiftsMm = memberPlan.roleShiftsMm || {};
  if (!Object.values(roleShiftsMm).some((value) => Number(value) > EPS)) return layout;

  return {
    ...layout,
    segments: (layout.segments || []).map((segment) => ({
      ...segment,
      bars: (segment.bars || []).map((bar) => shiftBar(bar, roleShiftsMm)),
    })),
    appendixA2VerticalPlacement: {
      memberId: memberPlan.memberId,
      axis: memberPlan.axis,
      roleShiftsMm: { ...roleShiftsMm },
      source: 'RC_DETAILING_GUIDE_2010_APPENDIX_A2',
    },
  };
}
