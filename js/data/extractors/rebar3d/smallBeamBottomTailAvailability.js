/**
 * @fileoverview R12-Y 一般小梁下端筋L3h 90°フックの上向き余長を解決する。
 *
 * 支持大梁の天端・せい・上下かぶりと小梁下端筋中心高さを用い、実曲げArcの
 * 上向き接線から支持大梁上側clear centerまでの直線余長をbar-levelで算定する。
 */

import { getNodeCoord } from '../columnSupportUtils.js';
import { querySelectorAll } from '../sectionListUtils.js';
import { resolveHookBendGeometry } from './rebarHookGeometry.js';
import {
  hasUnsupportedSmallBeamSectionRotation,
  resolveSmallBeamSectionRollDegrees,
  SMALL_BEAM_ROTATED_SECTION_UNSUPPORTED_REASON,
} from './smallBeamSectionOrientation.js';

const TOLERANCE_MM = 1e-6;
const SOURCE = 'R12-Y-small-beam-bottom-up-tail-availability';

function unresolved(reason, extra = {}) {
  return { ...extra, resolved: false, reason, availableTailMm: null, source: SOURCE };
}

function attributePresent(element, name) {
  if (!element) return false;
  if (typeof element.hasAttribute === 'function') return element.hasAttribute(name);
  const raw = element.getAttribute?.(name);
  return raw !== null && raw !== undefined;
}

function numberAttributeFact(element, name) {
  if (!attributePresent(element, name)) {
    return { resolved: true, value: 0, raw: null, attribute: name, source: 'omitted' };
  }
  const raw = element?.getAttribute?.(name);
  if (String(raw).trim() === '') {
    return { resolved: false, value: null, raw, attribute: name, source: 'attribute' };
  }
  const value = Number(raw);
  return Number.isFinite(value)
    ? { resolved: true, value, raw, attribute: name, source: 'attribute' }
    : { resolved: false, value: null, raw, attribute: name, source: 'attribute' };
}

function memberViaContainsNode(memberEl, nodeId) {
  if (!memberEl || nodeId === null || nodeId === undefined) return false;
  const id = String(nodeId);
  for (const order of querySelectorAll(memberEl, 'StbNodeIdOrder')) {
    const value = order?.textContent;
    if (value && value.trim().split(/\s+/).includes(id)) return true;
  }
  return false;
}

function offsetZAtNode(memberEl, nodeId) {
  if (!memberEl || !nodeId) {
    return { resolved: false, value: null, reason: 'member-or-node-missing' };
  }
  if (memberEl.getAttribute('id_node_start') === String(nodeId)) {
    return { ...numberAttributeFact(memberEl, 'offset_start_Z'), connection: 'start' };
  }
  if (memberEl.getAttribute('id_node_end') === String(nodeId)) {
    return { ...numberAttributeFact(memberEl, 'offset_end_Z'), connection: 'end' };
  }

  if (memberViaContainsNode(memberEl, nodeId)) {
    for (const offset of querySelectorAll(memberEl, 'StbMemberOffsetList')) {
      if (offset.getAttribute('id_node') !== String(nodeId)) continue;
      return { ...numberAttributeFact(offset, 'offset_Z'), connection: 'via' };
    }
    return {
      resolved: true,
      value: 0,
      raw: null,
      attribute: 'offset_Z',
      source: 'omitted-via-offset',
      connection: 'via',
    };
  }

  // ON_GIRDERの中間取付点でも始終端Z offsetが同値なら一定位相として利用できる。
  // 異なる場合は補間を発明せずfail-closedとする。
  const startOffset = numberAttributeFact(memberEl, 'offset_start_Z');
  const endOffset = numberAttributeFact(memberEl, 'offset_end_Z');
  if (
    startOffset.resolved &&
    endOffset.resolved &&
    Number.isFinite(startOffset.value) &&
    Number.isFinite(endOffset.value) &&
    Math.abs(startOffset.value - endOffset.value) <= TOLERANCE_MM
  ) {
    return {
      resolved: true,
      value: startOffset.value,
      raw: null,
      attribute: 'offset_start_Z/offset_end_Z',
      source: 'uniform-end-offset',
      connection: 'intersection-uniform',
    };
  }
  return {
    resolved: false,
    value: null,
    reason: 'member-offset-z-at-intersection-unresolved',
    connection: 'none',
  };
}

