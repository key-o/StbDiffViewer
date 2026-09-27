/**
 * @fileoverview 許容差を考慮した比較戦略
 *
 * 数値パラメータの許容差を考慮して要素を比較する戦略。
 * 座標、寸法などの微小な差異を許容範囲として扱います。
 */

import { BaseStrategy } from './BaseStrategy.js';
import { BasicComparisonStrategy } from './BaseStrategy.js';
import { evaluateAttributeComparator } from './BaseStrategy.js';
import { getToleranceConfig } from '../../config/toleranceConfig.js';
import {
  compareElementDataWithTolerance,
  compareGeometryCenterDirectionWithTolerance,
} from './toleranceComparison.js';
import { COMPARISON_KEY_TYPE } from '../../config/comparisonKeyConfig.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('common-stb:comparison:ToleranceStrategy');

function createAttributeMismatchPair(pair, attributeComparison = {}, positionState = 'exact') {
  return {
    ...pair,
    matchType: 'attributeMismatch',
    positionState,
    attributeState: 'mismatch',
    attributeMismatchKind: attributeComparison.attributeMismatchKind || attributeComparison.kind,
    attributeDiffScope: attributeComparison.attributeDiffScope || attributeComparison.scope,
    attributeDiffDetails:
      attributeComparison.attributeDiffDetails || attributeComparison.differences,
  };
}

function createPositionMatchPair(dataA, dataB, comparisonResult) {
  return {
    dataA,
    dataB,
    matchType: comparisonResult.type,
    positionState: comparisonResult.type,
    differences: comparisonResult.differences,
  };
}

function pushComparedPair(result, pair, attributeComparator) {
  const attributeComparison = evaluateAttributeComparator(
    attributeComparator,
    pair.dataA,
    pair.dataB,
  );
  if (!attributeComparison.matches) {
    result.mismatch.push(
      createAttributeMismatchPair(pair, attributeComparison, pair.positionState),
    );
    return;
  }

  if (pair.positionState === 'exact') {
    result.exact.push(pair);
  } else {
    result.withinTolerance.push(pair);
  }
}

function formatCoordinate(coords) {
  return `${coords.x},${coords.y},${coords.z}`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return '';
  }
}

function getCandidateLabel(data) {
  if (data?.id !== undefined) {
    return `id:${data.id}`;
  }
  if (data?.guid !== undefined) {
    return `guid:${data.guid}`;
  }
  if (data?.tagName !== undefined) {
    return `tag:${data.tagName}`;
  }
  if (data?.coords) {
    return `coords:${formatCoordinate(data.coords)}`;
  }
  if (data?.startCoords && data?.endCoords) {
    return `line:${formatCoordinate(data.startCoords)}:${formatCoordinate(data.endCoords)}`;
  }
  if (Array.isArray(data?.vertexCoordsList) && data.vertexCoordsList.length > 0) {
    return `poly:${formatCoordinate(data.vertexCoordsList[0])}`;
  }
  return safeStringify(data);
}

function compareCandidate(a, b) {
  const compareLabel = String(a.label).localeCompare(String(b.label));
  if (compareLabel !== 0) return compareLabel;
  return String(safeStringify(a.data)).localeCompare(String(safeStringify(b.data)));
}

function comparePair(a, b) {
  if (a.score !== b.score) {
    return a.score - b.score;
  }

  const keyCompare = String(a.keyA).localeCompare(String(b.keyA));
  if (keyCompare !== 0) return keyCompare;

  const labelACompare = String(a.labelA).localeCompare(String(b.labelA));
  if (labelACompare !== 0) return labelACompare;

  const labelBCompare = String(a.labelB).localeCompare(String(b.labelB));
  if (labelBCompare !== 0) return labelBCompare;

  return a.candidateA.uid - b.candidateA.uid;
}

