/**
 * @fileoverview R5 RC梁主筋 identity / RebarPath を既存RebarGeneratorへ適合するadapter。
 *
 * 通し主筋はRebarPathを材軸方向のpieceへ変換し、既存のInstancedMesh生成経路へ渡す。
 * R8のハンチtransitionはmember-local RebarPathを表示境界でchord化してworldへ変換し、
 * 同じ円柱描画基盤へ渡す。腹筋は従来segment rendererを維持する。
 * R12-Wでは一般小梁のCENTERLINE_READYなVERTICAL_90 production pathだけを
 * anchor-localからworldへ変換し、member主筋とのworld連続性を再確認して描画する。
 * role metadataが無いlegacy layoutは全体を従来経路へ戻す。
 *
 * @module viewer/geometry/generators/BeamIdentityRebarGenerator
 */

import * as THREE from 'three';
import { getState } from '../../../data/state/globalState.js';
import { calculateBeamPlacement } from '../core/GeometryCalculator.js';
import { anchorLocalPathToWorldLines } from '../core/RebarPathWorldAdapter.js';
import {
  createLine,
  createRebarPath,
  getPathEnd,
  getPathStart,
  rebarPathToLineSegments,
  validateRebarPath,
} from '../../../data/extractors/rebar3d/rebarPath.js';
import {
  buildSmallBeamVertical90RenderPlan,
  isSmallBeamElementBatch,
} from '../../../data/extractors/rebar3d/smallBeamVerticalAnchorageRenderPlan.js';
import { buildSmallBeamBottomL3RenderPlan } from '../../../data/extractors/rebar3d/smallBeamBottomAnchorageRenderPlan.js';
import { buildSmallBeamBottomL3hRenderPlan } from '../../../data/extractors/rebar3d/smallBeamBottomL3hRenderPlan.js';
import { buildSmallBeamCutoffFacts } from '../../../data/extractors/rebar3d/smallBeamCutoffFacts.js';
import { buildSmallBeamCutoffMemberMutation } from '../../../data/extractors/rebar3d/smallBeamCutoffProduction.js';
import { axialPiece } from '../../../data/extractors/rebar3d/rebarPieces.js';
import { applyAppendixA2VerticalPlacementToLayout } from '../../../data/extractors/rebar3d/rebarAppendixA2BeamVerticalPlacement.js';
import {
  applyRebarPlacementConflictPlanToLayout,
  rebarPlacementConflictEndpointInsets,
  rebarPlacementConflictMemberKey,
} from '../../../data/extractors/rebar3d/rebarPlacementConflictProduction.js';
import { buildAppendixA2UShapeAnchorPaths } from '../../../data/extractors/rebar3d/rebarAppendixA2UShapeProduction.js';
import { createColumnJointRebarMeshes } from './ColumnJointRebarGenerator.js';
import {
  buildSmallBeamBottomL3hMemberMutation,
  resolveSmallBeamBottomL3hWorldPaths,
} from './SmallBeamBottomL3hWorldResolver.js';
import {
  createBeamRebarMeshes as createLegacyBeamRebarMeshes,
  createRebarPieceMeshes,
} from './RebarGenerator.js';

const R12_WORLD_TOLERANCE_MM = 1e-5;

function beamPlacement(beam, nodes, layout) {
  const start = nodes?.get(String(beam.id_node_start));
  const end = nodes?.get(String(beam.id_node_end));
  if (!start || !end) return null;
  const placement = calculateBeamPlacement(
    { x: start.x, y: start.y, z: start.z },
    { x: end.x, y: end.y, z: end.z },
    {
      startOffset: {
        x: Number(beam.offset_start_X || 0),
        y: Number(beam.offset_start_Y || 0),
        z: Number(beam.offset_start_Z || 0),
      },
      endOffset: {
        x: Number(beam.offset_end_X || 0),
        y: Number(beam.offset_end_Y || 0),
        z: Number(beam.offset_end_Z || 0),
      },
      placementMode: 'top-aligned',
      sectionHeight: layout.depth || 0,
    },
  );
  const rollAngleDegrees = Number(beam.rotate ?? beam.angle ?? 0) || 0;
  return { ...placement, localRollRad: (rollAngleDegrees * Math.PI) / 180 };
}

function beamPlanLength(placement) {
  const start = placement?.adjustedStart;
  const end = placement?.adjustedEnd;
  if (!start || !end) return null;
  const dx = Number(end.x) - Number(start.x);
  const dy = Number(end.y) - Number(start.y);
  const length = Math.hypot(dx, dy);
  return length > 0 ? length : null;
}

function pathToAxialPieces(path, memberLengthMm) {
  if (path?.metadata?.source === 'issue317-a2-side-endpoint-inset') return [];
  const dia = Number(path?.metadata?.dia);
  if (!(dia > 0)) return [];
  const pieces = [];
  for (const line of rebarPathToLineSegments(path)) {
    const sameSectionPosition =
      Math.abs(Number(line.start.x) - Number(line.end.x)) <= 1e-9 &&
      Math.abs(Number(line.start.y) - Number(line.end.y)) <= 1e-9;
    if (!sameSectionPosition) continue;
    pieces.push(
      axialPiece({
        anchor: 'start',
        from: Number(line.start.z) + memberLengthMm / 2,
        to: Number(line.end.z) + memberLengthMm / 2,
        u: Number(line.start.x),
        v: Number(line.start.y),
        dia,
      }),
    );
  }
  return pieces.filter(Boolean);
}