function memberTopZAtNode(scanTag, memberEl, nodeId, index = null) {
  const node = getNodeCoord(scanTag, nodeId, index);
  if (!node) return { resolved: false, reason: 'member-node-unresolved', topZ: null };
  const offset = offsetZAtNode(memberEl, nodeId);
  if (!offset.resolved || !Number.isFinite(offset.value)) {
    return {
      resolved: false,
      reason: offset.reason || 'member-offset-z-invalid',
      topZ: null,
      offset,
    };
  }
  return { resolved: true, reason: null, topZ: node.z + offset.value, offset };
}

function memberContainsNode(element, nodeId) {
  if (!element || nodeId === null || nodeId === undefined) return false;
  const id = String(nodeId);
  if (
    element.getAttribute?.('id_node_start') === id ||
    element.getAttribute?.('id_node_end') === id
  ) {
    return true;
  }
  return memberViaContainsNode(element, nodeId);
}

function explicitGirderLinkMatches(supportEnd, supportGirderEl) {
  if (supportEnd?.source !== 'stb-node-kind-id-member') return false;
  if (String(supportEnd?.nodeKind || '').toUpperCase() !== 'ON_GIRDER') return false;
  const linkedId = supportEnd?.linkedMemberId || supportEnd?.supportId;
  const supportId = supportGirderEl?.getAttribute?.('id');
  return Boolean(linkedId && supportId && String(linkedId) === String(supportId));
}

