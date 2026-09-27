/**
 * @fileoverview Issue #320 / #273 Phase 6b-F:
 * 日建連2023標準図 §6-1 の基礎梁主筋本数差について、
 * world straightで一意な通し筋と、残る非通し筋の定着要求だけをsidecar化する。
 *
 * individual barの一般priorityや新規定着RebarPathは生成しない。
 */

import { createTagScanner, findElementById } from '../columnSupportUtils.js';
import { buildFoundationBeamTopologyFacts } from './foundationBeamTopologyFacts.js';
import { isGirderSection } from './rebarSectionUtils.js';
import {
  girderEndpointBarFacts,
  projectGirderBarToJointFrame,
  resolveGirderEndpointGeometry,
  resolveOpposedGirderFrame,
} from './girderJointTransitionGeometry.js';

const SOURCE = 'NIKKENREN-JSCA-RC-REBAR-STANDARD-2023-SECTION-6-1';
const DEFAULT_POSITION_TOLERANCE_MM = 1e-6;
const OPPOSITE_TOLERANCE = 1e-6;

function text(value, fallback = '') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLayer(value) {
  return finite(value);
}

function normalizeBar(bar, index, side) {
  const diaMm = finite(bar?.diaMm ?? bar?.dia);
  const designation = text(
    bar?.designation ?? bar?.diaName,
    diaMm === null ? 'UNKNOWN' : `D${diaMm}`,
  ).toUpperCase();
  return {
    source: bar,
    side,
    index,
    role: text(bar?.role, 'UNKNOWN').toLowerCase(),
    layer: normalizeLayer(bar?.layer),
    face: text(bar?.face ?? bar?.side, bar?.role || 'UNKNOWN').toUpperCase(),
    diaMm,
    designation,
    grade: text(bar?.grade, '-').trim().toUpperCase(),
    u: finite(bar?.jointTransverseMm ?? bar?.u ?? bar?.localPosition?.u),
    v: finite(bar?.jointElevationMm ?? bar?.v ?? bar?.localPosition?.v),
    identityKey: bar?.identityKey ? String(bar.identityKey) : null,
  };
}

function baseKey(bar) {
  return `${bar.role}|${bar.layer ?? '-'}|${bar.face}`;
}

function semanticKey(bar) {
  return `${baseKey(bar)}|${bar.designation}|${bar.grade}`;
}

function groupBy(values, keyOf) {
  const map = new Map();
  for (const value of values) {
    const key = keyOf(value);
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  }
  return map;
}

function samePosition(a, b, tolerance) {
  if (![a.u, a.v, b.u, b.v].every(Number.isFinite)) return false;
  return Math.abs(a.u - b.u) <= tolerance && Math.abs(a.v - b.v) <= tolerance;
}

function barRef(bar) {
  return (
    bar.identityKey || `${bar.side}:${bar.role}:${bar.layer ?? '-'}:${bar.designation}:${bar.index}`
  );
}

function sortedKeys(mapA, mapB) {
  return [...new Set([...mapA.keys(), ...mapB.keys()])].sort();
}

function anchorFact(bar, reason = 'foundation-beam-count-difference-non-through-bar') {
  return Object.freeze({
    disposition: 'ANCHORAGE_REQUIRED',
    side: bar.side,
    bar: bar.source,
    barRef: barRef(bar),
    reason,
    source: SOURCE,
  });
}

function unresolvedFact(reason, leftBars = [], rightBars = [], extra = {}) {
  return Object.freeze({
    reason,
    leftBarRefs: Object.freeze(leftBars.map(barRef)),
    rightBarRefs: Object.freeze(rightBars.map(barRef)),
    source: SOURCE,
    ...extra,
  });
}

/**
 * 2つの端部bar集合からcount-difference factを作る。
 * world joint座標がある場合はそれを優先し、無い純関数testではu/vを使う。
 */
