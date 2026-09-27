/**
 * @fileoverview ToleranceStrategy の候補探索を空間索引で分割する最適化ラッパー。
 *
 * matching semantics は ToleranceStrategy に委譲し、この層では
 * 「真の許容差候補を含む保守的な connected component」だけを構築する。
 */

import { COMPARISON_KEY_TYPE } from '../../config/comparisonKeyConfig.js';
import { getToleranceConfig } from '../../config/toleranceConfig.js';
import { ToleranceStrategy } from './ToleranceStrategy.js';
import { createToleranceSpatialIndex, getToleranceSpatialAnchor } from './toleranceSpatialIndex.js';

const INDEXABLE_KEY_TYPES = new Set([
  COMPARISON_KEY_TYPE.POSITION_NODE_ONLY,
  COMPARISON_KEY_TYPE.POSITION_WITH_OFFSET,
  COMPARISON_KEY_TYPE.POSITION_WITH_ROTATE,
]);

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch (error) {
    return '';
  }
}

function dataLabel(data) {
  if (data?.id !== undefined) return `id:${data.id}`;
  if (data?.guid !== undefined) return `guid:${data.guid}`;
  if (data?.tagName !== undefined) return `tag:${data.tagName}`;
  return safeStringify(data);
}

function pairLabel(pair) {
  return `${dataLabel(pair.dataA)}|${dataLabel(pair.dataB)}`;
}

function sortResult(result) {
  result.exact.sort((left, right) => pairLabel(left).localeCompare(pairLabel(right)));
  result.withinTolerance.sort((left, right) => pairLabel(left).localeCompare(pairLabel(right)));
  result.mismatch.sort((left, right) => pairLabel(left).localeCompare(pairLabel(right)));
  result.onlyA.sort((left, right) => dataLabel(left).localeCompare(dataLabel(right)));
  result.onlyB.sort((left, right) => dataLabel(left).localeCompare(dataLabel(right)));
  result.unresolvedMatches.sort((left, right) => {
    const leftLabel = `${left.phase || ''}|${left.reason || ''}|${left.candidateA
      .map(dataLabel)
      .join(',')}|${left.candidateB.map(dataLabel).join(',')}`;
    const rightLabel = `${right.phase || ''}|${right.reason || ''}|${right.candidateA
      .map(dataLabel)
      .join(',')}|${right.candidateB.map(dataLabel).join(',')}`;
    return leftLabel.localeCompare(rightLabel);
  });
  return result;
}

function createStats(overrides = {}) {
  return {
    spatialIndexUsed: false,
    fallbackReason: null,
    indexedCandidateCount: 0,
    coarseCandidatePairCount: 0,
    componentCrossProductCount: 0,
    fullScanCrossProductCount: 0,
    componentCount: 0,
    ...overrides,
  };
}

function decorateFallbackResult(result, reason) {
  return {
    ...result,
    candidateSearchStats: createStats({ fallbackReason: reason }),
  };
}

function buildDescriptors(elements, nodeMap, keyExtractor, side) {
  return elements.map((element, originalIndex) => {
    const extracted = keyExtractor(element, nodeMap);
    return {
      side,
      element,
      originalIndex,
      key: extracted?.key ?? null,
      data: extracted?.data ?? null,
      anchor: getToleranceSpatialAnchor(extracted?.data),
      uid: -1,
    };
  });
}

function descriptorLabel(descriptor) {
  return `${String(descriptor.key)}|${dataLabel(descriptor.data)}|${descriptor.side}`;
}

function assignStableUids(descriptors) {
  const ordered = [...descriptors].sort((left, right) => {
    const compare = descriptorLabel(left).localeCompare(descriptorLabel(right));
    return compare !== 0 ? compare : left.originalIndex - right.originalIndex;
  });
  ordered.forEach((descriptor, index) => {
    descriptor.uid = index;
  });
}

class DisjointSet {
  constructor(nodes) {
    this.parent = new Map(nodes.map((node) => [node, node]));
  }

  find(node) {
    const parent = this.parent.get(node);
    if (parent === node) return node;
    const root = this.find(parent);
    this.parent.set(node, root);
    return root;
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      this.parent.set(rightRoot, leftRoot);
    }
  }
}

function nodeId(descriptor) {
  return `${descriptor.side}:${descriptor.uid}`;
}

function createComponents(descriptorsA, descriptorsB, spatialIndex) {
  const allDescriptors = [...descriptorsA, ...descriptorsB];
  const dsu = new DisjointSet(allDescriptors.map(nodeId));
  let coarseCandidatePairCount = 0;

  for (const descriptorB of descriptorsB) {
    const candidatesA = spatialIndex.query(descriptorB.data);
    coarseCandidatePairCount += candidatesA.length;
    for (const descriptorA of candidatesA) {
      dsu.union(nodeId(descriptorA), nodeId(descriptorB));
    }
  }

  const components = new Map();
  for (const descriptor of allDescriptors) {
    const root = dsu.find(nodeId(descriptor));
    if (!components.has(root)) {
      components.set(root, { a: [], b: [] });
    }
    components.get(root)[descriptor.side.toLowerCase()].push(descriptor);
  }

  return { components: Array.from(components.values()), coarseCandidatePairCount };
}

