/**
 * @fileoverview R13 基礎大梁端部定着のanchor-local pathを既存member主筋identityへ接続してworld化する。
 *
 * この層は定着規則そのものを決めない。data層でCENTERLINE_READYになったpathだけを対象に、
 * 同一identityのmember-local主筋が材端へ一意に到達していることとworld座標での連続性を確認する。
 * group内に未解決が1本でもある場合は、当該memberの定着pathを部分描画せずfail-closedする。
 */

import * as THREE from 'three';
import { anchorLocalPathToWorldLines } from '../core/RebarPathWorldAdapter.js';
import {
  createRebarPath,
  getPathEnd,
  getPathStart,
  validateRebarPath,
} from '../../../data/extractors/rebar3d/rebarPath.js';

const TOLERANCE_MM = 1e-5;
const SOURCE = 'R13-foundation-beam-anchorage-world';

function closeEnough(left, right, tolerance = TOLERANCE_MM) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function samePoint(left, right, tolerance = TOLERANCE_MM) {
  return (
    closeEnough(left?.x, right?.x, tolerance) &&
    closeEnough(left?.y, right?.y, tolerance) &&
    closeEnough(left?.z, right?.z, tolerance)
  );
}

function normalizeLayer(value) {
  return value === null || value === undefined || value === '' ? null : Number(value);
}

function readyEntry(entry, memberId) {
  const path = entry?.productionPath;
  return (
    entry?.generationStatus === 'CENTERLINE_READY' &&
    entry?.productionPathCandidate === true &&
    entry?.productionConsumer === 'beam-anchor-local-path' &&
    ['start', 'end'].includes(entry?.side) &&
    Boolean(entry?.identityKey) &&
    path?.metadata?.coordinateSpace === 'anchor-local' &&
    path?.metadata?.ruleId === 'R13' &&
    path?.metadata?.identityKey === entry.identityKey &&
    String(path?.metadata?.memberId || '') === String(memberId || '') &&
    path?.metadata?.memberTag === 'StbGirder' &&
    ['STRAIGHT_L2', 'BENT_L2_LA_TAIL8D'].includes(path?.metadata?.anchorageMode)
  );
}

function matchingMemberPaths(paths, entry, memberLengthMm) {
  const anchorStart = getPathStart(entry.productionPath);
  const endpointZ = entry.side === 'start' ? -memberLengthMm / 2 : memberLengthMm / 2;
  return (paths || []).filter((path) => {
    if (
      path?.metadata?.coordinateSpace !== 'member-local' ||
      path.metadata?.identityKey !== entry.identityKey ||
      path.metadata?.role !== entry.role ||
      normalizeLayer(path.metadata?.layer) !== normalizeLayer(entry.layer) ||
      !validateRebarPath(path).ok
    ) {
      return false;
    }
    const endpoint = entry.side === 'start' ? getPathStart(path) : getPathEnd(path);
    return (
      closeEnough(endpoint?.x, anchorStart?.x) &&
      closeEnough(endpoint?.y, anchorStart?.y) &&
      closeEnough(endpoint?.z, endpointZ)
    );
  });
}

function memberLocalPointToWorld(point, placement) {
  if (!point || !placement) return null;
  const roll = Number(placement.localRollRad ?? 0);
  if (!Number.isFinite(roll)) return null;
  const values = [
    point.x,
    point.y,
    point.z,
    placement?.center?.x,
    placement?.center?.y,
    placement?.center?.z,
    placement?.rotation?.x,
    placement?.rotation?.y,
    placement?.rotation?.z,
    placement?.rotation?.w,
  ].map(Number);
  if (!values.every(Number.isFinite)) return null;

  const cos = Math.cos(roll);
  const sin = Math.sin(roll);
  const u = roll === 0 ? Number(point.x) : Number(point.x) * cos - Number(point.y) * sin;
  const v = roll === 0 ? Number(point.y) : Number(point.x) * sin + Number(point.y) * cos;
  const vector = new THREE.Vector3(u, v, Number(point.z));
  vector.applyQuaternion(
    new THREE.Quaternion(
      Number(placement.rotation.x),
      Number(placement.rotation.y),
      Number(placement.rotation.z),
      Number(placement.rotation.w),
    ),
  );
  vector.add(
    new THREE.Vector3(
      Number(placement.center.x),
      Number(placement.center.y),
      Number(placement.center.z),
    ),
  );
  return [vector.x, vector.y, vector.z].every(Number.isFinite)
    ? { x: vector.x, y: vector.y, z: vector.z }
    : null;
}