function memberLocalPointToWorld(point, placement) {
  const roll = Number(placement?.localRollRad) || 0;
  const cos = Math.cos(roll);
  const sin = Math.sin(roll);
  const u = roll === 0 ? Number(point.x) : Number(point.x) * cos - Number(point.y) * sin;
  const v = roll === 0 ? Number(point.y) : Number(point.x) * sin + Number(point.y) * cos;
  const vector = new THREE.Vector3(u, v, Number(point.z));
  vector.applyQuaternion(
    new THREE.Quaternion(
      placement.rotation.x,
      placement.rotation.y,
      placement.rotation.z,
      placement.rotation.w,
    ),
  );
  vector.add(new THREE.Vector3(placement.center.x, placement.center.y, placement.center.z));
  return { x: vector.x, y: vector.y, z: vector.z };
}

function memberLocalPathToWorld(path, placement, memberId) {
  if (path?.metadata?.coordinateSpace !== 'member-local') return null;
  const localLines = rebarPathToLineSegments(path);
  if (!localLines.length) return null;
  const primitives = localLines.map((line) =>
    createLine(
      memberLocalPointToWorld(line.start, placement),
      memberLocalPointToWorld(line.end, placement),
    ),
  );
  if (!primitives.length) return null;
  return createRebarPath(primitives, {
    ...path.metadata,
    memberId: memberId || path.metadata.memberId || null,
    coordinateSpace: 'world',
    sourceCoordinateSpace: 'member-local',
    displayGeometry: 'arc-chords',
  });
}

function isHaunchTransitionPath(path) {
  return path?.metadata?.source === 'girder-r8-haunch' && path?.metadata?.haunchTransition === true;
}

function isPlacementConflictEndpointInsetPath(path) {
  return (
    path?.metadata?.source === 'issue317-a2-side-endpoint-inset' &&
    path?.metadata?.placementConflictEndpointInset === true
  );
}

function webOnlyLayoutMap(layoutMap) {
  const result = new Map();
  for (const [sectionId, layout] of layoutMap) {
    const segments = (layout.segments || []).map((segment) => ({
      ...segment,
      bars: (segment.bars || []).filter((bar) => bar?.role === 'web'),
    }));
    if (segments.some((segment) => segment.bars.length > 0)) {
      result.set(sectionId, { ...layout, segments });
    }
  }
  return result;
}

function closeEnough(left, right, tolerance = R12_WORLD_TOLERANCE_MM) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function samePoint(left, right, tolerance = R12_WORLD_TOLERANCE_MM) {
  return (
    closeEnough(left?.x, right?.x, tolerance) &&
    closeEnough(left?.y, right?.y, tolerance) &&
    closeEnough(left?.z, right?.z, tolerance)
  );
}

function anchorPathLeavesMember(path) {
  if (!path || !validateRebarPath(path).ok) return false;
  const lines = rebarPathToLineSegments(path);
  if (!lines.length) return false;
  let hasOutsidePoint = false;
  for (const line of lines) {
    for (const point of [line.start, line.end]) {
      const z = Number(point?.z);
      if (!Number.isFinite(z) || z > R12_WORLD_TOLERANCE_MM) return false;
      if (z < -R12_WORLD_TOLERANCE_MM) hasOutsidePoint = true;
    }
  }
  return hasOutsidePoint;
}

function matchingMemberPaths(paths, entry, memberLengthMm) {
  const localStart = getPathStart(entry.productionPath);
  const side = entry.side;
  const endpointZ = side === 'start' ? -memberLengthMm / 2 : memberLengthMm / 2;
  return (paths || []).filter((path) => {
    if (
      path?.metadata?.coordinateSpace !== 'member-local' ||
      path.metadata.identityKey !== entry.identityKey ||
      path.metadata.role !== entry.role ||
      !validateRebarPath(path).ok
    ) {
      return false;
    }
    const endpoint = side === 'start' ? getPathStart(path) : getPathEnd(path);
    return (
      closeEnough(endpoint?.x, localStart?.x) &&
      closeEnough(endpoint?.y, localStart?.y) &&
      closeEnough(endpoint?.z, endpointZ)
    );
  });
}

