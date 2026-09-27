/**
 * @fileoverview R13 基礎梁端のあばら筋入力をsupport contextと束ねるread-only facts。
 *
 * STBのRC梁断面から端部positionの D_stirrup / pitch_stirrup / N_stirrup / strength を取得し、
 * foundationBeamTopologyFacts の端部contextへ接続する。基礎柱・基礎・杭・布基礎との
 * 取合い補強要領や追加あばら筋の生成はこのsliceでは決めない。
 */

import { barDiameterMm } from '../../../constants/beamOpeningRules.js';
import { createTagScanner, findElementById } from '../columnSupportUtils.js';
import { extractRcBeamSectionDetail } from '../beamSectionList/sectionDetail.js';
import { orderedPositionKeys } from './rebarSectionUtils.js';

function unresolved(endFact, reason, extra = {}) {
  return {
    side: endFact?.side || null,
    nodeId: endFact?.nodeId || null,
    primaryContext: endFact?.primaryContext || 'UNRESOLVED',
    resolved: false,
    reason,
    source: 'R13-foundation-beam-stirrup-facts',
    stirrup: null,
    interactionRequirementResolved: false,
    ...extra,
  };
}

function resolveEndPosition(detail, side) {
  const keys = orderedPositionKeys(detail);
  if (!keys.length) return null;
  const positionZone = side === 'end' ? keys[keys.length - 1] : keys[0];
  const position = detail.positions?.[positionZone] || null;
  return position ? { positionZone, position } : null;
}

function resolveStirrup(position) {
  const stirrup = position?.stirrup;
  const designation = stirrup?.dia || null;
  const diaMm = designation ? barDiameterMm(designation, 0) : 0;
  const pitchMm = Number(stirrup?.pitch);
  const legCount = Number(stirrup?.count);
  if (!(diaMm > 0)) return { status: 'UNRESOLVED', reason: 'foundation-beam-stirrup-dia-missing' };
  if (!(pitchMm > 0)) {
    return { status: 'UNRESOLVED', reason: 'foundation-beam-stirrup-pitch-missing' };
  }
  if (!Number.isInteger(legCount) || legCount <= 0) {
    return { status: 'UNRESOLVED', reason: 'foundation-beam-stirrup-leg-count-missing' };
  }
  return {
    status: 'READY',
    value: {
      designation,
      diaMm,
      pitchMm,
      legCount,
      grade: stirrup.grade || null,
    },
  };
}

function resolveEnd(detail, endFact) {
  if (!endFact?.resolved) {
    return unresolved(endFact, 'foundation-beam-end-topology-unresolved', {
      topologyReasons: [...(endFact?.reasons || [])],
    });
  }
  const endPosition = resolveEndPosition(detail, endFact.side);
  if (!endPosition) return unresolved(endFact, 'foundation-beam-end-position-unresolved');

  const stirrupResolution = resolveStirrup(endPosition.position);
  if (stirrupResolution.status !== 'READY') {
    return unresolved(endFact, stirrupResolution.reason, {
      positionZone: endPosition.positionZone,
    });
  }

  return {
    side: endFact.side,
    nodeId: endFact.nodeId,
    primaryContext: endFact.primaryContext || 'UNRESOLVED',
    resolved: true,
    reason: null,
    source: 'R13-foundation-beam-stirrup-facts',
    positionZone: endPosition.positionZone,
    beamWidthMm: Number(endPosition.position.width) || null,
    beamDepthMm: Number(endPosition.position.depth) || null,
    stirrup: stirrupResolution.value,
    foundationColumnId: endFact.foundationColumn?.id || null,
    footingId: endFact.footing?.id || null,
    pileId: endFact.pile?.id || null,
    stripFootingIds: (endFact.stripFootings || []).map((item) => item.id).filter(Boolean),
    interactionRequirementResolved: false,
    interactionRequirementReason: 'foundation-beam-stirrup-interaction-rule-not-connected',
  };
}

/**
 * @param {Document} xmlDoc STB XML document
 * @param {{beam:Map<string,Object>}} topologyFacts foundationBeamTopologyFacts
 * @param {Object} [options]
 * @param {function(string): Element[]} [options.scanTag]
 * @param {Object|null} [options.index=null]
 * @returns {{beam:Map<string,Object>,unresolved:Array<Object>}}
 */
export function buildFoundationBeamStirrupFacts(xmlDoc, topologyFacts, options = {}) {
  const beam = new Map();
  const unresolvedFacts = [];
  if (!xmlDoc || !(topologyFacts?.beam instanceof Map))
    return { beam, unresolved: unresolvedFacts };

  const scanTag = options.scanTag || createTagScanner(xmlDoc);
  for (const [elementId, topology] of topologyFacts.beam) {
    const member = findElementById(scanTag, topology.memberTag, elementId, options.index || null);
    const section = topology.sectionId
      ? findElementById(scanTag, 'StbSecBeam_RC', topology.sectionId, options.index || null)
      : null;
    let detail = null;
    let commonReason = null;
    if (!member) commonReason = 'foundation-beam-element-not-found';
    else if (!section) commonReason = 'foundation-beam-rc-section-not-found';
    else detail = extractRcBeamSectionDetail(section);
    if (!commonReason && !detail) commonReason = 'foundation-beam-section-detail-unresolved';

    const ends = (topology.ends || []).map((endFact) =>
      commonReason ? unresolved(endFact, commonReason) : resolveEnd(detail, endFact),
    );
    const fact = {
      elementId: String(elementId),
      elementName: topology.elementName || member?.getAttribute?.('name') || null,
      memberTag: topology.memberTag,
      sectionId: topology.sectionId || null,
      source: 'R13-foundation-beam-stirrup-facts',
      ends,
      resolved: ends.every((end) => end.resolved),
      interactionRequirementResolved: false,
    };
    beam.set(String(elementId), fact);

    for (const end of ends) {
      if (end.resolved) continue;
      unresolvedFacts.push({
        elementId: String(elementId),
        elementName: fact.elementName,
        side: end.side,
        nodeId: end.nodeId,
        reason: end.reason,
        source: fact.source,
      });
    }
  }

  return { beam, unresolved: unresolvedFacts };
}

export const _foundationBeamStirrupFactsInternals = Object.freeze({
  resolveEndPosition,
  resolveStirrup,
});