export function resolveSmallBeamBottomUpTailAvailability({
  scanTag,
  beamEl,
  supportGirderEl,
  supportEnd,
  supportContext,
  bar,
  index = null,
} = {}) {
  if (!beamEl) return unresolved('small-beam-element-not-found');
  if (!supportGirderEl) return unresolved('support-girder-not-found');
  const side = supportEnd?.side;
  if (!['start', 'end'].includes(side)) {
    return unresolved('small-beam-support-side-unresolved', { side: side ?? null });
  }

  const expectedBeamNodeId = beamEl.getAttribute(side === 'end' ? 'id_node_end' : 'id_node_start');
  const supportNodeId = supportEnd?.nodeId;
  if (!expectedBeamNodeId) return unresolved('small-beam-end-node-id-missing', { side });
  if (!supportNodeId || String(supportNodeId) !== String(expectedBeamNodeId)) {
    return unresolved('small-beam-support-node-side-mismatch', {
      side,
      supportNodeId: supportNodeId == null ? null : String(supportNodeId),
      expectedBeamNodeId: String(expectedBeamNodeId),
    });
  }

  const expectedSupportId = supportEnd?.supportId;
  const actualSupportId = supportGirderEl.getAttribute?.('id');
  if (
    !expectedSupportId ||
    !actualSupportId ||
    String(expectedSupportId) !== String(actualSupportId)
  ) {
    return unresolved('support-girder-id-mismatch', {
      side,
      expectedSupportId: expectedSupportId == null ? null : String(expectedSupportId),
      actualSupportId: actualSupportId == null ? null : String(actualSupportId),
    });
  }
  if (
    !memberContainsNode(supportGirderEl, supportNodeId) &&
    !explicitGirderLinkMatches(supportEnd, supportGirderEl)
  ) {
    return unresolved('support-girder-not-connected-at-support-node', {
      side,
      supportId: String(expectedSupportId),
      supportNodeId: String(supportNodeId),
    });
  }
  if (hasUnsupportedSmallBeamSectionRotation(beamEl)) {
    return unresolved(SMALL_BEAM_ROTATED_SECTION_UNSUPPORTED_REASON, {
      sectionRollDegrees: resolveSmallBeamSectionRollDegrees(beamEl),
    });
  }

  const supportDepthMm = Number(supportContext?.supportDepthMm);
  if (!supportContext?.supportDepthResolved || !(supportDepthMm > 0)) {
    return unresolved(supportContext?.supportDepthReason || 'support-girder-depth-unresolved');
  }

  const barDiaMm = Number(bar?.dia);
  const centerFromTopMm = Number(bar?.centerFromTopMm);
  if (!(barDiaMm > 0)) return unresolved('small-beam-bar-diameter-unresolved');
  if (!(Number.isFinite(centerFromTopMm) && centerFromTopMm > 0)) {
    return unresolved('small-beam-bottom-bar-center-from-top-unresolved', { barDiaMm });
  }

  const coverTopFact = supportContext?.supportCoverByFace?.top;
  const coverBottomFact = supportContext?.supportCoverByFace?.bottom;
  const supportTopCoverMm = Number(coverTopFact?.coverMm);
  const supportBottomCoverMm = Number(coverBottomFact?.coverMm);
  if (!coverTopFact?.resolved || !Number.isFinite(supportTopCoverMm) || supportTopCoverMm < 0) {
    return unresolved(coverTopFact?.reason || 'support-girder-top-cover-unresolved', { barDiaMm });
  }
  if (
    !coverBottomFact?.resolved ||
    !Number.isFinite(supportBottomCoverMm) ||
    supportBottomCoverMm < 0
  ) {
    return unresolved(coverBottomFact?.reason || 'support-girder-bottom-cover-unresolved', {
      barDiaMm,
    });
  }

  const smallBeamTopFact = memberTopZAtNode(scanTag, beamEl, expectedBeamNodeId, index);
  const supportTopFact = memberTopZAtNode(scanTag, supportGirderEl, supportNodeId, index);
  if (!smallBeamTopFact.resolved) {
    return unresolved(
      smallBeamTopFact.reason === 'member-offset-z-invalid'
        ? 'small-beam-top-offset-z-invalid'
        : 'small-beam-top-z-unresolved',
      { memberTopFact: smallBeamTopFact },
    );
  }
  if (!supportTopFact.resolved) {
    const reason =
      supportTopFact.reason === 'member-offset-z-at-intersection-unresolved'
        ? 'support-girder-top-z-at-intersection-unresolved'
        : supportTopFact.reason === 'member-offset-z-invalid'
          ? 'support-girder-top-offset-z-invalid'
          : 'support-girder-top-z-unresolved';
    return unresolved(reason, { memberTopFact: supportTopFact });
  }

  const bendRule = resolveHookBendGeometry({
    grade: bar?.grade,
    barDiaMm,
    bendAngleDeg: 90,
  });
  if (!bendRule.ok) {
    return unresolved(bendRule.reason || 'small-beam-90deg-bend-rule-unresolved', { bendRule });
  }

  const barRadiusMm = barDiaMm / 2;
  const smallBeamTopZ = smallBeamTopFact.topZ;
  const supportTopZ = supportTopFact.topZ;
  const smallBeamBarCenterZ = smallBeamTopZ - centerFromTopMm;
  const supportBottomZ = supportTopZ - supportDepthMm;
  const topClearCenterZ = supportTopZ - (supportTopCoverMm + barRadiusMm);
  const bottomClearCenterZ = supportBottomZ + supportBottomCoverMm + barRadiusMm;

  if (smallBeamBarCenterZ > topClearCenterZ + TOLERANCE_MM) {
    return unresolved('small-beam-bottom-bar-above-support-clear-zone', {
      smallBeamBarCenterZ,
      topClearCenterZ,
      bottomClearCenterZ,
    });
  }
  if (smallBeamBarCenterZ < bottomClearCenterZ - TOLERANCE_MM) {
    return unresolved('small-beam-bottom-bar-below-support-clear-zone', {
      smallBeamBarCenterZ,
      topClearCenterZ,
      bottomClearCenterZ,
    });
  }

  const outgoingTangentZ = smallBeamBarCenterZ + bendRule.centerlineRadiusMm;
  if (outgoingTangentZ > topClearCenterZ + TOLERANCE_MM) {
    return unresolved('small-beam-bottom-90deg-bend-exceeds-support-depth', {
      outgoingTangentZ,
      topClearCenterZ,
      bottomClearCenterZ,
    });
  }

  return {
    resolved: true,
    reason: null,
    source: SOURCE,
    bendDirection: 'UP',
    side,
    supportId: String(expectedSupportId),
    barDiaMm,
    grade: bendRule.grade,
    barRadiusMm,
    centerFromTopMm,
    smallBeamTopZ,
    supportTopZ,
    smallBeamOffsetZSource: smallBeamTopFact.offset?.source || null,
    supportOffsetZSource: supportTopFact.offset?.source || null,
    supportBottomZ,
    smallBeamBarCenterZ,
    supportDepthMm,
    supportTopCoverMm,
    supportTopCoverSource: coverTopFact.source || null,
    supportBottomCoverMm,
    supportBottomCoverSource: coverBottomFact.source || null,
    topClearCenterZ,
    bottomClearCenterZ,
    insideDiameterFactor: bendRule.insideDiameterFactor,
    insideDiameterMm: bendRule.insideDiameterMm,
    centerlineRadiusMm: bendRule.centerlineRadiusMm,
    outgoingTangentZ,
    availableTailMm: Math.max(0, topClearCenterZ - outgoingTangentZ),
  };
}