export function resolveFoundationBeamCountDifference(input = {}, options = {}) {
  const tolerance = Number.isFinite(Number(options.positionToleranceMm))
    ? Math.max(0, Number(options.positionToleranceMm))
    : DEFAULT_POSITION_TOLERANCE_MM;
  const leftContext = Object.freeze({
    memberId: input.left?.memberId === undefined ? null : String(input.left.memberId),
    memberTag: input.left?.memberTag || null,
    side: input.left?.side || null,
  });
  const rightContext = Object.freeze({
    memberId: input.right?.memberId === undefined ? null : String(input.right.memberId),
    memberTag: input.right?.memberTag || null,
    side: input.right?.side || null,
  });
  const leftInput = Array.isArray(input.left?.bars) ? input.left.bars : [];
  const rightInput = Array.isArray(input.right?.bars) ? input.right.bars : [];
  const left = leftInput.map((bar, index) => normalizeBar(bar, index, 'LEFT'));
  const right = rightInput.map((bar, index) => normalizeBar(bar, index, 'RIGHT'));
  const matches = [];
  const anchorageRequired = [];
  const unresolved = [];

  if (!Array.isArray(input.left?.bars) || !Array.isArray(input.right?.bars)) {
    unresolved.push(unresolvedFact('foundation-beam-count-difference-bars-missing', left, right));
  } else {
    const leftByBase = groupBy(left, baseKey);
    const rightByBase = groupBy(right, baseKey);

    for (const base of sortedKeys(leftByBase, rightByBase)) {
      const leftBase = leftByBase.get(base) || [];
      const rightBase = rightByBase.get(base) || [];

      if (leftBase.length === 0) {
        anchorageRequired.push(...rightBase.map((bar) => anchorFact(bar)));
        continue;
      }
      if (rightBase.length === 0) {
        anchorageRequired.push(...leftBase.map((bar) => anchorFact(bar)));
        continue;
      }

      const leftBySemantic = groupBy(leftBase, semanticKey);
      const rightBySemantic = groupBy(rightBase, semanticKey);

      for (const semantic of sortedKeys(leftBySemantic, rightBySemantic)) {
        const leftSemantic = leftBySemantic.get(semantic) || [];
        const rightSemantic = rightBySemantic.get(semantic) || [];

        if (leftSemantic.length === 0 || rightSemantic.length === 0) {
          unresolved.push(
            unresolvedFact(
              'foundation-beam-count-difference-semantic-mismatch',
              leftSemantic,
              rightSemantic,
              { baseKey: base, semanticKey: semantic },
            ),
          );
          continue;
        }

        const leftCandidates = new Map(
          leftSemantic.map((bar) => [
            bar,
            rightSemantic.filter((candidate) => samePosition(bar, candidate, tolerance)),
          ]),
        );
        const rightCandidates = new Map(
          rightSemantic.map((bar) => [
            bar,
            leftSemantic.filter((candidate) => samePosition(candidate, bar, tolerance)),
          ]),
        );
        const usedLeft = new Set();
        const usedRight = new Set();

        for (const leftBar of leftSemantic) {
          const candidates = leftCandidates.get(leftBar) || [];
          if (candidates.length !== 1) continue;
          const rightBar = candidates[0];
          const reverse = rightCandidates.get(rightBar) || [];
          if (reverse.length !== 1 || reverse[0] !== leftBar) continue;
          usedLeft.add(leftBar);
          usedRight.add(rightBar);
          matches.push(
            Object.freeze({
              disposition: 'THROUGH_CANDIDATE',
              leftBar: leftBar.source,
              rightBar: rightBar.source,
              leftBarRef: barRef(leftBar),
              rightBarRef: barRef(rightBar),
              semanticKey: semantic,
              source: SOURCE,
            }),
          );
        }

        const remainingLeft = leftSemantic.filter((bar) => !usedLeft.has(bar));
        const remainingRight = rightSemantic.filter((bar) => !usedRight.has(bar));

        if (remainingLeft.length > 0 && remainingRight.length > 0) {
          unresolved.push(
            unresolvedFact(
              'foundation-beam-count-difference-position-ambiguous',
              remainingLeft,
              remainingRight,
              { baseKey: base, semanticKey: semantic },
            ),
          );
          continue;
        }
        anchorageRequired.push(...remainingLeft.map((bar) => anchorFact(bar)));
        anchorageRequired.push(...remainingRight.map((bar) => anchorFact(bar)));
      }
    }
  }

  matches.sort(
    (a, b) =>
      String(a.semanticKey).localeCompare(String(b.semanticKey)) ||
      String(a.leftBarRef).localeCompare(String(b.leftBarRef)) ||
      String(a.rightBarRef).localeCompare(String(b.rightBarRef)),
  );
  anchorageRequired.sort(
    (a, b) =>
      String(a.side).localeCompare(String(b.side)) ||
      String(a.barRef).localeCompare(String(b.barRef)),
  );

  return Object.freeze({
    status: unresolved.length > 0 ? 'UNRESOLVED' : 'READY',
    resolved: unresolved.length === 0,
    nodeId: input.nodeId === undefined || input.nodeId === null ? null : String(input.nodeId),
    modelSource: input.modelSource || null,
    source: SOURCE,
    left: leftContext,
    right: rightContext,
    leftCount: left.length,
    rightCount: right.length,
    countDifference: left.length - right.length,
    matches: Object.freeze(matches),
    anchorageRequired: Object.freeze(anchorageRequired),
    unresolved: Object.freeze(unresolved),
    geometryMutation: false,
  });
}

