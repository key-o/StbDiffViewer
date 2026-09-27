/**
 * @fileoverview R12 小梁端の支持種別を STB 明示情報・接続topologyから facts 化する。
 *
 * geometry や定着長さはここでは決めない。StbNode.kind / id_member の明示リンクを最優先し、
 * 明示リンクを持たない節点だけ、接続部材が一意な場合に限って topology から解決する。
 * 複数候補が競合する場合は推定せず unresolved とする。
 * StbSecBeam_RC.isCanti=true の小梁では、仕様上片持ち小梁先端に用いられる
 * ON_CANTI / OTHER 節点を FREE_END として扱うが、接続支持候補が無い場合に限り、
 * かつ自由端が1端に一意化できる場合だけ採用する。
 *
 * @module data/extractors/rebar3d/smallBeamSupportFacts
 */

import { extractRcBeamSectionDetail } from '../beamSectionList/sectionDetail.js';
import { createTagScanner, findElementById } from '../columnSupportUtils.js';
import { querySelector } from '../sectionListUtils.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';

const END_SPECS = [
  { side: 'start', nodeAttr: 'id_node_start' },
  { side: 'end', nodeAttr: 'id_node_end' },
];

const EXPLICIT_SUPPORT_KIND = Object.freeze({
  ON_GIRDER: { supportType: 'GIRDER', supportTag: 'StbGirder' },
  ON_BEAM: { supportType: 'BEAM', supportTag: 'StbBeam' },
  ON_COLUMN: { supportType: 'COLUMN', supportTag: 'StbColumn' },
  ON_POST: { supportType: 'COLUMN', supportTag: 'StbPost' },
});

function readBooleanAttribute(element, name) {
  const value = String(element?.getAttribute?.(name) ?? '')
    .trim()
    .toLowerCase();
  return value === 'true' || value === '1';
}

function unresolvedEnd(side, nodeId, nodeKind, linkedMemberId, reason, candidates = []) {
  return {
    side,
    nodeId,
    nodeKind,
    linkedMemberId,
    supportType: 'UNRESOLVED',
    supportTag: null,
    supportId: null,
    supportName: null,
    supportStructure: null,
    source: 'R12-small-beam-support-facts',
    resolved: false,
    reason,
    candidates,
  };
}

function freeEnd(side, nodeId, nodeKind) {
  return {
    side,
    nodeId,
    nodeKind,
    linkedMemberId: null,
    supportType: 'FREE_END',
    supportTag: null,
    supportId: null,
    supportName: null,
    supportStructure: null,
    source: 'stb-section-isCanti+node-kind',
    resolved: true,
    reason: null,
    candidates: [],
  };
}

function resolvedEnd(
  side,
  nodeId,
  nodeKind,
  linkedMemberId,
  supportType,
  supportTag,
  support,
  source,
  candidates = [],
) {
  const supportStructure =
    String(support.getAttribute('kind_structure') || '').toUpperCase() || null;
  if (supportStructure && supportStructure !== 'RC') {
    return unresolvedEnd(
      side,
      nodeId,
      nodeKind,
      linkedMemberId,
      `unsupported-support-structure:${supportStructure}`,
      candidates,
    );
  }

  return {
    side,
    nodeId,
    nodeKind,
    linkedMemberId,
    supportType,
    supportTag,
    supportId: support.getAttribute('id') || linkedMemberId,
    supportName: support.getAttribute('name') || null,
    supportStructure,
    source,
    resolved: true,
    reason: null,
    candidates,
  };
}

function resolveSectionFacts(scanTag, beamEl, index = null) {
  const sectionId = beamEl.getAttribute('id_section') || null;
  const section = sectionId ? findElementById(scanTag, 'StbSecBeam_RC', sectionId, index) : null;
  if (!section) {
    return {
      sectionId,
      sectionName: null,
      isCanti: false,
      isFoundation: false,
      resolved: false,
      reason: sectionId ? 'rc-beam-section-not-found' : 'missing-section-id',
    };
  }

  const detail = extractRcBeamSectionDetail(section);
  return {
    sectionId,
    sectionName: detail.name || null,
    isCanti: detail.isCanti === true,
    isFoundation: detail.isFoundation === true,
    resolved: true,
    reason: null,
  };
}

function nodeOrderContains(element, nodeId) {
  const order = querySelector(element, 'StbNodeIdOrder');
  if (!order?.textContent) return false;
  return order.textContent.trim().split(/\s+/).includes(String(nodeId));
}

