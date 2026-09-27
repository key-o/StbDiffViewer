/**
 * @fileoverview R12 小梁定着で参照する支持大梁の局所断面contextを解決する。
 *
 * 支持大梁が等幅なら従来どおり全長共通値を使う。可変断面の場合は、
 * 小梁端節点が支持大梁の START / END に明示的に一致するときだけ
 * 端部断面幅を採用する。ViaNode上の局所幅は補間せず fail-closed とする。
 *
 * R12-Nでは、bar-level投影可能長さのために支持大梁側面のかぶりもfact化する。
 * かぶりはST-Bridgeのdepth_coverを優先し、省略値が明示されている場合はApply条件、
 * それも無い場合だけ呼出側のproject coverを使用する。主筋重心位置はかぶりと混同しない。
 */

import { parseConcreteFc } from '../../../constants/rebarAnchorageRules.js';
import { extractRcBeamSectionDetail } from '../beamSectionList/sectionDetail.js';
import { resolveMemberConcreteStrength } from '../concreteStrengthResolver.js';
import { findElementById } from '../columnSupportUtils.js';
import { querySelector } from '../sectionListUtils.js';
import {
  hasUnsupportedSmallBeamSectionRotation,
  resolveSmallBeamSectionRollDegrees,
} from './smallBeamSectionOrientation.js';

const SUPPORT_GIRDER_ROTATED_SECTION_UNSUPPORTED_REASON =
  'support-girder-rotated-section-r12-unsupported';

function uniquePositive(values) {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))];
}

function nodeOrderContains(element, nodeId) {
  const order = querySelector(element, 'StbNodeIdOrder');
  if (!order?.textContent || !nodeId) return false;
  return order.textContent.trim().split(/\s+/).includes(String(nodeId));
}

function resolveSupportConnection(girder, nodeId) {
  if (!girder || !nodeId) return null;
  if (girder.getAttribute('id_node_start') === String(nodeId)) return 'start';
  if (girder.getAttribute('id_node_end') === String(nodeId)) return 'end';
  if (nodeOrderContains(girder, nodeId)) return 'via';
  return null;
}

function resolveEndpointPosition(detail, connection) {
  const positions = detail?.positions || {};
  const keys = Object.keys(positions);
  if (keys.length === 0) return null;
  if (keys.length === 1) return { key: keys[0], position: positions[keys[0]], sharedEnd: true };

  // END_CENTERはLEFTが両端共通の端部断面、CENTERが中央断面。
  if (detail.positionPattern === 'END_CENTER' && positions.LEFT) {
    return { key: 'LEFT', position: positions.LEFT, sharedEnd: true };
  }

  if (connection === 'start') {
    if (positions.LEFT) return { key: 'LEFT', position: positions.LEFT, sharedEnd: false };
    if (positions.START) return { key: 'START', position: positions.START, sharedEnd: false };
  }
  if (connection === 'end') {
    if (positions.RIGHT) return { key: 'RIGHT', position: positions.RIGHT, sharedEnd: false };
    if (positions.END) return { key: 'END', position: positions.END, sharedEnd: false };
  }
  return null;
}

function baseContext(detail, sectionId, strengthFact) {
  const strengthConcrete = strengthFact?.value || null;
  return {
    fc: parseConcreteFc(strengthConcrete),
    fcSource: strengthFact?.source || null,
    strengthConcrete,
    sectionId,
    sectionName: detail?.name || null,
  };
}

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function metadataValue(cover, key, side) {
  const metadata = cover?.[key];
  if (!metadata) return null;
  return finiteNonNegative(metadata[side] ?? metadata.side);
}

function resolveCoverFromContainer(cover, side) {
  if (!cover) return null;

  const explicit = metadataValue(cover, 'sourceCover', side);
  if (explicit !== null) {
    return { resolved: true, coverMm: explicit, source: 'stb-cover', reason: null };
  }

  const apply = cover.applyDefaults;
  if (apply?.setDefault === true) {
    const applied = finiteNonNegative(apply.sourceCover?.[side] ?? apply.sourceCover?.side);
    if (applied !== null) {
      return { resolved: true, coverMm: applied, source: 'stb-apply-cover', reason: null };
    }
  }

  if (apply?.applicable === false) {
    return {
      resolved: false,
      coverMm: null,
      source: null,
      reason: `support-girder-rebar-position-not-applicable:${side}`,
    };
  }

  // 旧互換coverはcenter_*を含むことがあるため、列挙値そのものは採用しない。
  return null;
}

function resolvePositionCover(detail, position, side, fallbackCoverMm = null) {
  const local = resolveCoverFromContainer(position?.cover, side);
  if (local) return local;

  const shared = resolveCoverFromContainer(detail?.cover, side);
  if (shared) return shared;

  const fallback = finiteNonNegative(fallbackCoverMm);
  if (fallback !== null) {
    return { resolved: true, coverMm: fallback, source: 'project-cover', reason: null };
  }

  return {
    resolved: false,
    coverMm: null,
    source: null,
    reason: `support-girder-side-cover-unresolved:${side}`,
  };
}

