/**
 * @fileoverview R12-T VERTICAL_90 actual pathとmember-local主筋端点の連続性を検証する。
 *
 * R12-S actual pathはanchor-localのmember端(z=0)から開始する。このモジュールでは
 * R5 beam identity pathのうち同じbar semantic/u/vで対象端まで到達するpathを一意に解決し、
 * 両中心線がmember端で同一点になることだけを確認する。identity一致はR12-Uへ分離する。
 */

import { findElementById, getNodeCoord } from '../columnSupportUtils.js';
import { buildBeamMemberRebarPaths } from './beamRebarPathBuilder.js';
import { getPathEnd, getPathStart, validateRebarPath } from './rebarPath.js';

const TOLERANCE_MM = 1e-6;
const SOURCE = 'R12-small-beam-vertical-90-continuity';
const GROUP_SOURCE = 'R12-small-beam-group-vertical-90-continuity';

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    continuityReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    memberPath: null,
    ...extra,
  };
}

function unresolvedGroup(reason, extra = {}) {
  return {
    resolved: false,
    continuityReady: false,
    productionReady: false,
    reason,
    source: GROUP_SOURCE,
    barContinuities: [],
    ...extra,
  };
}

function closeEnough(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= TOLERANCE_MM;
}

function samePoint(point, target) {
  return (
    closeEnough(point?.x, target?.x) &&
    closeEnough(point?.y, target?.y) &&
    closeEnough(point?.z, target?.z)
  );
}

function layerKey(value) {
  return value === null || value === undefined || value === '' ? '' : String(value);
}

function gradeKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function semanticMatches(path, bar) {
  return (
    path?.metadata?.role === bar?.role &&
    layerKey(path?.metadata?.layer) === layerKey(bar?.layer) &&
    closeEnough(path?.metadata?.dia, bar?.dia) &&
    gradeKey(path?.metadata?.grade) === gradeKey(bar?.grade)
  );
}

function readOffsetComponent(beamEl, prefix, axis) {
  const attribute = `${prefix}_${axis}`;
  const raw = beamEl?.getAttribute?.(attribute);
  const present =
    typeof beamEl?.hasAttribute === 'function'
      ? beamEl.hasAttribute(attribute)
      : raw !== null && raw !== undefined;
  if (!present) {
    return { resolved: true, attribute, axis, value: 0, raw: null, source: 'omitted' };
  }
  if (String(raw).trim() === '') {
    return { resolved: false, attribute, axis, value: null, raw, source: 'attribute' };
  }
  const value = Number(raw);
  return Number.isFinite(value)
    ? { resolved: true, attribute, axis, value, raw, source: 'attribute' }
    : { resolved: false, attribute, axis, value: null, raw, source: 'attribute' };
}

function readOffset(beamEl, prefix, side) {
  const components = ['X', 'Y', 'Z'].map((axis) => readOffsetComponent(beamEl, prefix, axis));
  const invalidOffsets = components
    .filter((component) => !component.resolved)
    .map((component) => ({
      side,
      axis: component.axis,
      attribute: component.attribute,
      raw: component.raw,
    }));
  if (invalidOffsets.length > 0) {
    return { resolved: false, offset: null, invalidOffsets };
  }
  return {
    resolved: true,
    offset: {
      x: components[0].value,
      y: components[1].value,
      z: components[2].value,
    },
    invalidOffsets: [],
  };
}

/**
 * productionのbeam path builderと同じ「offset後の始終点間長さ」をdata層で解決する。
 * R12 support-face geometryは平面距離を用いるため、現段階では傾斜梁をfail-closedにする。
 */