function sumAbsoluteDifferences(item) {
  if (item == null) {
    return 0;
  }
  if (typeof item === 'number') {
    return Math.abs(item);
  }
  if (typeof item !== 'object') {
    return 0;
  }
  if (Array.isArray(item)) {
    return item.reduce((sum, v) => sum + sumAbsoluteDifferences(v), 0);
  }

  return Object.values(item).reduce((sum, v) => sum + sumAbsoluteDifferences(v), 0);
}

function getMatchScore(comparisonResult) {
  if (comparisonResult?.score !== undefined && Number.isFinite(comparisonResult.score)) {
    return comparisonResult.score;
  }
  return sumAbsoluteDifferences(comparisonResult?.differences);
}

function buildCandidateMap(elements, nodeMap, keyExtractor, classifyNullKeysAsOnly, nullTarget) {
  const map = new Map();
  let nullKeyCount = 0;

  for (const element of elements) {
    const { key, data } = keyExtractor(element, nodeMap);
    if (key === null) {
      nullKeyCount += 1;
      if (classifyNullKeysAsOnly && data !== null) {
        nullTarget.push(data);
      }
      continue;
    }

    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push({
      key,
      data,
      label: `${key}:${getCandidateLabel(data)}`,
      matched: false,
      unresolvedMatch: false,
      uid: -1,
    });
  }

  const orderedKeys = Array.from(map.keys()).sort((a, b) => String(a).localeCompare(String(b)));
  let uid = 0;
  for (const key of orderedKeys) {
    const candidates = map.get(key);
    candidates.sort(compareCandidate);
    for (const candidate of candidates) {
      candidate.uid = uid;
      uid += 1;
    }
  }

  return { map, orderedKeys, nullKeyCount };
}

function buildAllCandidates(candidateMap, orderedKeys) {
  const all = [];
  for (const key of orderedKeys) {
    const candidates = candidateMap.get(key);
    for (const candidate of candidates) {
      all.push(candidate);
    }
  }
  return all;
}

function buildMatchPairs({
  candidatesA,
  candidatesB,
  candidateMapA,
  isGeometryCenterDirectionBased,
  isGuidBased,
  config,
  phase,
}) {
  const pairs = [];
  for (const candidateB of candidatesB) {
    if (candidateB.matched || candidateB.unresolvedMatch) {
      continue;
    }

    const candidateAList =
      isGuidBased || isGeometryCenterDirectionBased || phase === 'exact'
        ? candidateMapA.get(candidateB.key) || []
        : candidatesA;

    for (const candidateA of candidateAList) {
      if (candidateA.matched || candidateA.unresolvedMatch) {
        continue;
      }

      if (phase === 'withinTolerance' && !isGuidBased && !isGeometryCenterDirectionBased) {
        if (
          (candidateA.data.sectionSignature ?? null) !== (candidateB.data.sectionSignature ?? null)
        ) {
          continue;
        }
      }

      const comparisonResult = isGeometryCenterDirectionBased
        ? compareGeometryCenterDirectionWithTolerance(candidateA.data, candidateB.data, config)
        : compareElementDataWithTolerance(candidateA.data, candidateB.data, config);

      if (!comparisonResult.match) {
        continue;
      }

      if (phase === 'exact' && comparisonResult.type !== 'exact') {
        continue;
      }

      if (phase === 'withinTolerance' && comparisonResult.type !== 'withinTolerance') {
        continue;
      }

      pairs.push({
        candidateA,
        candidateB,
        keyA: candidateA.key,
        keyB: candidateB.key,
        labelA: candidateA.label,
        labelB: candidateB.label,
        comparisonResult,
        score: getMatchScore(comparisonResult),
        phase,
      });
    }
  }

  pairs.sort(comparePair);
  return pairs;
}

function buildPairAdjacencyByB(pairs) {
  const adjacencyByB = new Map();

  for (const pair of pairs) {
    if (pair.candidateA.matched || pair.candidateB.matched) {
      continue;
    }

    const uid = pair.candidateB.uid;
    if (!adjacencyByB.has(uid)) {
      adjacencyByB.set(uid, {
        candidateB: pair.candidateB,
        pairs: [],
      });
    }
    adjacencyByB.get(uid).pairs.push(pair);
  }

  for (const entry of adjacencyByB.values()) {
    entry.pairs.sort(comparePair);
  }

  return adjacencyByB;
}