function unresolvedCover(side, reason) {
  return { resolved: false, side, coverMm: null, source: null, reason };
}

function resolveUniformCover(detail, side, fallbackCoverMm) {
  const positions = Object.values(detail?.positions || {});
  if (positions.length === 0) {
    return unresolvedCover(side, 'support-girder-rebar-position-unresolved');
  }

  const facts = positions.map((position) =>
    resolvePositionCover(detail, position, side, fallbackCoverMm),
  );
  if (facts.some((fact) => !fact.resolved)) {
    const first = facts.find((fact) => !fact.resolved);
    return unresolvedCover(side, first?.reason || 'support-girder-side-cover-unresolved');
  }

  const values = [...new Set(facts.map((fact) => fact.coverMm))];
  if (values.length !== 1) {
    return unresolvedCover(side, 'support-girder-side-cover-varies-at-via');
  }

  const sources = [...new Set(facts.map((fact) => fact.source).filter(Boolean))];
  return {
    resolved: true,
    side,
    coverMm: values[0],
    source: sources.length === 1 ? sources[0] : 'uniform-mixed-cover-source',
    reason: null,
  };
}

function resolveSupportCoverFacts(detail, supportConnection, fallbackCoverMm) {
  const endpoint =
    supportConnection === 'start' || supportConnection === 'end'
      ? resolveEndpointPosition(detail, supportConnection)
      : null;

  if (endpoint) {
    const left = resolvePositionCover(detail, endpoint.position, 'left', fallbackCoverMm);
    const right = resolvePositionCover(detail, endpoint.position, 'right', fallbackCoverMm);
    const top = resolvePositionCover(detail, endpoint.position, 'top', fallbackCoverMm);
    const bottom = resolvePositionCover(detail, endpoint.position, 'bottom', fallbackCoverMm);
    return {
      positionZone: endpoint.key,
      left: { side: 'left', ...left },
      right: { side: 'right', ...right },
      top: { side: 'top', ...top },
      bottom: { side: 'bottom', ...bottom },
    };
  }

  // ViaNodeや支持節点不詳でも、全位置で同じかぶりなら安全に共通値として採用できる。
  return {
    positionZone: null,
    left: resolveUniformCover(detail, 'left', fallbackCoverMm),
    right: resolveUniformCover(detail, 'right', fallbackCoverMm),
    top: resolveUniformCover(detail, 'top', fallbackCoverMm),
    bottom: resolveUniformCover(detail, 'bottom', fallbackCoverMm),
  };
}

function resolveSupportDepth(detail, supportConnection) {
  const depths = uniquePositive(
    Object.values(detail?.positions || {}).map((position) => Number(position?.depth)),
  );
  if (depths.length === 0) {
    return {
      resolved: false,
      depthMm: null,
      depthsMm: [],
      source: null,
      reason: 'support-girder-depth-missing',
    };
  }
  if (depths.length === 1) {
    return {
      resolved: true,
      depthMm: depths[0],
      depthsMm: depths,
      source: 'uniform-section',
      reason: null,
    };
  }
  if (supportConnection === 'start' || supportConnection === 'end') {
    const endpoint = resolveEndpointPosition(detail, supportConnection);
    const depthMm = Number(endpoint?.position?.depth);
    if (endpoint && depthMm > 0) {
      return {
        resolved: true,
        depthMm,
        depthsMm: depths,
        source: endpoint.sharedEnd ? 'shared-end-section' : 'endpoint-section',
        reason: null,
      };
    }
    return {
      resolved: false,
      depthMm: null,
      depthsMm: depths,
      source: null,
      reason: 'support-girder-endpoint-depth-unresolved',
    };
  }
  return {
    resolved: false,
    depthMm: null,
    depthsMm: depths,
    source: null,
    reason:
      supportConnection === 'via'
        ? 'support-girder-depth-varies-at-via'
        : 'support-girder-depth-varies',
  };
}

/**
 * 支持大梁の幅・Fc・側面かぶりを小梁接続位置で解決する。
 *
 * @param {function(string): Element[]} scanTag
 * @param {Object} supportEnd - smallBeamSupportFacts の端部fact
 * @param {Object} [options]
 * @param {number|null} [options.coverMm] STB側面かぶりが無い場合だけ使うproject fallback
 * @param {Object|null} [options.index] 共有RebarModelIndex
 * @returns {Object} 支持大梁context
 */
