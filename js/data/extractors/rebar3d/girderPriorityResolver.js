/**
 * @fileoverview Issue #273 Phase 5a: RC大梁主筋のtopology / continuity priority resolver。
 *
 * R7のworld-straight-firstで確定しなかった残筋を対象に、project opt-in時だけ
 * joint frame上のtop/bottom・layer・左右端topologyを使って外側主筋を先に対応付ける。
 * topologyが未解決の筋はgeneric matcherへ落とさずfail-closedで残す。
 */

import { matchRebarFacts, rebarSemanticKey } from './rebarIdentityMatcher.js';

const POSITION_TOLERANCE_MM = 1e-6;

function finiteOrNull(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function layerNumber(bar) {
  const value = Number(bar?.layer);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function roleName(bar) {
  const role = String(bar?.role || '').toUpperCase();
  return role === 'TOP' || role === 'BOTTOM' ? role : null;
}

function stableBarKey(bar) {
  const role = roleName(bar) || '';
  const layer = layerNumber(bar) ?? Number.MAX_SAFE_INTEGER;
  const transverse = finiteOrNull(bar?.jointTransverseMm);
  const index = Number.isInteger(Number(bar?.barIndex))
    ? Number(bar.barIndex)
    : Number.MAX_SAFE_INTEGER;
  return [
    role,
    String(layer).padStart(6, '0'),
    transverse === null ? '' : transverse.toFixed(9),
    String(index).padStart(12, '0'),
    rebarSemanticKey(bar),
  ].join('|');
}

function stableBars(bars) {
  return (bars || [])
    .slice()
    .sort((left, right) => stableBarKey(left).localeCompare(stableBarKey(right)));
}

function topologyRef(bar) {
  return Object.freeze({
    barIndex: bar?.barIndex ?? null,
    topologyRole: bar?.topologyRole ?? null,
    topologyPosition: bar?.topologyPosition ?? null,
    role: bar?.role ?? null,
    layer: bar?.layer ?? null,
    jointTransverseMm: finiteOrNull(bar?.jointTransverseMm),
  });
}

function groupKey(bar) {
  return `${roleName(bar) || 'UNKNOWN'}|${layerNumber(bar) ?? '-'}`;
}

function annotateGroup(group) {
  const sorted = stableBars(group);
  const role = roleName(sorted[0]);
  const layer = layerNumber(sorted[0]);
  const valid =
    role &&
    layer !== null &&
    sorted.every(
      (bar) =>
        roleName(bar) === role &&
        layerNumber(bar) === layer &&
        finiteOrNull(bar?.jointTransverseMm) !== null,
    );

  if (!valid) {
    return sorted.map((bar) => ({
      ...bar,
      topologyRole: null,
      topologyPosition: null,
      topologyStatus: 'UNRESOLVED',
      topologyReason: 'girder-topology-input-unresolved',
    }));
  }

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = Number(sorted[index - 1].jointTransverseMm);
    const current = Number(sorted[index].jointTransverseMm);
    if (Math.abs(current - previous) <= POSITION_TOLERANCE_MM) {
      return sorted.map((bar) => ({
        ...bar,
        topologyRole: null,
        topologyPosition: null,
        topologyStatus: 'UNRESOLVED',
        topologyReason: 'girder-topology-position-duplicate',
      }));
    }
  }

  const count = sorted.length;
  return sorted.map((bar, index) => {
    let topologyRole;
    let topologyPosition;
    if (count === 1) {
      topologyRole = 'CENTER';
      topologyPosition = `${role}:L${layer}:CENTER`;
    } else if (index === 0 || index === count - 1) {
      topologyRole = layer === 1 ? 'CORNER' : 'EDGE';
      topologyPosition = `${role}:L${layer}:${index === 0 ? 'LEFT' : 'RIGHT'}`;
    } else {
      topologyRole = 'INTERMEDIATE';
      topologyPosition = `${role}:L${layer}:INTERMEDIATE:${index}_OF_${count - 1}`;
    }
    return {
      ...bar,
      topologyRole,
      topologyPosition,
      topologyStatus: 'RESOLVED',
      topologyReason: null,
    };
  });
}

/**
 * joint frameへ投影済みの梁端主筋へtopology metadataを付与する。
 * 元bar objectは変更しない。
 */
export function classifyGirderJointBarTopology(bars) {
  const indexed = (bars || []).map((bar, index) => ({ ...bar, __topologyInputIndex: index }));
  const groups = new Map();
  for (const bar of indexed) {
    const key = groupKey(bar);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bar);
  }
  return [...groups.keys()]
    .sort()
    .flatMap((key) => annotateGroup(groups.get(key)))
    .sort((left, right) => left.__topologyInputIndex - right.__topologyInputIndex)
    .map(({ __topologyInputIndex: _inputIndex, ...bar }) => bar);
}

function topologyResolved(bar) {
  return bar?.topologyStatus === 'RESOLVED' && Boolean(bar?.topologyRole);
}

function isCorner(bar) {
  return topologyResolved(bar) && bar.topologyRole === 'CORNER' && Boolean(bar.topologyPosition);
}

function append(map, key, value) {
  const list = map.get(key) || [];
  list.push(value);
  map.set(key, list);
}

function unresolvedTopologyReason(bars) {
  const reasons = [...new Set((bars || []).map((bar) => bar?.topologyReason).filter(Boolean))];
  return reasons.length === 1 ? reasons[0] : 'girder-topology-unresolved';
}