function supportConnectionAtNode(element, supportTag, nodeId) {
  if (!element || !nodeId) return null;
  const id = String(nodeId);

  if (supportTag === 'StbColumn' || supportTag === 'StbPost') {
    if (element.getAttribute('id_node_top') === id) return 'top';
    if (element.getAttribute('id_node_bottom') === id) return 'bottom';
  } else {
    if (element.getAttribute('id_node_start') === id) return 'start';
    if (element.getAttribute('id_node_end') === id) return 'end';
  }

  return nodeOrderContains(element, id) ? 'via' : null;
}

function supportCandidate(element, supportType, supportTag, connection) {
  return {
    supportType,
    supportTag,
    supportId: element.getAttribute('id') || null,
    supportName: element.getAttribute('name') || null,
    supportStructure: String(element.getAttribute('kind_structure') || '').toUpperCase() || null,
    connection,
    element,
  };
}

function collectIndexedSupportCandidates(index, beamEl, nodeId) {
  if (!(index?.beamsByNodeId instanceof Map) || !(index?.columnsByNodeId instanceof Map)) {
    return null;
  }

  const candidates = [];
  const beamId = beamEl.getAttribute('id');
  for (const connection of index.beamsByNodeId.get(String(nodeId)) || []) {
    if (connection.tagName !== 'StbGirder' && connection.tagName !== 'StbBeam') continue;
    if (connection.tagName === 'StbBeam' && connection.element.getAttribute('id') === beamId)
      continue;
    candidates.push(
      supportCandidate(
        connection.element,
        connection.tagName === 'StbGirder' ? 'GIRDER' : 'BEAM',
        connection.tagName,
        connection.endpoint,
      ),
    );
  }

  for (const connection of index.columnsByNodeId.get(String(nodeId))?.connected || []) {
    if (connection.tagName !== 'StbColumn' && connection.tagName !== 'StbPost') continue;
    candidates.push(
      supportCandidate(connection.element, 'COLUMN', connection.tagName, connection.endpoint),
    );
  }
  return candidates;
}

function collectConnectedSupportCandidates(scanTag, beamEl, nodeId, index = null) {
  const indexed = collectIndexedSupportCandidates(index, beamEl, nodeId);
  if (indexed) return indexed;

  const candidates = [];
  const beamId = beamEl.getAttribute('id');

  for (const girder of scanTag('StbGirder')) {
    const connection = supportConnectionAtNode(girder, 'StbGirder', nodeId);
    if (connection) {
      candidates.push(supportCandidate(girder, 'GIRDER', 'StbGirder', connection));
    }
  }

  for (const otherBeam of scanTag('StbBeam')) {
    if (otherBeam.getAttribute('id') === beamId) continue;
    const connection = supportConnectionAtNode(otherBeam, 'StbBeam', nodeId);
    if (connection) {
      candidates.push(supportCandidate(otherBeam, 'BEAM', 'StbBeam', connection));
    }
  }

  for (const supportTag of ['StbColumn', 'StbPost']) {
    for (const column of scanTag(supportTag)) {
      const connection = supportConnectionAtNode(column, supportTag, nodeId);
      if (connection) {
        candidates.push(supportCandidate(column, 'COLUMN', supportTag, connection));
      }
    }
  }

  return candidates;
}

function publicCandidate(candidate) {
  const publicFact = { ...candidate };
  delete publicFact.element;
  return publicFact;
}