function resolveSmallBeamAnchorageWorldPaths({
  memberPlan,
  memberPaths,
  placement,
  memberLengthMm,
  memberId,
  sectionId = null,
  contract,
} = {}) {
  const paths = [];
  const unresolved = [];
  const prefix = contract?.reasonPrefix || 'small-beam-anchorage';
  if (!memberPlan?.entries?.length) return { paths, unresolved };
  if (!(Number(memberLengthMm) > 0) || !placement) {
    return { paths, unresolved: [{ reason: `${prefix}-render-placement-unresolved` }] };
  }
  if (
    memberPlan.sectionId !== null &&
    memberPlan.sectionId !== undefined &&
    String(memberPlan.sectionId) !== String(sectionId)
  ) {
    return { paths, unresolved: [{ reason: `${prefix}-render-section-mismatch` }] };
  }

  for (const entry of memberPlan.entries) {
    const path = entry?.productionPath;
    const ready =
      entry?.role === contract.role &&
      entry?.generationStatus === 'CENTERLINE_READY' &&
      entry.productionPathCandidate === true &&
      entry.productionConsumer === 'beam-anchor-local-path' &&
      path?.metadata?.coordinateSpace === 'anchor-local' &&
      path?.metadata?.role === contract.role &&
      path?.metadata?.bendGeometry === contract.bendGeometry &&
      path?.metadata?.anchorageMode === contract.anchorageMode;
    if (!ready) {
      unresolved.push({ reason: `${prefix}-render-gate-not-ready`, entry });
      continue;
    }
    if (!['start', 'end'].includes(entry.side) || !entry.identityKey) {
      unresolved.push({ reason: `${prefix}-render-identity-unresolved`, entry });
      continue;
    }
    if (
      path.metadata?.identityKey !== entry.identityKey ||
      String(path.metadata?.memberId || '') !== String(memberId || '')
    ) {
      unresolved.push({ reason: `${prefix}-render-path-identity-mismatch`, entry });
      continue;
    }
    if (!anchorPathLeavesMember(path)) {
      unresolved.push({ reason: `${prefix}-render-path-overlaps-member`, entry });
      continue;
    }

    const candidates = matchingMemberPaths(memberPaths, entry, Number(memberLengthMm));
    if (candidates.length !== 1) {
      unresolved.push({
        reason:
          candidates.length === 0
            ? `${prefix}-render-main-path-unresolved`
            : `${prefix}-render-main-path-ambiguous`,
        entry,
        candidateCount: candidates.length,
      });
      continue;
    }

    const memberPath = candidates[0];
    const memberWorld = memberLocalPathToWorld(memberPath, placement, memberId);
    const anchorWorld = anchorLocalPathToWorldLines(path, placement, {
      anchor: entry.side,
      memberId,
      memberTag: 'StbBeam',
    });
    if (
      !memberWorld ||
      !anchorWorld ||
      !validateRebarPath(memberWorld).ok ||
      !validateRebarPath(anchorWorld).ok
    ) {
      unresolved.push({ reason: `${prefix}-render-world-path-invalid`, entry });
      continue;
    }

    const memberEndpoint =
      entry.side === 'start' ? getPathStart(memberWorld) : getPathEnd(memberWorld);
    const anchorageStart = getPathStart(anchorWorld);
    if (!samePoint(memberEndpoint, anchorageStart)) {
      unresolved.push({
        reason: `${prefix}-render-world-continuity-mismatch`,
        entry,
        memberEndpoint,
        anchorageStart,
      });
      continue;
    }

    const worldPath = createRebarPath(anchorWorld.primitives, {
      ...anchorWorld.metadata,
      source: contract.worldSource,
      ruleId: contract.ruleId,
      renderReady: true,
      generationStatus: 'CENTERLINE_READY',
      productionPathCandidate: true,
      productionConsumer: 'explicit-world-path',
      memberId: String(memberId),
      memberTag: 'StbBeam',
      endpoint: entry.side,
      identityKey: entry.identityKey,
    });
    if (!validateRebarPath(worldPath).ok) {
      unresolved.push({ reason: `${prefix}-render-world-path-invalid`, entry });
      continue;
    }
    paths.push(worldPath);
  }

  return { paths, unresolved };
}

function normalizedGradeKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function normalizedLayerKey(value) {
  return value === null || value === undefined || value === '' ? '' : String(value);
}

function translateAnchorLocalPathY(path, deltaY) {
  const dy = Number(deltaY);
  if (!Number.isFinite(dy) || Math.abs(dy) <= R12_WORLD_TOLERANCE_MM) return path;
  const primitives = (path?.primitives || []).map((primitive) => {
    if (primitive?.type === 'line') {
      return createLine(
        { ...primitive.start, y: Number(primitive.start.y) + dy },
        { ...primitive.end, y: Number(primitive.end.y) + dy },
      );
    }
    if (primitive?.type === 'arc') {
      return {
        ...primitive,
        center: { ...primitive.center, y: Number(primitive.center.y) + dy },
      };
    }
    return primitive;
  });
  const translated = createRebarPath(primitives, {
    ...path.metadata,
    verticalPlacementAppliedMm: dy,
  });
  return validateRebarPath(translated).ok ? translated : null;
}

function appendixA2CornerMemberCandidates(memberPaths, anchorPath, side, memberLengthMm) {
  const localStart = getPathStart(anchorPath);
  const endpointZ = side === 'start' ? -memberLengthMm / 2 : memberLengthMm / 2;
  return (memberPaths || []).filter((path) => {
    if (
      path?.metadata?.coordinateSpace !== 'member-local' ||
      !path.metadata.identityKey ||
      path.metadata.role !== anchorPath?.metadata?.role ||
      normalizedLayerKey(path.metadata.layer) !== normalizedLayerKey(anchorPath?.metadata?.layer) ||
      !closeEnough(path.metadata.dia, anchorPath?.metadata?.dia) ||
      normalizedGradeKey(path.metadata.grade) !== normalizedGradeKey(anchorPath?.metadata?.grade) ||
      !validateRebarPath(path).ok
    ) {
      return false;
    }
    const endpoint = side === 'start' ? getPathStart(path) : getPathEnd(path);
    return closeEnough(endpoint?.x, localStart?.x) && closeEnough(endpoint?.z, endpointZ);
  });
}