function resolveEntryWorldPath({ entry, memberPaths, placement, memberLengthMm, memberId }) {
  if (!readyEntry(entry, memberId)) {
    return { path: null, reason: 'foundation-beam-anchorage-render-gate-not-ready', entry };
  }
  const candidates = matchingMemberPaths(memberPaths, entry, Number(memberLengthMm));
  if (candidates.length !== 1) {
    return {
      path: null,
      reason:
        candidates.length === 0
          ? 'foundation-beam-anchorage-render-main-path-unresolved'
          : 'foundation-beam-anchorage-render-main-path-ambiguous',
      entry,
      candidateCount: candidates.length,
    };
  }

  const memberPath = candidates[0];
  const memberEndpoint = entry.side === 'start' ? getPathStart(memberPath) : getPathEnd(memberPath);
  const memberWorldEndpoint = memberLocalPointToWorld(memberEndpoint, placement);
  const anchorWorld = anchorLocalPathToWorldLines(entry.productionPath, placement, {
    anchor: entry.side,
    memberId,
    memberTag: 'StbGirder',
  });
  if (!memberWorldEndpoint || !anchorWorld || !validateRebarPath(anchorWorld).ok) {
    return { path: null, reason: 'foundation-beam-anchorage-render-world-path-invalid', entry };
  }

  const anchorageStart = getPathStart(anchorWorld);
  if (!samePoint(memberWorldEndpoint, anchorageStart)) {
    return {
      path: null,
      reason: 'foundation-beam-anchorage-render-world-continuity-mismatch',
      entry,
      memberEndpoint: memberWorldEndpoint,
      anchorageStart,
    };
  }

  const worldPath = createRebarPath(anchorWorld.primitives, {
    ...anchorWorld.metadata,
    source: SOURCE,
    ruleId: 'R13',
    renderReady: true,
    generationStatus: 'CENTERLINE_READY',
    productionPathCandidate: true,
    productionReady: true,
    productionConsumer: 'explicit-world-path',
    memberId: String(memberId),
    memberTag: 'StbGirder',
    endpoint: entry.side,
    identityKey: entry.identityKey,
  });
  return validateRebarPath(worldPath).ok
    ? { path: worldPath, reason: null, entry }
    : { path: null, reason: 'foundation-beam-anchorage-render-world-path-invalid', entry };
}

export function resolveFoundationBeamAnchorageWorldPaths({
  memberPlan,
  memberPaths,
  placement,
  memberLengthMm,
  memberId,
  sectionId = null,
} = {}) {
  if (!memberPlan?.entries?.length) {
    return { resolved: true, paths: [], unresolved: [], source: SOURCE };
  }
  if (!(Number(memberLengthMm) > 0) || !placement) {
    return {
      resolved: false,
      paths: [],
      unresolved: [{ reason: 'foundation-beam-anchorage-render-placement-unresolved' }],
      source: SOURCE,
    };
  }
  if (
    memberPlan.sectionId !== null &&
    memberPlan.sectionId !== undefined &&
    String(memberPlan.sectionId) !== String(sectionId)
  ) {
    return {
      resolved: false,
      paths: [],
      unresolved: [{ reason: 'foundation-beam-anchorage-render-section-mismatch' }],
      source: SOURCE,
    };
  }

  const results = memberPlan.entries.map((entry) =>
    resolveEntryWorldPath({ entry, memberPaths, placement, memberLengthMm, memberId }),
  );
  const unresolved = results
    .filter((result) => !result.path)
    .map(({ reason, entry, ...extra }) => ({ reason, entry, ...extra }));
  if (unresolved.length > 0) {
    return { resolved: false, paths: [], unresolved, source: SOURCE };
  }
  return {
    resolved: true,
    paths: results.map((result) => result.path),
    unresolved: [],
    source: SOURCE,
  };
}

export const _foundationBeamAnchorageWorldResolverInternals = Object.freeze({
  readyEntry,
  matchingMemberPaths,
  memberLocalPointToWorld,
  resolveEntryWorldPath,
  samePoint,
});