function resolveSmallBeamEndSupport(scanTag, beamEl, endSpec, sectionFacts, index = null) {
  const nodeId = beamEl.getAttribute(endSpec.nodeAttr);
  if (!nodeId) {
    return unresolvedEnd(endSpec.side, null, null, null, 'missing-end-node-id');
  }

  const node = findElementById(scanTag, 'StbNode', nodeId, index);
  if (!node) {
    return unresolvedEnd(endSpec.side, nodeId, null, null, 'end-node-not-found');
  }

  const nodeKind = String(node.getAttribute('kind') || '').toUpperCase() || null;
  const linkedMemberId = node.getAttribute('id_member') || null;
  const explicit = EXPLICIT_SUPPORT_KIND[nodeKind];

  if (explicit) {
    if (!linkedMemberId) {
      return unresolvedEnd(
        endSpec.side,
        nodeId,
        nodeKind,
        null,
        `${explicit.supportType.toLowerCase()}-link-id-missing`,
      );
    }
    const support = findElementById(scanTag, explicit.supportTag, linkedMemberId, index);
    if (!support) {
      return unresolvedEnd(
        endSpec.side,
        nodeId,
        nodeKind,
        linkedMemberId,
        `linked-${explicit.supportType.toLowerCase()}-not-found`,
      );
    }

    // ON_GIRDER + id_member は支持関係そのものを表す明示semanticであり、
    // 小梁接続点が大梁のendpoint/via nodeへ重複登録されることは要求しない。
    // 実際に支持矩形と交差するかは support-face geometry 側で検証する。
    if (explicit.supportType !== 'GIRDER') {
      const explicitConnection = supportConnectionAtNode(support, explicit.supportTag, nodeId);
      if (!explicitConnection) {
        return unresolvedEnd(
          endSpec.side,
          nodeId,
          nodeKind,
          linkedMemberId,
          `linked-${explicit.supportType.toLowerCase()}-not-connected-at-node`,
        );
      }
    }

    return resolvedEnd(
      endSpec.side,
      nodeId,
      nodeKind,
      linkedMemberId,
      explicit.supportType,
      explicit.supportTag,
      support,
      'stb-node-kind-id-member',
    );
  }

  const candidates = collectConnectedSupportCandidates(scanTag, beamEl, nodeId, index);
  const publicCandidates = candidates.map(publicCandidate);

  if (
    sectionFacts.resolved &&
    sectionFacts.isCanti &&
    ['OTHER', 'ON_CANTI'].includes(nodeKind) &&
    candidates.length === 0
  ) {
    return freeEnd(endSpec.side, nodeId, nodeKind);
  }

  if (candidates.length === 1) {
    const candidate = candidates[0];
    return resolvedEnd(
      endSpec.side,
      nodeId,
      nodeKind,
      linkedMemberId,
      candidate.supportType,
      candidate.supportTag,
      candidate.element,
      'connected-topology',
      publicCandidates,
    );
  }

  if (candidates.length > 1) {
    return unresolvedEnd(
      endSpec.side,
      nodeId,
      nodeKind,
      linkedMemberId,
      'support-candidates-ambiguous',
      publicCandidates,
    );
  }

  return unresolvedEnd(
    endSpec.side,
    nodeId,
    nodeKind,
    linkedMemberId,
    `support-kind-not-explicit:${nodeKind || 'UNKNOWN'}`,
  );
}

/**
 * RC小梁ごとの端部支持 facts を構築する。
 *
 * RC と明示された StbBeam、および kind_structure 欠損の互換入力を対象とする。
 * S/SRC 等の小梁は R12 の対象外として読み飛ばす。
 *
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @param {function(string): Element[]} [sharedScanTag] - 共有タグ走査関数
 * @param {Object|null} [sharedIndex] - 共有RebarModelIndex
 * @returns {{beam:Map<string,Object>, unresolved:Array<Object>}}
 */
export function buildSmallBeamSupportFacts(xmlDoc, sharedScanTag = null, sharedIndex = null) {
  const beam = new Map();
  const unresolved = [];
  if (!xmlDoc) return { beam, unresolved };

  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const modelIndex = sharedIndex || buildRebarModelIndex(xmlDoc, { scanTag });
  for (const beamEl of scanTag('StbBeam')) {
    const kindStructure = String(beamEl.getAttribute('kind_structure') || '').toUpperCase();
    if (kindStructure && kindStructure !== 'RC') continue;

    const elementId = beamEl.getAttribute('id');
    if (!elementId) continue;

    const sectionFacts = resolveSectionFacts(scanTag, beamEl, modelIndex);
    const isFoundation =
      readBooleanAttribute(beamEl, 'isFoundation') || sectionFacts.isFoundation === true;
    const ends = END_SPECS.map((endSpec) =>
      resolveSmallBeamEndSupport(scanTag, beamEl, endSpec, sectionFacts, modelIndex),
    );
    const freeEndCount = ends.filter((end) => end.supportType === 'FREE_END').length;
    const cantileverTopologyResolved = !sectionFacts.isCanti || freeEndCount === 1;
    const facts = {
      elementId,
      elementName: beamEl.getAttribute('name') || null,
      sectionId: sectionFacts.sectionId,
      sectionName: sectionFacts.sectionName,
      memberTag: 'StbBeam',
      isCanti: sectionFacts.isCanti,
      isFoundation,
      sectionResolved: sectionFacts.resolved,
      sectionUnresolvedReason: sectionFacts.reason,
      source: 'R12-small-beam-support-facts',
      ends,
      resolved: cantileverTopologyResolved && ends.every((end) => end.resolved),
    };
    beam.set(elementId, facts);

    if (sectionFacts.isCanti && !cantileverTopologyResolved) {
      unresolved.push({
        elementId,
        elementName: facts.elementName,
        side: null,
        reason: `cantilever-free-end-count:${freeEndCount}`,
        source: 'stb-section-isCanti+node-kind',
      });
    }
    for (const end of ends) {
      if (!end.resolved) {
        unresolved.push({
          elementId,
          elementName: facts.elementName,
          ...end,
        });
      }
    }
  }

  return { beam, unresolved };
}