function mergeComponentResult(target, source) {
  target.exact.push(...(source.exact || []));
  target.withinTolerance.push(...(source.withinTolerance || []));
  target.mismatch.push(...(source.mismatch || []));
  target.onlyA.push(...(source.onlyA || []));
  target.onlyB.push(...(source.onlyB || []));
  target.unresolvedMatches.push(...(source.unresolvedMatches || []));
}

/**
 * ToleranceStrategy の候補探索だけを spatial component 化する。
 * useSpatialIndex=false で参照実装（全候補探索）へ戻せる。
 */
export class SpatialIndexedToleranceStrategy {
  constructor(defaultConfig = null) {
    this.defaultConfig = defaultConfig;
    this.baseStrategy = new ToleranceStrategy(defaultConfig);
  }

  get name() {
    return 'tolerance-spatial-index';
  }

  isApplicable(options = {}) {
    return this.baseStrategy.isApplicable(options);
  }

  compare(elementsA, elementsB, nodeMapA, nodeMapB, keyExtractor, options = {}) {
    const config = options.toleranceConfig || this.defaultConfig || getToleranceConfig();
    const keyType = options.keyType || COMPARISON_KEY_TYPE.POSITION_NODE_ONLY;

    if (options.useSpatialIndex === false) {
      return decorateFallbackResult(
        this.baseStrategy.compare(elementsA, elementsB, nodeMapA, nodeMapB, keyExtractor, options),
        'disabled',
      );
    }
    if (!config?.enabled || config.strictMode) {
      return decorateFallbackResult(
        this.baseStrategy.compare(elementsA, elementsB, nodeMapA, nodeMapB, keyExtractor, options),
        'tolerance-disabled-or-strict',
      );
    }
    if (!INDEXABLE_KEY_TYPES.has(keyType)) {
      return decorateFallbackResult(
        this.baseStrategy.compare(elementsA, elementsB, nodeMapA, nodeMapB, keyExtractor, options),
        'key-type-not-indexable',
      );
    }

    const descriptorsA = buildDescriptors(elementsA, nodeMapA, keyExtractor, 'A');
    const descriptorsB = buildDescriptors(elementsB, nodeMapB, keyExtractor, 'B');
    const allDescriptors = [...descriptorsA, ...descriptorsB];
    if (
      allDescriptors.some(
        (descriptor) => descriptor.key === null || descriptor.data === null || !descriptor.anchor,
      )
    ) {
      return decorateFallbackResult(
        this.baseStrategy.compare(elementsA, elementsB, nodeMapA, nodeMapB, keyExtractor, options),
        'unindexable-candidate',
      );
    }

    assignStableUids(descriptorsA);
    assignStableUids(descriptorsB);
    const spatialIndex = createToleranceSpatialIndex(descriptorsA, config);
    if (!spatialIndex.usable) {
      return decorateFallbackResult(
        this.baseStrategy.compare(elementsA, elementsB, nodeMapA, nodeMapB, keyExtractor, options),
        'invalid-tolerance',
      );
    }

    const { components, coarseCandidatePairCount } = createComponents(
      descriptorsA,
      descriptorsB,
      spatialIndex,
    );
    const aggregate = {
      exact: [],
      withinTolerance: [],
      mismatch: [],
      onlyA: [],
      onlyB: [],
      unresolvedMatches: [],
    };
    let componentCrossProductCount = 0;

    for (const component of components) {
      const componentA = component.a.map((descriptor) => descriptor.element);
      const componentB = component.b.map((descriptor) => descriptor.element);
      componentCrossProductCount += componentA.length * componentB.length;

      if (componentA.length === 0) {
        aggregate.onlyB.push(...component.b.map((descriptor) => descriptor.data));
        continue;
      }
      if (componentB.length === 0) {
        aggregate.onlyA.push(...component.a.map((descriptor) => descriptor.data));
        continue;
      }

      mergeComponentResult(
        aggregate,
        this.baseStrategy.compare(
          componentA,
          componentB,
          nodeMapA,
          nodeMapB,
          keyExtractor,
          options,
        ),
      );
    }

    aggregate.candidateSearchStats = createStats({
      spatialIndexUsed: true,
      indexedCandidateCount: spatialIndex.indexedCount,
      coarseCandidatePairCount,
      componentCrossProductCount,
      fullScanCrossProductCount: descriptorsA.length * descriptorsB.length,
      componentCount: components.length,
    });

    return sortResult(aggregate);
  }

  compareElementData(dataA, dataB, options = {}) {
    return this.baseStrategy.compareElementData(dataA, dataB, options);
  }
}