export function resolveSmallBeamGirderSupportContext(scanTag, supportEnd, options = {}) {
  if (supportEnd?.supportType !== 'GIRDER' || !supportEnd.supportId) {
    return {
      resolved: false,
      reason: `support-not-girder:${supportEnd?.supportType || 'UNKNOWN'}`,
      supportWidthMm: null,
      fc: null,
    };
  }

  const index = options.index || null;
  const girder = findElementById(scanTag, 'StbGirder', String(supportEnd.supportId), index);
  if (!girder) {
    return { resolved: false, reason: 'support-girder-not-found', supportWidthMm: null, fc: null };
  }

  const supportRotationDegrees = resolveSmallBeamSectionRollDegrees(girder);
  if (hasUnsupportedSmallBeamSectionRotation(girder)) {
    return {
      resolved: false,
      reason: SUPPORT_GIRDER_ROTATED_SECTION_UNSUPPORTED_REASON,
      supportRotationDegrees,
      supportWidthMm: null,
      fc: null,
    };
  }

  const sectionId = girder.getAttribute('id_section') || null;
  let section = sectionId ? findElementById(scanTag, 'StbSecGirder_RC', sectionId, index) : null;
  if (!section && sectionId) {
    section = findElementById(scanTag, 'StbSecBeam_RC', sectionId, index);
  }
  if (!section) {
    return {
      resolved: false,
      reason: sectionId ? 'support-girder-section-not-found' : 'support-girder-section-id-missing',
      supportRotationDegrees,
      supportWidthMm: null,
      fc: null,
    };
  }

  const detail = extractRcBeamSectionDetail(section);
  const strengthFact = resolveMemberConcreteStrength({
    scanTag,
    memberEl: girder,
    sectionStrength: detail?.concrete?.strength || null,
    storyNodeId: girder.getAttribute('id_node_start') || null,
  });
  const base = baseContext(detail, sectionId, strengthFact);
  const widths = uniquePositive(
    Object.values(detail.positions || {}).map((position) => Number(position?.width)),
  );
  const supportConnection = resolveSupportConnection(girder, supportEnd.nodeId);
  const supportCoverByFace = resolveSupportCoverFacts(detail, supportConnection, options.coverMm);
  const supportCoverBySide = {
    left: supportCoverByFace.left,
    right: supportCoverByFace.right,
  };
  const supportDepth = resolveSupportDepth(detail, supportConnection);
  const depthFacts = {
    supportDepthResolved: supportDepth.resolved,
    supportDepthMm: supportDepth.depthMm,
    supportDepthsMm: supportDepth.depthsMm,
    supportDepthSource: supportDepth.source,
    supportDepthReason: supportDepth.reason,
  };
  const rotationFacts = { supportRotationDegrees };

  if (widths.length === 0) {
    return {
      resolved: false,
      reason: 'support-girder-width-missing',
      supportWidthMm: null,
      supportWidthsMm: [],
      supportConnection,
      supportCoverBySide,
      supportCoverByFace,
      ...rotationFacts,
      ...depthFacts,
      ...base,
    };
  }

  if (widths.length === 1) {
    return {
      resolved: true,
      reason: null,
      supportWidthMm: widths[0],
      supportWidthsMm: widths,
      supportConnection,
      supportPositionZone: null,
      supportWidthSource: 'uniform-section',
      supportCoverBySide,
      supportCoverByFace,
      ...rotationFacts,
      ...depthFacts,
      ...base,
    };
  }

  if (!supportConnection) {
    return {
      resolved: false,
      reason: 'support-girder-width-varies',
      supportWidthMm: null,
      supportWidthsMm: widths,
      supportConnection: null,
      supportCoverBySide,
      supportCoverByFace,
      ...rotationFacts,
      ...depthFacts,
      ...base,
    };
  }

  if (supportConnection === 'via') {
    return {
      resolved: false,
      reason: 'support-girder-width-varies-at-via',
      supportWidthMm: null,
      supportWidthsMm: widths,
      supportConnection,
      supportCoverBySide,
      supportCoverByFace,
      ...rotationFacts,
      ...depthFacts,
      ...base,
    };
  }

  const endpoint = resolveEndpointPosition(detail, supportConnection);
  const endpointWidth = Number(endpoint?.position?.width);
  if (!endpoint || !(endpointWidth > 0)) {
    return {
      resolved: false,
      reason: 'support-girder-endpoint-width-unresolved',
      supportWidthMm: null,
      supportWidthsMm: widths,
      supportConnection,
      supportCoverBySide,
      supportCoverByFace,
      ...rotationFacts,
      ...depthFacts,
      ...base,
    };
  }

  return {
    resolved: true,
    reason: null,
    supportWidthMm: endpointWidth,
    supportWidthsMm: widths,
    supportConnection,
    supportPositionZone: endpoint.key,
    supportWidthSource: endpoint.sharedEnd ? 'shared-end-section' : 'endpoint-section',
    supportCoverBySide,
    supportCoverByFace,
    ...rotationFacts,
    ...depthFacts,
    ...base,
  };
}