function layoutForTopology(scanTag, layoutMaps, topology) {
  const sectionId = topology?.sectionId === null || topology?.sectionId === undefined
    ? null
    : String(topology.sectionId);
  if (!sectionId) return null;
  if (layoutMaps instanceof Map) return layoutMaps.get(sectionId) || null;

  const section =
    findElementById(scanTag, 'StbSecBeam_RC', sectionId) ||
    findElementById(scanTag, 'StbSecGirder_RC', sectionId);
  const useGirderMap = section
    ? isGirderSection(section)
    : topology?.memberTag !== 'StbBeam';
  const primary = useGirderMap ? layoutMaps?.girder : layoutMaps?.beam;
  const fallback = useGirderMap ? layoutMaps?.beam : layoutMaps?.girder;
  return primary?.get?.(sectionId) || fallback?.get?.(sectionId) || null;
}

function endpointKey(entry) {
  return `${entry.memberTag}:${entry.memberId}:${entry.side}`;
}

function resolveColumnMediation(end) {
  const foundationColumns = Array.isArray(end?.foundationColumns)
    ? end.foundationColumns
    : end?.foundationColumn
      ? [end.foundationColumn]
      : [];
  const columnsAbove = Array.isArray(end?.columnsAbove) ? end.columnsAbove : [];

  if (foundationColumns.length > 1) {
    return {
      applicable: true,
      resolved: false,
      basis: null,
      reasons: ['multiple-foundation-columns-at-node'],
    };
  }
  if (foundationColumns.length === 1) {
    return { applicable: true, resolved: true, basis: 'FOUNDATION_COLUMN', reasons: [] };
  }
  if (columnsAbove.length > 1) {
    return {
      applicable: true,
      resolved: false,
      basis: null,
      reasons: ['multiple-columns-above-at-node'],
    };
  }
  if (columnsAbove.length === 1) {
    return { applicable: true, resolved: true, basis: 'COLUMN', reasons: [] };
  }
  return { applicable: false, resolved: false, basis: null, reasons: [] };
}

function hasColumnMediationCandidate(end) {
  return resolveColumnMediation(end).applicable;
}

function isColumnMediatedEnd(end) {
  const mediation = resolveColumnMediation(end);
  return mediation.applicable && mediation.resolved;
}

function hasBaseCountDifference(leftBars, rightBars) {
  const countByBase = (bars) => {
    const counts = new Map();
    for (const [index, bar] of (bars || []).entries()) {
      const normalized = normalizeBar(bar, index, 'COUNT');
      const key = baseKey(normalized);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  };
  const left = countByBase(leftBars);
  const right = countByBase(rightBars);
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    if ((left.get(key) || 0) !== (right.get(key) || 0)) return true;
  }
  return false;
}