function appendixA2EndpointConflicted(side, endpointTrims = [], haunchTransitions = []) {
  return (
    (endpointTrims || []).some((spec) => spec?.endpoint === side) ||
    (haunchTransitions || []).some((spec) => spec?.side === side)
  );
}

/**
 * A2抱え込み定着のanchor-local actual pathをmember identityへ接続してworld化する。
 * A2 vertical placementでmember pathのvが移動している場合は、そのidentity endpointへ
 * path全体を平行移動してからcontinuityを再検証する。R7/R8が同じ端部を変更する場合は
 * 二重適用せずfail-closedとする。
 */
export function resolveAppendixA2CornerAnchorageWorldPaths({
  anchorage,
  memberPaths,
  placement,
  memberLengthMm,
  memberId,
  memberTag = 'StbGirder',
  endpointTrims = [],
  haunchTransitions = [],
  verticalPlacementPlan = null,
} = {}) {
  const paths = [];
  const unresolved = [];
  const candidates = anchorage?.appendixA2CornerAnchoragePaths || [];
  if (!candidates.length) return { paths, unresolved };
  if (!placement || !(Number(memberLengthMm) > 0)) {
    return {
      paths,
      unresolved: [{ reason: 'appendix-a2-corner-render-placement-unresolved' }],
    };
  }

  for (const sourcePath of candidates) {
    const side = sourcePath?.metadata?.anchor;
    if (
      !['start', 'end'].includes(side) ||
      sourcePath?.metadata?.coordinateSpace !== 'anchor-local' ||
      sourcePath.metadata.productionConsumer !== 'appendix-a2-corner-anchor-local-path' ||
      sourcePath.metadata.generationStatus !== 'CENTERLINE_READY' ||
      !validateRebarPath(sourcePath).ok
    ) {
      unresolved.push({
        reason: 'appendix-a2-corner-render-path-gate-not-ready',
        path: sourcePath,
      });
      continue;
    }
    if (appendixA2EndpointConflicted(side, endpointTrims, haunchTransitions)) {
      unresolved.push({
        reason: 'appendix-a2-corner-render-endpoint-mutation-conflict',
        side,
      });
      continue;
    }

    const matches = appendixA2CornerMemberCandidates(
      memberPaths,
      sourcePath,
      side,
      Number(memberLengthMm),
    );
    if (matches.length !== 1) {
      unresolved.push({
        reason:
          matches.length === 0
            ? 'appendix-a2-corner-render-main-path-unresolved'
            : 'appendix-a2-corner-render-main-path-ambiguous',
        side,
        candidateCount: matches.length,
        path: sourcePath,
      });
      continue;
    }

    const memberPath = matches[0];
    const memberEndpoint = side === 'start' ? getPathStart(memberPath) : getPathEnd(memberPath);
    const anchorStart = getPathStart(sourcePath);
    const deltaV = Number(memberEndpoint?.y) - Number(anchorStart?.y);
    const role = String(sourcePath?.metadata?.role || '').toLowerCase();
    const configuredShift =
      verticalPlacementPlan?.status === 'READY'
        ? Number(verticalPlacementPlan?.roleShiftsMm?.[role]) || 0
        : 0;
    const expectedDeltaV =
      role === 'top' ? -configuredShift : role === 'bottom' ? configuredShift : 0;
    if (!closeEnough(deltaV, expectedDeltaV)) {
      unresolved.push({
        reason: 'appendix-a2-corner-render-unexpected-vertical-offset',
        side,
        role,
        actualDeltaV: deltaV,
        expectedDeltaV,
      });
      continue;
    }
    const adjustedAnchorPath = translateAnchorLocalPathY(sourcePath, deltaV);
    if (!adjustedAnchorPath) {
      unresolved.push({ reason: 'appendix-a2-corner-render-vertical-shift-invalid', side });
      continue;
    }

    const memberWorld = memberLocalPathToWorld(memberPath, placement, memberId);
    const anchorWorld = anchorLocalPathToWorldLines(adjustedAnchorPath, placement, {
      anchor: side,
      memberId,
      memberTag,
    });
    if (
      !memberWorld ||
      !anchorWorld ||
      !validateRebarPath(memberWorld).ok ||
      !validateRebarPath(anchorWorld).ok
    ) {
      unresolved.push({ reason: 'appendix-a2-corner-render-world-path-invalid', side });
      continue;
    }

    const worldMemberEndpoint =
      side === 'start' ? getPathStart(memberWorld) : getPathEnd(memberWorld);
    const worldAnchorStart = getPathStart(anchorWorld);
    if (!samePoint(worldMemberEndpoint, worldAnchorStart)) {
      unresolved.push({
        reason: 'appendix-a2-corner-render-world-continuity-mismatch',
        side,
        memberEndpoint: worldMemberEndpoint,
        anchorageStart: worldAnchorStart,
      });
      continue;
    }

    const worldPath = createRebarPath(anchorWorld.primitives, {
      ...anchorWorld.metadata,
      memberId: String(memberId),
      memberTag,
      endpoint: side,
      identityKey: memberPath.metadata.identityKey,
      identityStatus: memberPath.metadata.identityStatus || 'resolved',
      source: 'appendix-a2-corner-anchorage-world',
      ruleId: 'APPENDIX-A2-CORNER-JOINT-ANCHORAGE-METHOD',
      renderReady: true,
      generationStatus: 'CENTERLINE_READY',
      productionPathCandidate: true,
      productionConsumer: 'explicit-world-path',
    });
    if (!validateRebarPath(worldPath).ok) {
      unresolved.push({ reason: 'appendix-a2-corner-render-world-path-invalid', side });
      continue;
    }
    paths.push(worldPath);
  }

  return { paths, unresolved };
}

