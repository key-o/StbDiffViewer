/**
 * @fileoverview R13 基礎梁主筋の定着先となる StbFoundationColumn FD の
 * コンクリート強度を ST-Bridge の正規優先順位で解決する。
 *
 * StbFoundationColumn 自体には strength_concrete 属性がないため、FD については
 * 1. id_section_FD -> StbSecColumn_RC.strength_concrete
 * 2. id_node が所属する StbStory.strength_concrete
 * 3. StbCommon.strength_concrete
 * の順で解決する。WR は FD と別領域なので、この resolver では代替に使わない。
 */

import { createTagScanner, findElementById } from '../columnSupportUtils.js';

function readStrength(element) {
  const value = element?.getAttribute?.('strength_concrete');
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function storyContainsNode(story, nodeId) {
  if (!story || !nodeId) return false;
  const nodeIds = story.getElementsByTagName?.('StbNodeId') || [];
  for (let i = 0; i < nodeIds.length; i += 1) {
    if (String(nodeIds[i].getAttribute?.('id') || '') === String(nodeId)) return true;
  }
  return false;
}

function unresolved(reason, extra = {}) {
  return {
    status: 'UNRESOLVED',
    resolved: false,
    value: null,
    source: null,
    blockers: [reason],
    ...extra,
  };
}

function ready(value, source, extra = {}) {
  return {
    status: 'READY',
    resolved: true,
    value,
    source,
    blockers: [],
    ...extra,
  };
}

/**
 * @param {Document} xmlDoc STB XML document
 * @param {Object} endFact foundationBeamTopologyFacts の endpoint fact
 * @param {Object} [options]
 * @param {function(string):Element[]} [options.scanTag]
 * @param {Object|null} [options.index=null]
 * @returns {{status:string,resolved:boolean,value:string|null,source:string|null,blockers:string[]}}
 */
export function resolveFoundationBeamSupportConcreteStrength(xmlDoc, endFact, options = {}) {
  if (!xmlDoc) return unresolved('foundation-support-concrete-document-missing');
  if (!endFact?.resolved) {
    return unresolved('foundation-support-concrete-topology-unresolved', {
      topologyReasons: [...(endFact?.reasons || [])],
    });
  }
  if (endFact.primaryContext !== 'FOUNDATION_COLUMN' || !endFact.foundationColumn) {
    return unresolved('foundation-support-concrete-context-not-foundation-column', {
      primaryContext: endFact?.primaryContext || 'UNRESOLVED',
    });
  }

  const sectionId = endFact.foundationColumn.sectionFdId || null;
  if (!sectionId) {
    return unresolved('foundation-support-concrete-fd-section-id-missing', {
      foundationColumnId: endFact.foundationColumn.id || null,
    });
  }

  const scanTag = options.scanTag || createTagScanner(xmlDoc);
  const section = findElementById(scanTag, 'StbSecColumn_RC', sectionId, options.index || null);
  if (!section) {
    return unresolved('foundation-support-concrete-fd-section-not-found', {
      foundationColumnId: endFact.foundationColumn.id || null,
      sectionFdId: String(sectionId),
    });
  }

  const sectionStrength = readStrength(section);
  if (sectionStrength) {
    return ready(sectionStrength, 'foundation-column-fd-section', {
      sectionFdId: String(sectionId),
      foundationColumnId: endFact.foundationColumn.id || null,
      storyId: null,
      storyName: null,
    });
  }

  const nodeId = endFact.nodeId || endFact.node?.id || null;
  if (nodeId) {
    const story = scanTag('StbStory').find((candidate) => storyContainsNode(candidate, nodeId));
    const storyStrength = readStrength(story);
    if (storyStrength) {
      return ready(storyStrength, 'story', {
        sectionFdId: String(sectionId),
        foundationColumnId: endFact.foundationColumn.id || null,
        storyId: story.getAttribute('id') || null,
        storyName: story.getAttribute('name') || null,
      });
    }
  }

  const common = scanTag('StbCommon')[0] || null;
  const commonStrength = readStrength(common);
  if (commonStrength) {
    return ready(commonStrength, 'common', {
      sectionFdId: String(sectionId),
      foundationColumnId: endFact.foundationColumn.id || null,
      storyId: null,
      storyName: null,
    });
  }

  return unresolved('foundation-support-concrete-strength-unresolved', {
    sectionFdId: String(sectionId),
    foundationColumnId: endFact.foundationColumn.id || null,
    nodeId,
  });
}

export const _foundationBeamSupportConcreteStrengthInternals = Object.freeze({
  readStrength,
  storyContainsNode,
});