function endpointSegment(layout, side) {
  const segments = layout?.segments || [];
  if (!segments.length) return null;
  return side === 'end' ? segments.at(-1) : segments[0];
}

function endpointMainBarUnresolvedReasons(layout, side) {
  const segment = endpointSegment(layout, side);
  return (segment?.unresolved || [])
    .map(String)
    .filter((reason) => !reason.startsWith('web-bar-'));
}

function makeEndpointEntry(scanTag, topology, end, layoutMaps) {
  const layout = layoutForTopology(scanTag, layoutMaps, topology);
  const member = findElementById(scanTag, topology.memberTag, String(topology.elementId));
  if (!member || !layout) {
    return {
      memberId: String(topology.elementId),
      memberTag: topology.memberTag,
      side: end.side,
      nodeId: String(end.nodeId),
      geometry: null,
      bars: [],
      reason: !member
        ? 'foundation-beam-count-difference-member-missing'
        : 'foundation-beam-count-difference-layout-missing',
    };
  }

  const mainBarUnresolved = endpointMainBarUnresolvedReasons(layout, end.side);
  if (mainBarUnresolved.length > 0) {
    return {
      memberId: String(topology.elementId),
      memberTag: topology.memberTag,
      side: end.side,
      nodeId: String(end.nodeId),
      geometry: null,
      bars: [],
      reason: 'foundation-beam-count-difference-main-bar-layout-unresolved',
      mainBarUnresolved,
    };
  }

  const geometry = resolveGirderEndpointGeometry(scanTag, member, layout, end.side);
  const bars = geometry ? girderEndpointBarFacts(member, layout, geometry) : [];
  const invalidWorld = bars.some(
    (bar) => !Object.values(bar?.worldPosition || {}).every(Number.isFinite),
  );
  return {
    memberId: String(topology.elementId),
    memberTag: topology.memberTag,
    side: end.side,
    nodeId: String(end.nodeId),
    geometry,
    bars,
    reason:
      !geometry || !bars.length || invalidWorld
        ? 'foundation-beam-count-difference-endpoint-geometry-unresolved'
        : null,
  };
}

function pairEntriesAtNode(entries) {
  const invalid = entries.filter((entry) => entry.reason);
  if (invalid.length > 0 && entries.length > 1) {
    return {
      pairs: [],
      unresolvedReason: invalid.map((entry) => `${endpointKey(entry)}:${entry.reason}`).join(';'),
    };
  }
  const valid = entries.filter((entry) => !entry.reason);
  const candidates = new Map();
  for (const entry of valid) {
    candidates.set(
      entry,
      valid.filter(
        (other) =>
          other !== entry &&
          Boolean(resolveOpposedGirderFrame(entry.geometry, other.geometry, OPPOSITE_TOLERANCE)),
      ),
    );
  }
  if ([...candidates.values()].some((items) => items.length > 1)) {
    return {
      pairs: [],
      unresolvedReason: 'foundation-beam-count-difference-opposite-pair-ambiguous',
    };
  }

  const pairs = [];
  const used = new Set();
  for (const entry of valid) {
    if (used.has(entry)) continue;
    const opposite = candidates.get(entry) || [];
    if (opposite.length !== 1) continue;
    const other = opposite[0];
    const reverse = candidates.get(other) || [];
    if (reverse.length !== 1 || reverse[0] !== entry) continue;
    const frame = resolveOpposedGirderFrame(entry.geometry, other.geometry, OPPOSITE_TOLERANCE);
    if (!frame) continue;
    const ordered =
      endpointKey(entry).localeCompare(endpointKey(other)) <= 0 ? [entry, other] : [other, entry];
    pairs.push({ left: ordered[0], right: ordered[1], frame });
    used.add(entry);
    used.add(other);
  }
  return { pairs, unresolvedReason: null };
}

/**
 * current STB + beam layoutからfoundation count-difference sidecarを構築する。
 * role/layer/face別に本数差がないpairは既存continuity resolverへ委ねる。
 */