function findMemberIdentityEndpointPath(memberPaths, identityKey, role, side, memberLengthMm) {
  const endpointZ = side === 'start' ? -memberLengthMm / 2 : memberLengthMm / 2;
  const candidates = (memberPaths || []).filter((path) => {
    if (
      path?.metadata?.coordinateSpace !== 'member-local' ||
      path.metadata.identityKey !== identityKey ||
      path.metadata.role !== role ||
      !validateRebarPath(path).ok
    ) {
      return false;
    }
    const endpoint = side === 'start' ? getPathStart(path) : getPathEnd(path);
    return closeEnough(endpoint?.z, endpointZ);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * A2 U字形定着は sourceからpairingを推定せず、projectDetailingのEXPLICIT assignment
 * があるendだけをworld pathへ昇格する。
 */
export function resolveAppendixA2UShapeWorldPaths({
  anchorage,
  memberPaths,
  placement,
  memberLengthMm,
  memberId,
  memberTag = 'StbGirder',
  endpointTrims = [],
  haunchTransitions = [],
  projectDetailing,
} = {}) {
  const paths = [];
  const unresolved = [];
  if (!anchorage?.ends?.length || !placement || !(Number(memberLengthMm) > 0)) {
    return { paths, unresolved };
  }

  for (const end of anchorage.ends) {
    const gate = end?.appendixA2CornerAnchorageGate;
    if (gate?.method !== 'U_SHAPE_ANCHORAGE') continue;
    const side = end.side;
    if (appendixA2EndpointConflicted(side, endpointTrims, haunchTransitions)) {
      unresolved.push({
        reason: 'appendix-a2-u-shape-render-endpoint-mutation-conflict',
        side,
      });
      continue;
    }

    const built = buildAppendixA2UShapeAnchorPaths({
      memberId,
      endpoint: side,
      memberPaths,
      memberLengthMm,
      projectDetailing,
    });
    if (!built.resolved) {
      unresolved.push({
        reason: built.reason || 'appendix-a2-u-shape-render-pairing-unresolved',
        side,
        detail: built,
      });
      continue;
    }

    for (const anchorPath of built.paths) {
      const topPath = findMemberIdentityEndpointPath(
        memberPaths,
        anchorPath.metadata?.topIdentityKey,
        'top',
        side,
        Number(memberLengthMm),
      );
      const bottomPath = findMemberIdentityEndpointPath(
        memberPaths,
        anchorPath.metadata?.bottomIdentityKey,
        'bottom',
        side,
        Number(memberLengthMm),
      );
      if (!topPath || !bottomPath) {
        unresolved.push({
          reason: 'appendix-a2-u-shape-render-member-identity-unresolved',
          side,
          topIdentityKey: anchorPath.metadata?.topIdentityKey || null,
          bottomIdentityKey: anchorPath.metadata?.bottomIdentityKey || null,
        });
        continue;
      }

      const world = anchorLocalPathToWorldLines(anchorPath, placement, {
        anchor: side,
        memberId,
        memberTag,
      });
      const topWorld = memberLocalPathToWorld(topPath, placement, memberId);
      const bottomWorld = memberLocalPathToWorld(bottomPath, placement, memberId);
      if (!world || !topWorld || !bottomWorld) {
        unresolved.push({ reason: 'appendix-a2-u-shape-render-world-path-invalid', side });
        continue;
      }

      const topEndpoint = side === 'start' ? getPathStart(topWorld) : getPathEnd(topWorld);
      const bottomEndpoint = side === 'start' ? getPathStart(bottomWorld) : getPathEnd(bottomWorld);
      if (
        !samePoint(getPathStart(world), topEndpoint) ||
        !samePoint(getPathEnd(world), bottomEndpoint)
      ) {
        unresolved.push({
          reason: 'appendix-a2-u-shape-render-world-continuity-mismatch',
          side,
          topEndpoint,
          bottomEndpoint,
          uShapeStart: getPathStart(world),
          uShapeEnd: getPathEnd(world),
        });
        continue;
      }

      const worldPath = createRebarPath(world.primitives, {
        ...world.metadata,
        memberId: String(memberId),
        memberTag,
        endpoint: side,
        source: 'appendix-a2-u-shape-world',
        ruleId: 'APPENDIX-A2-CORNER-JOINT-ANCHORAGE-METHOD',
        renderReady: true,
        generationStatus: 'CENTERLINE_READY',
        productionPathCandidate: true,
        productionConsumer: 'explicit-world-path',
      });
      if (!validateRebarPath(worldPath).ok) {
        unresolved.push({ reason: 'appendix-a2-u-shape-render-world-path-invalid', side });
        continue;
      }
      paths.push(worldPath);
    }
  }

  return { paths, unresolved };
}

/** R12-W 上端90°定着をworld中心線へ変換する。 */
export function resolveSmallBeamVertical90WorldPaths(params = {}) {
  return resolveSmallBeamAnchorageWorldPaths({
    ...params,
    contract: {
      reasonPrefix: 'small-beam-vertical-90',
      role: 'top',
      bendGeometry: 'actual-arc',
      anchorageMode: 'VERTICAL_90',
      worldSource: 'small-beam-r12-vertical-90-world',
      ruleId: 'R12-W',
    },
  });
}

/** R12-X 下端L3直線定着をworld中心線へ変換する。 */
export function resolveSmallBeamBottomL3WorldPaths(params = {}) {
  return resolveSmallBeamAnchorageWorldPaths({
    ...params,
    contract: {
      reasonPrefix: 'small-beam-bottom-L3',
      role: 'bottom',
      bendGeometry: 'straight',
      anchorageMode: 'STRAIGHT_L3',
      worldSource: 'small-beam-r12-bottom-L3-world',
      ruleId: 'R12-X',
    },
  });
}

function resolveModelDocument(options) {
  if (options?.xmlDoc) return options.xmlDoc;
  if (options?.modelSource === 'A') return getState('models.documentA');
  if (options?.modelSource === 'B') return getState('models.documentB');
  return null;
}

function resolveSmallBeamRenderPlan(beamElements, layoutMap, options) {
  if (options?.smallBeamVertical90RenderPlan) return options.smallBeamVertical90RenderPlan;
  const xmlDoc = resolveModelDocument(options);
  if (!xmlDoc || !isSmallBeamElementBatch(xmlDoc, beamElements, options?.scanTag)) return null;
  try {
    return buildSmallBeamVertical90RenderPlan(xmlDoc, layoutMap, options, options?.scanTag);
  } catch (_error) {
    // R12-Wは既存主筋表示を壊さないことを優先し、production plan失敗時は定着だけ生成しない。
    return null;
  }
}

function resolveSmallBeamBottomRenderPlan(beamElements, layoutMap, options) {
  if (options?.smallBeamBottomL3RenderPlan) return options.smallBeamBottomL3RenderPlan;
  const xmlDoc = resolveModelDocument(options);
  if (!xmlDoc || !isSmallBeamElementBatch(xmlDoc, beamElements, options?.scanTag)) return null;
  try {
    return buildSmallBeamBottomL3RenderPlan(xmlDoc, layoutMap, options, options?.scanTag);
  } catch (_error) {
    // R12-Xも既存主筋表示を壊さず、下端L3 plan失敗時は追加定着だけ生成しない。
    return null;
  }
}

function resolveSmallBeamBottomL3hPlan(beamElements, layoutMap, options) {
  if (options?.smallBeamBottomL3hRenderPlan) return options.smallBeamBottomL3hRenderPlan;
  const xmlDoc = resolveModelDocument(options);
  if (!xmlDoc || !isSmallBeamElementBatch(xmlDoc, beamElements, options?.scanTag)) return null;
  try {
    return buildSmallBeamBottomL3hRenderPlan(xmlDoc, layoutMap, options, options?.scanTag);
  } catch (_error) {
    // R12-Yも既存主筋表示を壊さず、plan失敗時はmain-bar trimとhookをどちらも適用しない。
    return null;
  }
}

function resolveSmallBeamCutoffFactSet(beamElements, layoutMap, options) {
  if (options?.smallBeamCutoffFacts) return options.smallBeamCutoffFacts;
  const xmlDoc = resolveModelDocument(options);
  if (!xmlDoc || !isSmallBeamElementBatch(xmlDoc, beamElements, options?.scanTag)) return null;
  try {
    return buildSmallBeamCutoffFacts(xmlDoc, layoutMap, options, options?.scanTag);
  } catch (_error) {
    // R12-Zはcutoff fact解決に失敗しても既存member pathを維持する。
    return null;
  }
}

/**
 * RC梁主筋をidentity/RebarPath経路で生成する。
 * public signatureは従来 createBeamRebarMeshes と同一。
 */
export function createBeamRebarMeshes(beamElements, nodes, layoutMap, options = {}) {
  if (!beamElements?.length || !nodes?.size || !layoutMap?.size) return [];

  const smallBeamVertical90RenderPlan = resolveSmallBeamRenderPlan(
    beamElements,
    layoutMap,
    options,
  );
  const smallBeamBottomL3RenderPlan = resolveSmallBeamBottomRenderPlan(
    beamElements,
    layoutMap,
    options,
  );
  const smallBeamBottomL3hRenderPlan = resolveSmallBeamBottomL3hPlan(
    beamElements,
    layoutMap,
    options,
  );
  const smallBeamCutoffFacts = resolveSmallBeamCutoffFactSet(beamElements, layoutMap, options);
  const pieceMap = new Map();
  const semanticElements = [];
  const legacyElements = [];
  const haunchWorldPaths = [];
  const smallBeamAnchorageWorldPaths = [];
  const smallBeamBottomAnchorageWorldPaths = [];
  const smallBeamBottomL3hWorldPaths = [];
  const appendixA2CornerAnchorageWorldPaths = [];
  const appendixA2UShapeWorldPaths = [];
  const placementConflictEndpointInsetWorldPaths = [];
  for (const beam of beamElements) {
    const baseLayout = layoutMap.get(String(beam.id_section));
    if (!baseLayout) continue;
    const memberId = String(beam.id);
    const endpointTrims = options.jointTransitionPlan?.memberEndTrims?.get(memberId) || [];
    const haunchTransitions = options.haunchTransitionPlan?.memberTransitions?.get(memberId) || [];
    const appendixA2MemberPlan =
      options.appendixA2VerticalPlacementPlan?.members?.get?.(memberId) || null;
    const appendixA2PathConflict =
      appendixA2MemberPlan?.status === 'READY' &&
      (endpointTrims.length > 0 || haunchTransitions.length > 0);
    const verticallyAdjustedLayout =
      appendixA2MemberPlan?.status === 'READY' && !appendixA2PathConflict
        ? applyAppendixA2VerticalPlacementToLayout(baseLayout, appendixA2MemberPlan)
        : baseLayout;
    const placementConflictKey = rebarPlacementConflictMemberKey(
      options.appendixA2MemberTag || 'StbGirder',
      memberId,
    );
    const placementConflictMemberPlan =
      (placementConflictKey &&
        options.rebarPlacementConflictPlan?.members?.get?.(placementConflictKey)) ||
      null;
    const placementConflictPathConflict =
      placementConflictMemberPlan?.status === 'READY' &&
      (endpointTrims.length > 0 || haunchTransitions.length > 0);
    const placementConflictEndpointInsets =
      rebarPlacementConflictEndpointInsets(placementConflictMemberPlan);
    const layout =
      placementConflictMemberPlan?.status === 'READY' && !placementConflictPathConflict
        ? applyRebarPlacementConflictPlanToLayout(
            verticallyAdjustedLayout,
            placementConflictMemberPlan,
          )
        : verticallyAdjustedLayout;
    const placement = beamPlacement(beam, nodes, layout);
    if (!placement || !(placement.length > 0)) continue;
    const bottomL3hMemberPlan = smallBeamBottomL3hRenderPlan?.members?.get?.(memberId) || null;
    const bottomL3hMutation = buildSmallBeamBottomL3hMemberMutation({
      layout,
      memberLengthMm: placement.length,
      memberId,
      memberPlan: bottomL3hMemberPlan,
      placement,
      sectionId: beam.id_section,
      existingEndpointTrims: endpointTrims,
      haunchTransitions,
      endpointInsets: placementConflictEndpointInsets,
    });
    const preCutoffBuilt = bottomL3hMutation.built;
    const cutoffSpanFact = smallBeamCutoffFacts?.beam?.get?.(memberId) || null;
    const cutoffMutation = buildSmallBeamCutoffMemberMutation({
      spanFact: cutoffSpanFact,
      built: preCutoffBuilt,
      memberLengthMm: placement.length,
      memberPlanLengthMm: beamPlanLength(placement),
      memberId,
    });
    let built = cutoffMutation.built;
    let bottomL3hPaths = bottomL3hMutation.paths;

    // R12-ZはR12-Y trim後pathへ適用する。cutoff後に同一identityのhook continuityを
    // 再検証し、破壊した場合はcutoffだけをmember単位でrollbackする。
    if (bottomL3hMutation.applied && cutoffMutation.applied) {
      const revalidated = resolveSmallBeamBottomL3hWorldPaths({
        memberPlan: bottomL3hMemberPlan,
        memberPaths: built.paths,
        placement,
        memberLengthMm: placement.length,
        memberId,
        sectionId: beam.id_section,
      });
      if (
        revalidated.unresolved.length === 0 &&
        revalidated.paths.length === bottomL3hMutation.paths.length
      ) {
        bottomL3hPaths = revalidated.paths;
      } else {
        built = preCutoffBuilt;
      }
    }
    smallBeamBottomL3hWorldPaths.push(...bottomL3hPaths);

    for (const path of built.paths.filter(isPlacementConflictEndpointInsetPath)) {
      const world = memberLocalPathToWorld(path, placement, memberId);
      if (world && validateRebarPath(world).ok) {
        placementConflictEndpointInsetWorldPaths.push(world);
      }
    }

    if (built.semanticMainBarCount === 0) {
      legacyElements.push(beam);
      continue;
    }

    semanticElements.push(beam);
    const pieces = built.paths.flatMap((path) => pathToAxialPieces(path, placement.length));
    if (pieces.length > 0) pieceMap.set(memberId, { elementId: memberId, pieces });

    for (const path of built.paths.filter(isHaunchTransitionPath)) {
      const world = memberLocalPathToWorld(path, placement, memberId);
      if (world) haunchWorldPaths.push(world);
    }

    const appendixA2Anchorage = options.appendixA2CornerAnchorageMap?.get?.(memberId) || null;
    if (appendixA2Anchorage?.appendixA2CornerAnchoragePaths?.length) {
      const resolved = resolveAppendixA2CornerAnchorageWorldPaths({
        anchorage: appendixA2Anchorage,
        memberPaths: built.paths,
        placement,
        memberLengthMm: placement.length,
        memberId,
        memberTag: options.appendixA2MemberTag || 'StbGirder',
        endpointTrims,
        haunchTransitions,
        verticalPlacementPlan: appendixA2MemberPlan,
      });
      appendixA2CornerAnchorageWorldPaths.push(...resolved.paths);
    }
    if (
      appendixA2Anchorage?.ends?.some?.(
        (end) => end?.appendixA2CornerAnchorageGate?.method === 'U_SHAPE_ANCHORAGE',
      )
    ) {
      const resolved = resolveAppendixA2UShapeWorldPaths({
        anchorage: appendixA2Anchorage,
        memberPaths: built.paths,
        placement,
        memberLengthMm: placement.length,
        memberId,
        memberTag: options.appendixA2MemberTag || 'StbGirder',
        endpointTrims,
        haunchTransitions,
        projectDetailing: options.projectDetailing,
      });
      appendixA2UShapeWorldPaths.push(...resolved.paths);
    }

    const memberPlan = smallBeamVertical90RenderPlan?.members?.get?.(memberId) || null;
    if (memberPlan) {
      const resolved = resolveSmallBeamVertical90WorldPaths({
        memberPlan,
        memberPaths: built.paths,
        placement,
        memberLengthMm: placement.length,
        memberId,
        sectionId: beam.id_section,
      });
      smallBeamAnchorageWorldPaths.push(...resolved.paths);
    }

    const bottomMemberPlan = smallBeamBottomL3RenderPlan?.members?.get?.(memberId) || null;
    if (bottomMemberPlan) {
      const resolved = resolveSmallBeamBottomL3WorldPaths({
        memberPlan: bottomMemberPlan,
        memberPaths: built.paths,
        placement,
        memberLengthMm: placement.length,
        memberId,
        sectionId: beam.id_section,
      });
      smallBeamBottomAnchorageWorldPaths.push(...resolved.paths);
    }
  }

  const semanticMainMeshes = semanticElements.length
    ? createRebarPieceMeshes(semanticElements, nodes, layoutMap, pieceMap, {
        ...options,
        rebarKind: 'beamMain',
        memberType: 'beam',
      })
    : [];

  const haunchTransitionMeshes = haunchWorldPaths.length
    ? createColumnJointRebarMeshes(haunchWorldPaths, {
        modelSource: options.modelSource,
        rebarKind: 'girderHaunchTransition',
      })
    : [];

  const placementConflictEndpointInsetMeshes = placementConflictEndpointInsetWorldPaths.length
    ? createColumnJointRebarMeshes(placementConflictEndpointInsetWorldPaths, {
        modelSource: options.modelSource,
        rebarKind: 'beamPlacementEndpointInset',
      })
    : [];

  const appendixA2CornerAnchorageMeshes = appendixA2CornerAnchorageWorldPaths.length
    ? createColumnJointRebarMeshes(appendixA2CornerAnchorageWorldPaths, {
        modelSource: options.modelSource,
        rebarKind: 'appendixA2CornerAnchorage',
      })
    : [];

  const appendixA2UShapeMeshes = appendixA2UShapeWorldPaths.length
    ? createColumnJointRebarMeshes(appendixA2UShapeWorldPaths, {
        modelSource: options.modelSource,
        rebarKind: 'appendixA2CornerUShapeAnchorage',
      })
    : [];

  const smallBeamAnchorageMeshes = smallBeamAnchorageWorldPaths.length
    ? createColumnJointRebarMeshes(smallBeamAnchorageWorldPaths, {
        modelSource: options.modelSource,
        rebarKind: 'smallBeamVerticalAnchorage',
      })
    : [];

  const smallBeamBottomAnchorageMeshes = smallBeamBottomAnchorageWorldPaths.length
    ? createColumnJointRebarMeshes(smallBeamBottomAnchorageWorldPaths, {
        modelSource: options.modelSource,
        rebarKind: 'smallBeamBottomAnchorage',
      })
    : [];

  const smallBeamBottomL3hMeshes = smallBeamBottomL3hWorldPaths.length
    ? createColumnJointRebarMeshes(smallBeamBottomL3hWorldPaths, {
        modelSource: options.modelSource,
        rebarKind: 'smallBeamBottomL3hAnchorage',
      })
    : [];

  const webLayouts = webOnlyLayoutMap(layoutMap);
  const semanticWebMeshes =
    semanticElements.length && webLayouts.size
      ? createLegacyBeamRebarMeshes(semanticElements, nodes, webLayouts, options)
      : [];
  const legacyMeshes = legacyElements.length
    ? createLegacyBeamRebarMeshes(legacyElements, nodes, layoutMap, options)
    : [];
  return [
    ...semanticMainMeshes,
    ...haunchTransitionMeshes,
    ...placementConflictEndpointInsetMeshes,
    ...appendixA2CornerAnchorageMeshes,
    ...appendixA2UShapeMeshes,
    ...smallBeamAnchorageMeshes,
    ...smallBeamBottomAnchorageMeshes,
    ...smallBeamBottomL3hMeshes,
    ...semanticWebMeshes,
    ...legacyMeshes,
  ];
}