export function resolveSmallBeamMemberPathContext(
  scanTag,
  beamEl,
  layout,
  memberId = null,
  index = null,
) {
  if (!scanTag || !beamEl || !layout) {
    return {
      resolved: false,
      reason: 'small-beam-vertical-90-member-path-source-unresolved',
      source: 'R12-small-beam-member-path-context',
      paths: [],
    };
  }

  const startNode = getNodeCoord(scanTag, beamEl.getAttribute('id_node_start'), index);
  const endNode = getNodeCoord(scanTag, beamEl.getAttribute('id_node_end'), index);
  if (!startNode || !endNode) {
    return {
      resolved: false,
      reason: 'small-beam-vertical-90-member-node-unresolved',
      source: 'R12-small-beam-member-path-context',
      paths: [],
    };
  }

  const startOffsetFact = readOffset(beamEl, 'offset_start', 'start');
  const endOffsetFact = readOffset(beamEl, 'offset_end', 'end');
  if (!startOffsetFact.resolved || !endOffsetFact.resolved) {
    return {
      resolved: false,
      reason: 'small-beam-vertical-90-member-offset-invalid',
      source: 'R12-small-beam-member-path-context',
      paths: [],
      invalidOffsets: [...startOffsetFact.invalidOffsets, ...endOffsetFact.invalidOffsets],
    };
  }
  const startOffset = startOffsetFact.offset;
  const endOffset = endOffsetFact.offset;
  const start = {
    x: startNode.x + startOffset.x,
    y: startNode.y + startOffset.y,
    z: startNode.z + startOffset.z,
  };
  const end = {
    x: endNode.x + endOffset.x,
    y: endNode.y + endOffset.y,
    z: endNode.z + endOffset.z,
  };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const planLengthMm = Math.hypot(dx, dy);
  const memberLengthMm = Math.hypot(dx, dy, dz);
  if (!(planLengthMm > TOLERANCE_MM) || !(memberLengthMm > TOLERANCE_MM)) {
    return {
      resolved: false,
      reason: 'small-beam-vertical-90-member-length-unresolved',
      source: 'R12-small-beam-member-path-context',
      paths: [],
      planLengthMm,
      memberLengthMm,
    };
  }
  if (Math.abs(dz) > TOLERANCE_MM || !closeEnough(planLengthMm, memberLengthMm)) {
    return {
      resolved: false,
      reason: 'small-beam-vertical-90-sloped-member-not-supported',
      source: 'R12-small-beam-member-path-context',
      paths: [],
      planLengthMm,
      memberLengthMm,
      deltaZMm: dz,
    };
  }

  const built = buildBeamMemberRebarPaths(layout, memberLengthMm, {
    memberId: memberId === null || memberId === undefined ? null : String(memberId),
  });
  if (!built?.paths?.length || !(built.semanticMainBarCount > 0)) {
    return {
      resolved: false,
      reason: 'small-beam-vertical-90-member-main-path-unresolved',
      source: 'R12-small-beam-member-path-context',
      paths: built?.paths || [],
      memberLengthMm,
      planLengthMm,
      identity: built?.identity || null,
    };
  }

  return {
    resolved: true,
    reason: null,
    source: 'R12-small-beam-member-path-context',
    memberId: memberId === null || memberId === undefined ? null : String(memberId),
    memberLengthMm,
    planLengthMm,
    deltaZMm: dz,
    paths: built.paths,
    identity: built.identity,
    semanticMainBarCount: built.semanticMainBarCount,
    haunchTransitions: built.haunchTransitions,
  };
}

/**
 * 1本のR12-S actual pathを、同じbar semantic/u/vで対象member端に到達するR5 pathへ接続する。
 */
export function resolveSmallBeamVertical90BarContinuity({
  bar,
  actualPathFact,
  memberPaths,
  memberLengthMm,
  side,
  barIndex = null,
} = {}) {
  if (
    !actualPathFact?.resolved ||
    actualPathFact.actualPathReady !== true ||
    !actualPathFact.path
  ) {
    return unresolved(actualPathFact?.reason || 'small-beam-vertical-90-actual-path-not-ready');
  }
  if (!['start', 'end'].includes(side) || actualPathFact.anchor !== side) {
    return unresolved('small-beam-vertical-90-continuity-anchor-mismatch', {
      side: side || null,
      actualAnchor: actualPathFact.anchor || null,
    });
  }
  const length = Number(memberLengthMm);
  if (!(length > 0) || !Array.isArray(memberPaths)) {
    return unresolved('small-beam-vertical-90-member-path-context-unresolved');
  }

  const u = Number(bar?.u);
  const v = Number(bar?.v);
  if (!Number.isFinite(u) || !Number.isFinite(v)) {
    return unresolved('small-beam-vertical-90-continuity-bar-position-unresolved');
  }

  const actualStart = getPathStart(actualPathFact.path);
  const expectedAnchorPoint = { x: u, y: v, z: 0 };
  if (!samePoint(actualStart, expectedAnchorPoint)) {
    return unresolved('small-beam-vertical-90-continuity-actual-path-start-mismatch', {
      actualStart,
      expectedAnchorPoint,
    });
  }

  const endpointZ = side === 'start' ? -length / 2 : length / 2;
  const candidates = memberPaths.filter((path) => {
    if (path?.metadata?.coordinateSpace !== 'member-local' || !semanticMatches(path, bar))
      return false;
    if (!validateRebarPath(path).ok) return false;
    const endpoint = side === 'start' ? getPathStart(path) : getPathEnd(path);
    return (
      closeEnough(endpoint?.x, u) &&
      closeEnough(endpoint?.y, v) &&
      closeEnough(endpoint?.z, endpointZ)
    );
  });

  if (candidates.length === 0) {
    return unresolved('small-beam-vertical-90-main-bar-endpoint-unresolved', {
      side,
      endpointZ,
      u,
      v,
    });
  }
  if (candidates.length !== 1) {
    return unresolved('small-beam-vertical-90-main-bar-endpoint-ambiguous', {
      side,
      endpointZ,
      u,
      v,
      candidateCount: candidates.length,
    });
  }

  const memberPath = candidates[0];
  const memberEndpoint = side === 'start' ? getPathStart(memberPath) : getPathEnd(memberPath);
  return {
    resolved: true,
    continuityReady: true,
    productionReady: false,
    reason: null,
    source: SOURCE,
    side,
    barIndex: Number.isInteger(barIndex) ? barIndex : null,
    u,
    v,
    barDiaMm: Number(bar?.dia),
    grade: bar?.grade || null,
    layer: bar?.layer ?? null,
    memberLengthMm: length,
    memberEndpoint,
    anchorLocalEndpoint: actualStart,
    memberPath,
    memberPathIdentityKey: memberPath.metadata?.identityKey || null,
    memberPathIdentityStatus: memberPath.metadata?.identityStatus || null,
  };
}