function compareAdjacencyEntry(left, right) {
  if (left.pairs.length !== right.pairs.length) {
    return left.pairs.length - right.pairs.length;
  }

  const leftBestScore = left.pairs[0]?.score ?? Number.POSITIVE_INFINITY;
  const rightBestScore = right.pairs[0]?.score ?? Number.POSITIVE_INFINITY;
  if (leftBestScore !== rightBestScore) {
    return leftBestScore - rightBestScore;
  }

  return compareCandidate(left.candidateB, right.candidateB);
}

function tryAugmentCandidateB(candidateB, adjacencyByB, pairByAUid, visitedA, visitedB) {
  if (visitedB.has(candidateB.uid)) {
    return false;
  }
  visitedB.add(candidateB.uid);

  const entry = adjacencyByB.get(candidateB.uid);
  if (!entry) {
    return false;
  }

  for (const pair of entry.pairs) {
    const candidateA = pair.candidateA;
    if (candidateA.matched || visitedA.has(candidateA.uid)) {
      continue;
    }
    visitedA.add(candidateA.uid);

    const occupiedPair = pairByAUid.get(candidateA.uid);
    if (
      !occupiedPair ||
      tryAugmentCandidateB(occupiedPair.candidateB, adjacencyByB, pairByAUid, visitedA, visitedB)
    ) {
      pairByAUid.set(candidateA.uid, pair);
      return true;
    }
  }

  return false;
}

function selectMaximumCardinalityPairs(pairs) {
  const adjacencyByB = buildPairAdjacencyByB(pairs);
  const orderedEntries = Array.from(adjacencyByB.values()).sort(compareAdjacencyEntry);
  const pairByAUid = new Map();

  for (const { candidateB } of orderedEntries) {
    tryAugmentCandidateB(candidateB, adjacencyByB, pairByAUid, new Set(), new Set());
  }

  return Array.from(pairByAUid.values()).sort(comparePair);
}

function equalMatchScore(left, right) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * 16 * scale;
}

function collectStronglyConnectedComponents(adjacency) {
  let nextIndex = 0;
  const indexByNode = new Map();
  const lowLinkByNode = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    indexByNode.set(node, nextIndex);
    lowLinkByNode.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const nextNode of adjacency.get(node) || []) {
      if (!indexByNode.has(nextNode)) {
        visit(nextNode);
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node), lowLinkByNode.get(nextNode)));
      } else if (onStack.has(nextNode)) {
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node), indexByNode.get(nextNode)));
      }
    }

    if (lowLinkByNode.get(node) !== indexByNode.get(node)) {
      return;
    }

    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) {
        break;
      }
    }
    components.push(component);
  }

  for (const node of adjacency.keys()) {
    if (!indexByNode.has(node)) {
      visit(node);
    }
  }

  return components;
}

