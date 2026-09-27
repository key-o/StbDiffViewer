/**
 * @fileoverview foundationBeamEndBarFacts に日建連2023標準図のbar-level定着requirementを付加する。
 *
 * endBarFactsが保持する type / 標準候補値を、topology由来の基礎形式とproject detailingの
 * 浮上り条件と組み合わせる。元factsは変更せず、新しいMap/objectを返す。
 */

import { getRebarProjectDetailing } from '../../../config/rebarProjectDetailing.js';
import { resolveFoundationBeamAnchorageRequirement2023 } from './foundationBeamAnchorageRequirement2023.js';
import { resolveFoundationBeamFoundationSystem } from './foundationBeamFoundationSystem.js';
import { resolveFoundationBeamUplift } from './foundationBeamUpliftResolver.js';

function bySide(ends) {
  const map = new Map();
  for (const end of ends || []) {
    if (end?.side === 'start' || end?.side === 'end') map.set(end.side, end);
  }
  return map;
}

function unresolvedFromEnd(end) {
  return {
    status: 'UNRESOLVED',
    resolved: false,
    requiredAnchorageMm: null,
    blockers: [
      end?.anchorageRequirementReason ||
        end?.anchorageTypeResolution?.blockers?.[0] ||
        'foundation-anchorage-type-unresolved',
    ],
  };
}

function standardCandidatesFromBar(bar) {
  if (bar?.standardAnchorageCandidatesResolved === true && bar.standardAnchorageCandidates) {
    return {
      status: 'READY',
      resolved: true,
      blockers: [],
      candidates: bar.standardAnchorageCandidates,
    };
  }
  return {
    status: 'UNRESOLVED',
    resolved: false,
    blockers: [...(bar?.standardAnchorageCandidateBlockers || [])],
    candidates: bar?.standardAnchorageCandidates || null,
  };
}

function requirementReason(resolutions) {
  const unresolved = resolutions.find((item) => !item?.resolved);
  return unresolved?.blockers?.[0] || null;
}

function enrichEnd(end, topologyEnd, beamFact, projectDetailing) {
  if (!end) return end;
  const target = {
    elementId: beamFact.elementId,
    sectionId: beamFact.sectionId,
    memberTag: beamFact.memberTag,
    side: end.side,
  };
  const upliftResolution = resolveFoundationBeamUplift(projectDetailing, target);
  const foundationSystemResolution = resolveFoundationBeamFoundationSystem(topologyEnd || {});
  const uplift = upliftResolution.resolved ? upliftResolution.uplift : null;
  const foundationSystem = foundationSystemResolution.resolved
    ? foundationSystemResolution.foundationSystem
    : null;

  const requirementResolutions = (end.bars || []).map((bar) => {
    if (end.anchorageTypeResolved !== true) return unresolvedFromEnd(end);
    return resolveFoundationBeamAnchorageRequirement2023({
      memberTag: beamFact.memberTag,
      type: end.anchorageType,
      bar,
      standardCandidates: standardCandidatesFromBar(bar),
      uplift,
      foundationSystem,
    });
  });
  const bars = (end.bars || []).map((bar, index) => {
    const requirement = requirementResolutions[index];
    return {
      ...bar,
      requiredAnchorageMm: requirement?.resolved ? requirement.requiredAnchorageMm : null,
      anchorageRequirementResolved: requirement?.resolved === true,
      anchorageRequirementReason: requirement?.resolved
        ? null
        : requirement?.blockers?.[0] || 'foundation-anchorage-requirement-unresolved',
      anchorageRequirementResolution: requirement || null,
    };
  });
  const anchorageRequirementResolved =
    bars.length > 0 && bars.every((bar) => bar.anchorageRequirementResolved === true);

  return {
    ...end,
    bars,
    upliftResolution,
    foundationSystemResolution,
    anchorageRequirementResolutions: requirementResolutions,
    anchorageRequirementResolved,
    anchorageRequirementReason: anchorageRequirementResolved
      ? null
      : requirementReason(requirementResolutions) || end.anchorageRequirementReason || null,
  };
}

/**
 * @param {{beam:Map<string,Object>,unresolved?:Array<Object>}} mainBarFacts
 * @param {{beam:Map<string,Object>}} topologyFacts
 * @param {Object} [options]
 * @param {Object} [options.projectDetailing]
 */
export function applyFoundationBeamAnchorageRequirements2023(
  mainBarFacts,
  topologyFacts,
  options = {},
) {
  if (!(mainBarFacts?.beam instanceof Map) || !(topologyFacts?.beam instanceof Map)) {
    return mainBarFacts;
  }
  const projectDetailing =
    options.projectDetailing === undefined ? getRebarProjectDetailing() : options.projectDetailing;
  const beam = new Map();

  for (const [elementId, sourceBeam] of mainBarFacts.beam) {
    const topology = topologyFacts.beam.get(String(elementId)) || null;
    const topologyBySide = bySide(topology?.ends);
    const beamFact = {
      elementId: String(elementId),
      sectionId: sourceBeam.sectionId ?? topology?.sectionId ?? null,
      memberTag: sourceBeam.memberTag ?? topology?.memberTag ?? null,
    };
    const ends = (sourceBeam.ends || []).map((end) =>
      enrichEnd(end, topologyBySide.get(end.side) || null, beamFact, projectDetailing),
    );
    beam.set(String(elementId), {
      ...sourceBeam,
      ends,
      anchorageRequirementResolved:
        ends.length > 0 && ends.every((end) => end?.anchorageRequirementResolved === true),
    });
  }

  return {
    ...mainBarFacts,
    beam,
  };
}

export const _foundationBeamAnchorageRequirementFacts2023Internals = Object.freeze({
  bySide,
  standardCandidatesFromBar,
  enrichEnd,
  requirementReason,
});