export function resolveSmallBeamGroupVertical90Continuity(group, memberContext, side) {
  if (group?.role !== 'top') return null;
  const mode = group.anchorageMode;
  if (!mode?.resolved)
    return unresolvedGroup(mode?.reason || 'small-beam-anchorage-mode-unresolved');
  if (mode.mode !== 'VERTICAL_90') {
    return {
      resolved: true,
      continuityReady: false,
      productionReady: false,
      applicable: false,
      reason: 'vertical-90-mode-not-selected',
      source: GROUP_SOURCE,
      barContinuities: [],
    };
  }
  if (!memberContext?.resolved) {
    return unresolvedGroup(
      memberContext?.reason || 'small-beam-vertical-90-member-path-context-unresolved',
    );
  }

  const bars = Array.isArray(group.bars) ? group.bars : [];
  const actualPaths = group.vertical90ActualPath?.barPaths;
  if (!group.vertical90ActualPath?.resolved || !Array.isArray(actualPaths)) {
    return unresolvedGroup(
      group.vertical90ActualPath?.reason || 'small-beam-vertical-90-actual-path-not-ready',
    );
  }
  if (bars.length === 0 || actualPaths.length !== bars.length) {
    return unresolvedGroup('small-beam-vertical-90-continuity-source-count-mismatch', {
      barCount: bars.length,
      actualPathCount: actualPaths.length,
    });
  }

  const barContinuities = bars.map((bar, index) =>
    resolveSmallBeamVertical90BarContinuity({
      bar,
      actualPathFact: actualPaths[index],
      memberPaths: memberContext.paths,
      memberLengthMm: memberContext.memberLengthMm,
      side,
      barIndex: index,
    }),
  );
  const failed = barContinuities.filter((fact) => !fact.resolved || fact.continuityReady !== true);
  if (failed.length > 0) {
    return unresolvedGroup(failed[0].reason || 'small-beam-vertical-90-continuity-unresolved', {
      barContinuities,
      failedBarContinuities: failed,
    });
  }

  return {
    resolved: true,
    continuityReady: true,
    productionReady: false,
    applicable: true,
    reason: null,
    source: GROUP_SOURCE,
    barContinuities,
    failedBarContinuities: [],
  };
}

/**
 * member-local R5 pathを構築した後、R12-S actual pathとの端点連続性をgroup factsへ接続する。
 * buildBeamMemberRebarPaths() が同じlayout bar objectへidentityKeyを付けるため、R12-Uは
 * この後段でidentityを検証する。
 */
export function attachSmallBeamVertical90ContinuityFacts(
  requirementFacts,
  beamLayoutMaps,
  scanTag,
  index = null,
) {
  if (!requirementFacts?.beam) {
    return { ...(requirementFacts || {}), vertical90ContinuityUnresolved: [] };
  }

  const vertical90ContinuityUnresolved = [];
  for (const [elementId, beamFacts] of requirementFacts.beam) {
    const layout = beamLayoutMaps?.beam?.get?.(String(beamFacts.sectionId)) || null;
    const beamEl = scanTag ? findElementById(scanTag, 'StbBeam', String(elementId), index) : null;
    const memberContext = resolveSmallBeamMemberPathContext(
      scanTag,
      beamEl,
      layout,
      elementId,
      index,
    );
    beamFacts.vertical90MemberPathContext = memberContext;

    for (const end of beamFacts?.ends || []) {
      if (end.status === 'FREE_END') continue;
      for (const group of end.requirements || []) {
        if (group.role !== 'top') continue;
        group.vertical90Continuity = resolveSmallBeamGroupVertical90Continuity(
          group,
          memberContext,
          end.side,
        );
        if (
          group.anchorageMode?.mode === 'VERTICAL_90' &&
          group.vertical90Continuity?.resolved === false
        ) {
          vertical90ContinuityUnresolved.push({
            elementId,
            elementName: beamFacts.elementName,
            side: end.side,
            role: group.role,
            diaMm: group.diaMm,
            grade: group.grade,
            reason: group.vertical90Continuity.reason,
          });
        }
      }
    }
  }

  return {
    ...requirementFacts,
    vertical90ContinuityUnresolved,
  };
}