function cornerMatches(leftBars, rightBars, allRightBars = rightBars) {
  const leftByKey = new Map();
  const rightByKey = new Map();
  for (const bar of stableBars(leftBars)) append(leftByKey, bar.topologyPosition, bar);
  for (const bar of stableBars(rightBars)) append(rightByKey, bar.topologyPosition, bar);
  const keys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])].sort();
  const result = { matches: [], unmatchedLeft: [], unmatchedRight: [], unresolved: [] };

  for (const key of keys) {
    const left = leftByKey.get(key) || [];
    const right = rightByKey.get(key) || [];
    if (left.length > 1 || right.length > 1) {
      result.unresolved.push({
        reason: 'girder-corner-topology-ambiguous',
        semanticKey: key,
        leftBars: left,
        rightBars: right,
      });
      continue;
    }
    if (left.length === 0) {
      result.unmatchedRight.push(...right);
      continue;
    }
    if (right.length === 0) {
      result.unmatchedLeft.push(...left);
      continue;
    }

    const semanticKey = rebarSemanticKey(left[0]);
    if (semanticKey !== rebarSemanticKey(right[0])) {
      result.unresolved.push({
        reason: 'semantic-mismatch',
        semanticKey,
        leftBars: left,
        rightBars: right,
      });
      continue;
    }

    const selected = right[0];
    const rejectedAlternatives = stableBars(allRightBars)
      .filter((candidate) => candidate !== selected && rebarSemanticKey(candidate) === semanticKey)
      .map((candidate) => ({
        target: topologyRef(candidate),
        reason: 'LOWER_TOPOLOGY_PRIORITY',
      }));

    result.matches.push({
      left: left[0],
      right: selected,
      semanticKey,
      matchBasis: 'girder-corner-priority',
      rejectedAlternatives,
    });
  }

  return {
    ...result,
    unmatchedLeft: stableBars(result.unmatchedLeft),
    unmatchedRight: stableBars(result.unmatchedRight),
  };
}

function annotateResidualMatches(matched) {
  return {
    ...matched,
    matches: (matched.matches || []).map((match) => ({
      ...match,
      matchBasis: match.matchBasis || 'relative-slot',
      rejectedAlternatives: match.rejectedAlternatives || [],
    })),
    unmatchedLeft: stableBars(matched.unmatchedLeft),
    unmatchedRight: stableBars(matched.unmatchedRight),
  };
}

/**
 * @param {Array<object>} leftBars joint-frame projection after straight-first
 * @param {Array<object>} rightBars joint-frame projection after straight-first
 * @param {{cornerPriority?: boolean, topologyFrameCompatible?: boolean, topologyClassified?: boolean, matcherOptions?: object}} options
 */
export function resolveGirderPriorityResidual(leftBars, rightBars, options = {}) {
  const left =
    options.topologyClassified === true
      ? stableBars(leftBars)
      : classifyGirderJointBarTopology(leftBars);
  const right =
    options.topologyClassified === true
      ? stableBars(rightBars)
      : classifyGirderJointBarTopology(rightBars);
  const cornerPriority = options.cornerPriority === true;

  if (!cornerPriority) {
    return {
      ...annotateResidualMatches(matchRebarFacts(left, right, options.matcherOptions || {})),
      resolver: Object.freeze({ enabled: false, ruleId: null, cornerMatchCount: 0 }),
    };
  }

  const unresolvedLeft = left.filter((bar) => !topologyResolved(bar));
  const unresolvedRight = right.filter((bar) => !topologyResolved(bar));
  const resolvedLeft = left.filter(topologyResolved);
  const resolvedRight = right.filter(topologyResolved);
  const unresolved = [];

  if (unresolvedLeft.length || unresolvedRight.length) {
    unresolved.push({
      reason: unresolvedTopologyReason([...unresolvedLeft, ...unresolvedRight]),
      semanticKey: null,
      leftBars: stableBars(unresolvedLeft),
      rightBars: stableBars(unresolvedRight),
    });
  }

  const leftCorners = resolvedLeft.filter(isCorner);
  const rightCorners = resolvedRight.filter(isCorner);
  const leftNonCorners = resolvedLeft.filter((bar) => !isCorner(bar));
  const rightNonCorners = resolvedRight.filter((bar) => !isCorner(bar));

  let corner = {
    matches: [],
    unmatchedLeft: stableBars(leftCorners),
    unmatchedRight: stableBars(rightCorners),
    unresolved: [],
  };
  if (options.topologyFrameCompatible !== false) {
    corner = cornerMatches(leftCorners, rightCorners, resolvedRight);
  } else if (leftCorners.length || rightCorners.length) {
    corner = {
      matches: [],
      unmatchedLeft: [],
      unmatchedRight: [],
      unresolved: [
        {
          reason: 'girder-topology-frame-mismatch',
          semanticKey: null,
          leftBars: stableBars(leftCorners),
          rightBars: stableBars(rightCorners),
        },
      ],
    };
  }

  const residual = annotateResidualMatches(
    matchRebarFacts(leftNonCorners, rightNonCorners, options.matcherOptions || {}),
  );

  return {
    matches: [...corner.matches, ...residual.matches],
    unmatchedLeft: stableBars([...corner.unmatchedLeft, ...residual.unmatchedLeft]),
    unmatchedRight: stableBars([...corner.unmatchedRight, ...residual.unmatchedRight]),
    unresolved: [...unresolved, ...corner.unresolved, ...residual.unresolved],
    resolver: Object.freeze({
      enabled: true,
      ruleId: 'GIRDER-CORNER-PRIORITY',
      cornerMatchCount: corner.matches.length,
    }),
  };
}
