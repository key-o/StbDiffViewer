/**
 * @fileoverview §6-3 additional reinforcement の標準長計算に必要な
 * beam/foundation concrete strength と D16 reinforcement grade を ST-Bridge から解決する。
 *
 * RC梁断面・RC基礎断面の strength_concrete 省略規則は各 ST-Bridge 要素リファレンスに従い、
 * 断面明示値 > 参照節点所属 Story > StbCommon の順で解決する。
 * D16 strength は既存 reinforcementStrengthResolver の common径別定義を利用する。
 */

import { findElementById } from '../columnSupportUtils.js';
import { resolveReinforcementStrength } from '../reinforcementStrengthResolver.js';

const SOURCE = 'R13-foundation-beam-foundation-interaction-material-facts-2023';

function outcome(status, reason, extra = {}) {
  return {
    status,
    resolved: status === 'READY',
    reason: reason || null,
    blockers: reason ? [reason] : [],
    source: SOURCE,
    ...extra,
  };
}
function ready(extra = {}) {
  return outcome('READY', null, extra);
}
function unresolved(reason, extra = {}) {
  return outcome('UNRESOLVED', reason, extra);
}
function invalid(reason, extra = {}) {
  return outcome('INVALID', reason, extra);
}
function textAttribute(element, name) {
  const raw = element?.getAttribute?.(name);
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  return text || null;
}
function storyContainsNode(story, nodeId) {
  return Array.from(story?.getElementsByTagName?.('StbNodeId') || []).some(
    (entry) => String(entry.getAttribute?.('id') || '') === String(nodeId || ''),
  );
}
function resolveStoryForNode(scanTag, nodeId) {
  if (!nodeId) return unresolved('foundation-interaction-material-node-id-missing');
  const stories = scanTag('StbStory').filter((story) => storyContainsNode(story, nodeId));
  if (stories.length !== 1) {
    return unresolved(
      stories.length === 0
        ? 'foundation-interaction-material-story-not-found'
        : 'foundation-interaction-material-story-ambiguous',
      { nodeId: String(nodeId), storyCount: stories.length },
    );
  }
  return ready({ story: stories[0], storyId: textAttribute(stories[0], 'id') });
}
function resolveConcreteStrength({ scanTag, sectionTag, sectionId, nodeId, role, index = null }) {
  if (!sectionId) return unresolved(`foundation-interaction-${role}-section-id-missing`);
  const section = findElementById(scanTag, sectionTag, sectionId, index);
  if (!section) {
    return unresolved(`foundation-interaction-${role}-section-not-found`, { sectionId });
  }
  const sectionValue = textAttribute(section, 'strength_concrete');
  if (sectionValue) {
    return ready({
      value: sectionValue,
      basis: `${role.toUpperCase()}_SECTION`,
      sectionId: String(sectionId),
      storyId: null,
    });
  }

  const story = resolveStoryForNode(scanTag, nodeId);
  if (!story.resolved) return story;
  const storyValue = textAttribute(story.story, 'strength_concrete');
  if (storyValue) {
    return ready({
      value: storyValue,
      basis: 'STORY',
      sectionId: String(sectionId),
      storyId: story.storyId,
    });
  }

  const common = scanTag('StbCommon');
  if (common.length !== 1) {
    return unresolved(
      common.length === 0
        ? 'foundation-interaction-common-not-found'
        : 'foundation-interaction-common-ambiguous',
      { commonCount: common.length },
    );
  }
  const commonValue = textAttribute(common[0], 'strength_concrete');
  if (!commonValue) return unresolved('foundation-interaction-common-concrete-strength-missing');
  return ready({
    value: commonValue,
    basis: 'COMMON',
    sectionId: String(sectionId),
    storyId: story.storyId,
  });
}

/**
 * @returns {{status:string,resolved:boolean,beamConcreteStrength?:Object,foundationConcreteStrength?:Object,additionalTie?:Object}}
 */
export function resolveFoundationBeamFoundationInteractionMaterialFacts2023({
  scanTag,
  beamEl,
  endFact,
  stepGeometry,
  index = null,
} = {}) {
  if (typeof scanTag !== 'function')
    return invalid('foundation-interaction-material-scan-tag-missing');
  if (!beamEl) return unresolved('foundation-interaction-material-beam-element-missing');
  if (!endFact?.resolved)
    return unresolved('foundation-interaction-material-end-topology-unresolved');
  if (stepGeometry?.status !== 'READY') {
    return unresolved('foundation-interaction-material-step-geometry-unresolved');
  }

  const beamSectionId = stepGeometry.beamSectionId || beamEl.getAttribute?.('id_section') || null;
  const foundationSectionId = stepGeometry.footingSectionId || endFact?.footing?.sectionId || null;
  const nodeId = endFact.nodeId || beamEl.getAttribute?.('id_node_start') || null;
  const beamConcreteStrength = resolveConcreteStrength({
    scanTag,
    sectionTag: 'StbSecBeam_RC',
    sectionId: beamSectionId,
    nodeId,
    role: 'beam',
    index,
  });
  if (!beamConcreteStrength.resolved) return beamConcreteStrength;

  const foundationConcreteStrength = resolveConcreteStrength({
    scanTag,
    sectionTag: 'StbSecFoundation_RC',
    sectionId: foundationSectionId,
    nodeId,
    role: 'foundation',
    index,
  });
  if (!foundationConcreteStrength.resolved) return foundationConcreteStrength;

  const d16 = resolveReinforcementStrength({ element: beamEl, diameter: 'D16' });
  if (!d16.value) {
    return unresolved('foundation-interaction-additional-tie-D16-grade-unresolved', {
      designation: 'D16',
    });
  }

  return ready({
    side: endFact.side || null,
    nodeId: String(nodeId || ''),
    beamSectionId: String(beamSectionId || ''),
    foundationSectionId: String(foundationSectionId || ''),
    beamConcreteStrength,
    foundationConcreteStrength,
    additionalTie: {
      designation: 'D16',
      diaMm: 16,
      grade: d16.value,
      gradeSource: d16.source,
    },
  });
}

export const _foundationBeamFoundationInteractionMaterialFacts2023Internals = Object.freeze({
  storyContainsNode,
  resolveStoryForNode,
  resolveConcreteStrength,
});
