/**
 * @fileoverview R13 §6-4 case1「あばら筋を通す」のphase解決済み位置を、
 * 既存R11あばら筋断面RebarPathを再利用してworld RebarPathへ変換する。
 *
 * 新しい断面形状やhook detailは生成せず、member-specific layoutの隣接anchor segmentに
 * 既にRESOLVEDな外周/中子筋pathが存在する場合だけ、その物理形状と交互hook sequenceを
 * 柱内へ同pitchで継続する。
 */

import {
  createArc,
  createLine,
  createRebarPath,
  validateRebarPath,
} from '../../../data/extractors/rebar3d/rebarPath.js';
import { anchorLocalPathToWorldLines } from '../core/RebarPathWorldAdapter.js';

const SOURCE = 'R13-foundation-beam-lowest-column-pass-through-world';
const EPS = 1e-6;

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    productionReady: false,
    worldLoopResolved: false,
    reason,
    blockers: [reason],
    source: SOURCE,
    paths: [],
    ...extra,
  };
}

function ready(paths, extra = {}) {
  return {
    resolved: true,
    productionReady: true,
    worldLoopResolved: true,
    reason: null,
    blockers: [],
    source: SOURCE,
    paths,
    ...extra,
  };
}

function segmentPositionMm(segment, memberLengthMm) {
  if (segment?.exactAxialPosition !== true) return null;
  const ratio = Number(segment?.positionRatio);
  return Number.isFinite(ratio) ? ratio * memberLengthMm : null;
}

function anchorSegment(layout, anchorMm, memberLengthMm) {
  const matches = (layout?.segments || [])
    .map((segment, index) => ({
      segment,
      index,
      positionMm: segmentPositionMm(segment, memberLengthMm),
    }))
    .filter(
      (entry) => Number.isFinite(entry.positionMm) && Math.abs(entry.positionMm - anchorMm) <= EPS,
    );
  return matches.length === 1 ? matches[0] : null;
}

function itemPaths(item) {
  const candidates = Array.isArray(item?.paths) && item.paths.length ? item.paths : [item?.path];
  const paths = candidates.filter((path) => path && validateRebarPath(path).ok);
  return paths.length === candidates.length && paths.length > 0 ? paths : null;
}

function resolvedPhysicalItems(segment) {
  const items = [...(segment?.loops || []), ...(segment?.ties || [])];
  if (!items.length) return null;
  const result = [];
  for (const item of items) {
    if (item?.actualBendRequired !== true || item?.bendStatus !== 'RESOLVED') return null;
    const paths = itemPaths(item);
    if (!paths) return null;
    result.push({ item, paths });
  }
  return result;
}

function shiftedPrimitive(primitive, axialDistanceMm) {
  if (primitive?.type === 'line') {
    return createLine(
      { ...primitive.start, z: Number(primitive.start?.z || 0) + axialDistanceMm },
      { ...primitive.end, z: Number(primitive.end?.z || 0) + axialDistanceMm },
    );
  }
  if (primitive?.type === 'arc') {
    return createArc({
      center: { ...primitive.center, z: Number(primitive.center?.z || 0) + axialDistanceMm },
      radius: primitive.radius,
      planeNormal: primitive.planeNormal,
      startDirection: primitive.startDirection,
      sweepAngleRad: primitive.sweepAngleRad,
    });
  }
  return null;
}

function anchorLocalPath(path, axialDistanceMm, metadata) {
  const primitives = (path?.primitives || []).map((primitive) =>
    shiftedPrimitive(primitive, axialDistanceMm),
  );
  if (primitives.some((primitive) => !primitive)) return null;
  const result = createRebarPath(primitives, {
    ...path.metadata,
    ...metadata,
    coordinateSpace: 'anchor-local',
    sourceCoordinateSpace: path.metadata?.coordinateSpace || 'section-local',
  });
  return validateRebarPath(result).ok ? result : null;
}

function integerPhaseStep(value) {
  const nearest = Math.round(value);
  return Math.abs(value - nearest) <= EPS ? nearest : null;
}

function variantIndex(sequence, count) {
  if (!(count > 0) || !Number.isInteger(sequence)) return null;
  return Math.abs(sequence) % count;
}

