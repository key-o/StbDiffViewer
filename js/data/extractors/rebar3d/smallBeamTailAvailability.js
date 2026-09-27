/**
 * @fileoverview R12-O 一般小梁上端筋90°折曲げ後の鉛直余長確保を解決する。
 *
 * 支持大梁の基準天端・躯体せいと上下かぶり、小梁上端筋の実中心高さ、
 * 90°折曲げ中心線半径から、下向き折曲げ後の直線余長として利用できる長さを求める。
 *
 * このresolverは余長8dとの比較、L2全長、折曲げ方向strategy、RebarPath生成を行わない。
 */

import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { getNodeCoord } from '../columnSupportUtils.js';
import { querySelectorAll } from '../sectionListUtils.js';
import {
  hasUnsupportedSmallBeamSectionRotation,
  resolveSmallBeamSectionRollDegrees,
  SMALL_BEAM_ROTATED_SECTION_UNSUPPORTED_REASON,
} from './smallBeamSectionOrientation.js';

const TOLERANCE_MM = 1e-6;

function unresolved(reason, extra = {}) {
  return {
    ...extra,
    resolved: false,
    reason,
    availableTailMm: null,
    source: 'R12-small-beam-tail-availability',
  };
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
    const text = order?.textContent;
    if (text && text.trim().split(/\s+/).includes(id)) return true;
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

  const viaConnected = memberViaContainsNode(memberEl, nodeId);
  if (viaConnected) {
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

  // ON_GIRDER + id_member だけで示される中間取付点は、支持大梁のstart/end offsetから
  // その交点のZ offsetを補間する規則がまだ無い。0を発明するとavailableTailを誤判定するため
  // 専用interpolation/placement resolverが実装されるまではfail-closedとする。
  return {
    resolved: false,
    value: null,
    raw: null,
    attribute: null,
    source: null,
    connection: 'none',
    reason: 'member-offset-z-at-intersection-unresolved',
  };
}

function memberTopZAtNode(scanTag, memberEl, nodeId, index = null) {
  const node = getNodeCoord(scanTag, nodeId, index);
  if (!node) {
    return { resolved: false, reason: 'member-node-unresolved', nodeId, topZ: null };
  }
  const offset = offsetZAtNode(memberEl, nodeId);
  if (!offset.resolved || !Number.isFinite(offset.value)) {
    return {
      resolved: false,
      reason: offset.reason || 'member-offset-z-invalid',
      nodeId,
      topZ: null,
      offset,
    };
  }
  return {
    resolved: true,
    reason: null,
    nodeId,
    topZ: node.z + offset.value,
    offset,
  };
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
  const orders = element.getElementsByTagName?.('StbNodeIdOrder');
  if (!orders) return false;
  for (let index = 0; index < orders.length; index += 1) {
    const text = orders[index]?.textContent;
    if (text && text.trim().split(/\s+/).includes(id)) return true;
  }
  return false;
}

function explicitGirderLinkMatches(supportEnd, supportGirderEl) {
  if (supportEnd?.source !== 'stb-node-kind-id-member') return false;
  if (String(supportEnd?.nodeKind || '').toUpperCase() !== 'ON_GIRDER') return false;
  const linkedId = supportEnd?.linkedMemberId || supportEnd?.supportId;
  const supportId = supportGirderEl?.getAttribute?.('id');
  return Boolean(linkedId && supportId && String(linkedId) === String(supportId));
}

function resolveBendRule(barDiaMm, grade) {
  const normalizedGrade = REBAR_STANDARD_RULES.normalizeGrade(grade);
  if (!normalizedGrade) return { resolved: false, reason: 'small-beam-bar-grade-unresolved' };

  const inside = REBAR_STANDARD_RULES.resolveBendInsideDiameterFactor({
    grade: normalizedGrade,
    barDiaMm,
    bendAngle: 90,
  });
  if (!inside.ok || !Number.isFinite(inside.factor)) {
    return {
      resolved: false,
      reason: 'small-beam-90deg-bend-rule-unresolved',
      grade: normalizedGrade,
      insideDiameterFactor: inside.factor ?? null,
    };
  }

  const insideDiameterMm = inside.factor * barDiaMm;
  return {
    resolved: true,
    reason: null,
    grade: normalizedGrade,
    insideDiameterFactor: inside.factor,
    insideDiameterMm,
    centerlineRadiusMm: (insideDiameterMm + barDiaMm) / 2,
  };
}

export function resolveSmallBeamTopTailAvailability({
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
  if (!expectedBeamNodeId) {
    return unresolved('small-beam-end-node-id-missing', { side });
  }
  if (!supportNodeId || String(supportNodeId) !== String(expectedBeamNodeId)) {
    return unresolved('small-beam-support-node-side-mismatch', {
      side,
      supportNodeId:
        supportNodeId === null || supportNodeId === undefined ? null : String(supportNodeId),
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
      expectedSupportId:
        expectedSupportId === null || expectedSupportId === undefined
          ? null
          : String(expectedSupportId),
      actualSupportId:
        actualSupportId === null || actualSupportId === undefined ? null : String(actualSupportId),
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
  const nodeId = supportNodeId;

  const supportDepthMm = Number(supportContext?.supportDepthMm);
  if (!supportContext?.supportDepthResolved || !(supportDepthMm > 0)) {
    return unresolved(supportContext?.supportDepthReason || 'support-girder-depth-unresolved');
  }

  const barDiaMm = Number(bar?.dia);
  const centerFromTopMm = Number(bar?.centerFromTopMm);
  if (!(barDiaMm > 0)) return unresolved('small-beam-bar-diameter-unresolved');
  if (!(Number.isFinite(centerFromTopMm) && centerFromTopMm > 0)) {
    return unresolved('small-beam-top-bar-center-from-top-unresolved', { barDiaMm });
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

  const smallBeamNodeId = expectedBeamNodeId;
  const smallBeamTopFact = memberTopZAtNode(scanTag, beamEl, smallBeamNodeId, index);
  const supportTopFact = memberTopZAtNode(scanTag, supportGirderEl, nodeId, index);
  if (!smallBeamTopFact.resolved) {
    return unresolved(
      smallBeamTopFact.reason === 'member-offset-z-invalid'
        ? 'small-beam-top-offset-z-invalid'
        : 'small-beam-top-z-unresolved',
      { memberTopFact: smallBeamTopFact },
    );
  }
  if (!supportTopFact.resolved) {
    let reason = 'support-girder-top-z-unresolved';
    if (supportTopFact.reason === 'member-offset-z-invalid') {
      reason = 'support-girder-top-offset-z-invalid';
    } else if (supportTopFact.reason === 'member-offset-z-at-intersection-unresolved') {
      reason = 'support-girder-top-z-at-intersection-unresolved';
    }
    return unresolved(reason, { memberTopFact: supportTopFact });
  }
  const smallBeamTopZ = smallBeamTopFact.topZ;
  const supportTopZ = supportTopFact.topZ;

  const bendRule = resolveBendRule(barDiaMm, bar?.grade);
  if (!bendRule.resolved) return unresolved(bendRule.reason, { barDiaMm, ...bendRule });

  const barRadiusMm = barDiaMm / 2;
  const smallBeamBarCenterZ = smallBeamTopZ - centerFromTopMm;
  const supportBottomZ = supportTopZ - supportDepthMm;
  const topClearCenterZ = supportTopZ - (supportTopCoverMm + barRadiusMm);
  const bottomClearCenterZ = supportBottomZ + supportBottomCoverMm + barRadiusMm;

  if (smallBeamBarCenterZ > topClearCenterZ + TOLERANCE_MM) {
    return unresolved('small-beam-top-bar-above-support-clear-zone', {
      barDiaMm,
      smallBeamTopZ,
      supportTopZ,
      smallBeamBarCenterZ,
      topClearCenterZ,
      bottomClearCenterZ,
      ...bendRule,
    });
  }
  if (smallBeamBarCenterZ < bottomClearCenterZ - TOLERANCE_MM) {
    return unresolved('small-beam-top-bar-below-support-clear-zone', {
      barDiaMm,
      smallBeamTopZ,
      supportTopZ,
      smallBeamBarCenterZ,
      topClearCenterZ,
      bottomClearCenterZ,
      ...bendRule,
    });
  }

  const outgoingTangentZ = smallBeamBarCenterZ - bendRule.centerlineRadiusMm;
  if (outgoingTangentZ < bottomClearCenterZ - TOLERANCE_MM) {
    return unresolved('small-beam-90deg-bend-exceeds-support-depth', {
      barDiaMm,
      smallBeamTopZ,
      supportTopZ,
      smallBeamBarCenterZ,
      outgoingTangentZ,
      topClearCenterZ,
      bottomClearCenterZ,
      ...bendRule,
    });
  }

  const availableTailMm = Math.max(0, outgoingTangentZ - bottomClearCenterZ);
  return {
    resolved: true,
    reason: null,
    source: 'R12-small-beam-tail-availability',
    standardId: REBAR_STANDARD_RULES.standardId,
    bendDirection: 'DOWN',
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
    availableTailMm,
  };
}