export function buildFoundationBeamCountDifferenceSnapshot(xmlDoc, layoutMaps, options = {}) {
  const joints = [];
  const unresolved = [];
  const girderMap = layoutMaps instanceof Map ? layoutMaps : layoutMaps?.girder;
  const beamMap = layoutMaps instanceof Map ? new Map() : layoutMaps?.beam;
  if (
    !xmlDoc ||
    !(
      (girderMap instanceof Map && girderMap.size > 0) ||
      (beamMap instanceof Map && beamMap.size > 0)
    )
  ) {
    return Object.freeze({ joints: Object.freeze(joints), unresolved: Object.freeze(unresolved) });
  }

  const scanTag = options.scanTag || createTagScanner(xmlDoc);
  const topologyFacts = buildFoundationBeamTopologyFacts(xmlDoc, scanTag);
  const byNode = new Map();

  const topologyEntries =
    Array.isArray(topologyFacts.entries) && topologyFacts.entries.length > 0
      ? topologyFacts.entries
      : [...topologyFacts.beam.values()];
  for (const topology of topologyEntries) {
    for (const end of topology.ends || []) {
      if (!end?.nodeId) continue;
      const mediation = resolveColumnMediation(end);
      if (!mediation.applicable) continue;
      if (!mediation.resolved) {
        unresolved.push(
          Object.freeze({
            nodeId: String(end.nodeId),
            memberRefs: Object.freeze([
              `${topology.memberTag}:${topology.elementId}:${end.side || '-'}`,
            ]),
            reason: 'foundation-beam-count-difference-column-mediation-unresolved',
            topologyReasons: Object.freeze([...mediation.reasons]),
            source: SOURCE,
          }),
        );
        continue;
      }
      const entry = makeEndpointEntry(scanTag, topology, end, layoutMaps);
      const nodeId = String(end.nodeId);
      const list = byNode.get(nodeId) || [];
      list.push(entry);
      byNode.set(nodeId, list);
    }
  }

  for (const nodeId of [...byNode.keys()].sort()) {
    const entries = byNode.get(nodeId);
    const paired = pairEntriesAtNode(entries);
    if (paired.unresolvedReason) {
      unresolved.push(
        Object.freeze({
          nodeId,
          memberRefs: Object.freeze(entries.map(endpointKey)),
          reason: paired.unresolvedReason,
          source: SOURCE,
        }),
      );
      continue;
    }

    for (const pair of paired.pairs) {
      const leftBars = pair.left.bars.map((bar) => projectGirderBarToJointFrame(bar, pair.frame));
      const rightBars = pair.right.bars.map((bar) => projectGirderBarToJointFrame(bar, pair.frame));
      if ([...leftBars, ...rightBars].some((bar) => !bar)) {
        unresolved.push(
          Object.freeze({
            nodeId,
            memberRefs: Object.freeze([endpointKey(pair.left), endpointKey(pair.right)]),
            reason: 'foundation-beam-count-difference-joint-projection-unresolved',
            source: SOURCE,
          }),
        );
        continue;
      }
      if (!hasBaseCountDifference(leftBars, rightBars)) continue;

      joints.push(
        resolveFoundationBeamCountDifference(
          {
            nodeId,
            modelSource: options.modelSource || null,
            left: {
              memberId: pair.left.memberId,
              memberTag: pair.left.memberTag,
              side: pair.left.side,
              bars: leftBars,
            },
            right: {
              memberId: pair.right.memberId,
              memberTag: pair.right.memberTag,
              side: pair.right.side,
              bars: rightBars,
            },
          },
          options,
        ),
      );
    }
  }

  return Object.freeze({
    joints: Object.freeze(joints),
    unresolved: Object.freeze(unresolved),
  });
}

export const _foundationBeamCountDifferenceResolverInternals = Object.freeze({
  baseKey,
  semanticKey,
  samePosition,
  normalizeBar,
  layoutForTopology,
  endpointKey,
  makeEndpointEntry,
  endpointSegment,
  endpointMainBarUnresolvedReasons,
  pairEntriesAtNode,
  resolveColumnMediation,
  hasColumnMediationCandidate,
  isColumnMediatedEnd,
  hasBaseCountDifference,
});