function detectEqualScoreAmbiguity(pairs, selectedPairs) {
  const selectedByA = new Map();
  const selectedByB = new Map();
  const selectedPairKeys = new Set();
  for (const pair of selectedPairs) {
    selectedByA.set(pair.candidateA.uid, pair);
    selectedByB.set(pair.candidateB.uid, pair);
    selectedPairKeys.add(`${pair.candidateA.uid}:${pair.candidateB.uid}`);
  }

  const ambiguousA = new Set();
  const ambiguousB = new Set();
  const equalAdjacency = new Map();

  function markPair(pair) {
    ambiguousA.add(pair.candidateA.uid);
    ambiguousB.add(pair.candidateB.uid);
  }

  function addEqualAdjacency(fromAUid, toAUid) {
    if (!equalAdjacency.has(fromAUid)) {
      equalAdjacency.set(fromAUid, new Set());
    }
    equalAdjacency.get(fromAUid).add(toAUid);
    if (!equalAdjacency.has(toAUid)) {
      equalAdjacency.set(toAUid, new Set());
    }
  }

  for (const pair of pairs) {
    if (selectedPairKeys.has(`${pair.candidateA.uid}:${pair.candidateB.uid}`)) {
      continue;
    }

    const selectedForA = selectedByA.get(pair.candidateA.uid);
    const selectedForB = selectedByB.get(pair.candidateB.uid);

    if (!selectedForA && selectedForB && equalMatchScore(pair.score, selectedForB.score)) {
      pair.candidateA.unresolvedMatch = true;
      markPair(selectedForB);
      ambiguousA.add(pair.candidateA.uid);
      continue;
    }

    if (selectedForA && !selectedForB && equalMatchScore(pair.score, selectedForA.score)) {
      pair.candidateB.unresolvedMatch = true;
      markPair(selectedForA);
      ambiguousB.add(pair.candidateB.uid);
      continue;
    }

    if (
      selectedForA &&
      selectedForB &&
      equalMatchScore(pair.score, selectedForA.score) &&
      equalMatchScore(pair.score, selectedForB.score)
    ) {
      addEqualAdjacency(pair.candidateA.uid, selectedForB.candidateA.uid);
    }
  }

  for (const component of collectStronglyConnectedComponents(equalAdjacency)) {
    if (component.length <= 1) {
      continue;
    }
    for (const candidateAUid of component) {
      const selectedPair = selectedByA.get(candidateAUid);
      if (selectedPair) {
        markPair(selectedPair);
      }
    }
  }

  if (ambiguousA.size === 0 && ambiguousB.size === 0) {
    return null;
  }

  const candidateAByUid = new Map();
  const candidateBByUid = new Map();
  for (const pair of pairs) {
    candidateAByUid.set(pair.candidateA.uid, pair.candidateA);
    candidateBByUid.set(pair.candidateB.uid, pair.candidateB);
  }

  for (const selectedPair of selectedPairs) {
    if (
      ambiguousA.has(selectedPair.candidateA.uid) ||
      ambiguousB.has(selectedPair.candidateB.uid)
    ) {
      selectedPair.candidateA.unresolvedMatch = true;
      selectedPair.candidateB.unresolvedMatch = true;
    }
  }

  return {
    status: 'unresolvedMatch',
    reason: 'equal-score-ambiguous',
    phase: pairs[0]?.phase || null,
    candidateA: Array.from(ambiguousA)
      .map((uid) => candidateAByUid.get(uid))
      .filter(Boolean)
      .sort(compareCandidate)
      .map((candidate) => candidate.data),
    candidateB: Array.from(ambiguousB)
      .map((uid) => candidateBByUid.get(uid))
      .filter(Boolean)
      .sort(compareCandidate)
      .map((candidate) => candidate.data),
  };
}

function applyMatchedPairs(pairs, result, attributeComparator) {
  const selectedPairs = selectMaximumCardinalityPairs(pairs);
  const unresolved = detectEqualScoreAmbiguity(pairs, selectedPairs);
  if (unresolved) {
    result.unresolvedMatches.push(unresolved);
  }

  for (const pair of selectedPairs) {
    if (pair.candidateA.unresolvedMatch || pair.candidateB.unresolvedMatch) {
      continue;
    }

    pushComparedPair(
      result,
      createPositionMatchPair(pair.candidateA.data, pair.candidateB.data, pair.comparisonResult),
      attributeComparator,
    );
    pair.candidateA.matched = true;
    pair.candidateB.matched = true;
  }
}

function collectUnmatchedCandidateData(candidates) {
  return candidates.filter((candidate) => !candidate.matched).map((candidate) => candidate.data);
}

/**
 * 許容差を考慮した比較戦略
 */
export class ToleranceStrategy extends BaseStrategy {
  /**
   * @param {Object} [defaultConfig=null] - デフォルト許容差設定
   */
  constructor(defaultConfig = null) {
    super();
    this.defaultConfig = defaultConfig;
  }

  get name() {
    return 'tolerance';
  }