/**
 * @param {Object} params
 * @param {Object} params.interactionFact §6-4 case1 fact
 * @param {Object} params.phasePlacement pass-through placement resolver result
 * @param {Object} params.memberStirrupLayout R11 decorated member-specific layout
 * @param {Object} params.placement calculateBeamPlacement互換placement
 */
export function resolveFoundationBeamLowestColumnPassThroughWorldPaths2023({
  interactionFact,
  phasePlacement,
  memberStirrupLayout,
  placement,
  memberId = null,
  memberTag = 'StbGirder',
  tessellation = undefined,
} = {}) {
  if (interactionFact?.status !== 'READY' || interactionFact?.passThroughRequired !== true) {
    return unresolved('foundation-lowest-column-pass-through-interaction-not-ready');
  }
  if (phasePlacement?.status !== 'READY' || phasePlacement?.passThroughPhaseResolved !== true) {
    return unresolved(
      phasePlacement?.reason || 'foundation-lowest-column-pass-through-phase-unresolved',
    );
  }
  const memberLengthMm = Number(phasePlacement.memberLengthMm);
  const anchorMm = Number(phasePlacement.adjacentAnchorMm);
  const pitchMm = Number(phasePlacement.pitchMm);
  if (!(memberLengthMm > 0) || !Number.isFinite(anchorMm) || !(pitchMm > 0)) {
    return unresolved('foundation-lowest-column-pass-through-phase-values-invalid');
  }
  if (!(placement?.length > 0) || Math.abs(Number(placement.length) - memberLengthMm) > EPS) {
    return unresolved('foundation-lowest-column-pass-through-placement-length-inconsistent');
  }
  const anchor = anchorSegment(memberStirrupLayout, anchorMm, memberLengthMm);
  if (!anchor) {
    return unresolved('foundation-lowest-column-pass-through-anchor-segment-unresolved');
  }
  if (
    !(memberStirrupLayout?.segments || []).every((segment) => segment?.exactAxialPosition === true)
  ) {
    return unresolved('foundation-lowest-column-pass-through-layout-sequence-unresolved');
  }
  const items = resolvedPhysicalItems(anchor.segment);
  if (!items) {
    return unresolved('foundation-lowest-column-pass-through-r11-path-unresolved');
  }

  const side = interactionFact.side;
  const worldPaths = [];
  for (const positionMm of phasePlacement.positionsMm || []) {
    const step = integerPhaseStep((Number(positionMm) - anchorMm) / pitchMm);
    if (step === null) {
      return unresolved('foundation-lowest-column-pass-through-position-off-phase');
    }
    const sequence = anchor.index + step;
    const distanceFromAnchor =
      side === 'end' ? memberLengthMm - Number(positionMm) : Number(positionMm);
    for (const { item, paths } of items) {
      const selected = paths[variantIndex(sequence, paths.length)];
      const local = anchorLocalPath(selected, distanceFromAnchor, {
        memberId,
        memberTag,
        anchor: side,
        endpoint: side,
        role: item.role || selected.metadata?.role || 'beam-stirrup',
        source: SOURCE,
        ruleId: '6-4',
        foundationPassThrough: true,
        axialPositionMm: Number(positionMm),
        sequence,
      });
      if (!local) {
        return unresolved('foundation-lowest-column-pass-through-anchor-local-path-invalid');
      }
      const world = anchorLocalPathToWorldLines(local, placement, {
        anchor: side,
        memberId,
        memberTag,
        tessellation,
      });
      if (!world) {
        return unresolved('foundation-lowest-column-pass-through-world-transform-failed');
      }
      worldPaths.push(world);
    }
  }
  if (!worldPaths.length) {
    return unresolved('foundation-lowest-column-pass-through-world-path-empty');
  }

  return ready(worldPaths, {
    side,
    memberId,
    generatedPositionCount: (phasePlacement.positionsMm || []).length,
    physicalItemCount: items.length,
    phaseBasis: phasePlacement.phaseBasis,
  });
}

export const _foundationBeamLowestColumnPassThroughWorldInternals = Object.freeze({
  segmentPositionMm,
  anchorSegment,
  itemPaths,
  resolvedPhysicalItems,
  shiftedPrimitive,
  anchorLocalPath,
  integerPhaseStep,
  variantIndex,
});