  /**
   * @override
   */
  isApplicable(options = {}) {
    const config = options.toleranceConfig || this.defaultConfig || getToleranceConfig();
    return config && config.enabled && !config.strictMode;
  }

  /**
   * @override
   */
  compare(elementsA, elementsB, nodeMapA, nodeMapB, keyExtractor, options = {}) {
    const config = options.toleranceConfig || this.defaultConfig || getToleranceConfig();
    const keyType = options.keyType || COMPARISON_KEY_TYPE.POSITION_NODE_ONLY;
    const isGuidBased = keyType === COMPARISON_KEY_TYPE.GUID_BASED;
    const isGeometryCenterDirectionBased =
      keyType === COMPARISON_KEY_TYPE.GEOMETRY_CENTER_DIRECTION_BASED;
    const classifyNullKeysAsOnly = options.classifyNullKeysAsOnly === true;
    const attributeComparator = options.attributeComparator;

    // 厳密モードまたは許容差無効の場合は基本比較
    if (config.strictMode || !config.enabled) {
      const basicStrategy = new BasicComparisonStrategy();
      const basicResult = basicStrategy.compare(
        elementsA,
        elementsB,
        nodeMapA,
        nodeMapB,
        keyExtractor,
        options,
      );
      return {
        exact: basicResult.matched,
        withinTolerance: [],
        mismatch: basicResult.mismatch || [],
        onlyA: basicResult.onlyA,
        onlyB: basicResult.onlyB,
        unresolvedMatches: [],
      };
    }

    const result = {
      exact: [],
      withinTolerance: [],
      mismatch: [],
      onlyA: [],
      onlyB: [],
      unresolvedMatches: [],
    };

    const {
      map: mapA,
      orderedKeys: orderedKeysA,
      nullKeyCount: nullKeyCountA,
    } = buildCandidateMap(elementsA, nodeMapA, keyExtractor, classifyNullKeysAsOnly, result.onlyA);
    const {
      map: mapB,
      orderedKeys: orderedKeysB,
      nullKeyCount: nullKeyCountB,
    } = buildCandidateMap(elementsB, nodeMapB, keyExtractor, classifyNullKeysAsOnly, result.onlyB);

    if (nullKeyCountA > 0 || nullKeyCountB > 0) {
      log.warn(
        `[Data] 比較キー未生成の要素: A=${nullKeyCountA}件, B=${nullKeyCountB}件` +
          (classifyNullKeysAsOnly ? ' (onlyA/onlyBに分類)' : ' (除外)'),
      );
    }

    const allCandidatesA = buildAllCandidates(mapA, orderedKeysA);
    const allCandidatesB = buildAllCandidates(mapB, orderedKeysB);

    const exactPairs = buildMatchPairs({
      candidatesA: allCandidatesA,
      candidatesB: allCandidatesB,
      candidateMapA: mapA,
      isGeometryCenterDirectionBased,
      isGuidBased,
      config,
      phase: 'exact',
    });
    applyMatchedPairs(exactPairs, result, attributeComparator);

    const remainingCandidatesA = allCandidatesA.filter((candidate) => !candidate.matched);
    const remainingCandidatesB = allCandidatesB.filter((candidate) => !candidate.matched);

    const withinPairs = buildMatchPairs({
      candidatesA: remainingCandidatesA,
      candidatesB: remainingCandidatesB,
      candidateMapA: mapA,
      isGeometryCenterDirectionBased,
      isGuidBased,
      config,
      phase: 'withinTolerance',
    });
    applyMatchedPairs(withinPairs, result, attributeComparator);

    result.onlyA.push(...collectUnmatchedCandidateData(allCandidatesA));
    result.onlyB.push(...collectUnmatchedCandidateData(allCandidatesB));

    return result;
  }

  /**
   * @override
   */
  compareElementData(dataA, dataB, options = {}) {
    const config = options.toleranceConfig || this.defaultConfig || getToleranceConfig();
    return compareElementDataWithTolerance(dataA, dataB, config);
  }
}
