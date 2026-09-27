/**
 * @fileoverview Issue #273 Phase 3: RC柱主筋のcontinuity priority resolver。
 *
 * world-straight-firstで確定しなかった残筋を対象に、project opt-in時だけ
 * topologyRole/topologyPositionを用いて柱四隅主筋を先に対応付ける。
 * topologyが未解決の筋はgeneric nearestへ落とさずfail-closedで残す。
 */

import { matchRebarFacts } from './rebarIdentityMatcher.js';
import { columnBarSemanticKey } from './columnRebarTransition.js';

function topologyResolved(bar) {
  return bar?.topologyStatus === 'RESOLVED' && Boolean(bar?.topologyRole);
}

function isCorner(bar) {
  return topologyResolved(bar) && bar.topologyRole === 'CORNER' && Boolean(bar.topologyPosition);
}

function finiteOrNull(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function topologyRef(bar) {
  return Object.freeze({
    barIndex: bar?.barIndex ?? null,
    topologyRole: bar?.topologyRole ?? null,
    topologyPosition: bar?.topologyPosition ?? null,
    u: finiteOrNull(bar?.u),
    v: finiteOrNull(bar?.v),
  });
}

function stableBarKey(bar) {
  const topologyPosition = String(bar?.topologyPosition || '');
  const topologyRole = String(bar?.topologyRole || '');
  const semanticKey = columnBarSemanticKey(bar);
  const index = Number.isInteger(Number(bar?.barIndex))
    ? Number(bar.barIndex)
    : Number.MAX_SAFE_INTEGER;
  const u = finiteOrNull(bar?.u);
  const v = finiteOrNull(bar?.v);
  return [
    topologyPosition,
    topologyRole,
    semanticKey,
    String(index).padStart(12, '0'),
    u === null ? '' : u.toFixed(9),
    v === null ? '' : v.toFixed(9),
  ].join('|');
}

function stableBars(bars) {
  return (bars || [])
    .slice()
    .sort((left, right) => stableBarKey(left).localeCompare(stableBarKey(right)));
}

function append(map, key, value) {
  const list = map.get(key) || [];
  list.push(value);
  map.set(key, list);
}

function cornerKey(bar) {
  return String(bar?.topologyPosition || '');
}

function unresolvedTopologyReason(bars) {
  const reasons = [...new Set((bars || []).map((bar) => bar?.topologyReason).filter(Boolean))];
  return reasons.length === 1 ? reasons[0] : 'column-topology-unresolved';
}

function cornerMatches(lowerBars, upperBars, allUpperBars = upperBars) {
  const leftByKey = new Map();
  const rightByKey = new Map();
  for (const bar of stableBars(lowerBars)) append(leftByKey, cornerKey(bar), bar);
  for (const bar of stableBars(upperBars)) append(rightByKey, cornerKey(bar), bar);
  const keys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])].sort();
  const result = { matches: [], unmatchedLeft: [], unmatchedRight: [], unresolved: [] };

  for (const key of keys) {
    const left = leftByKey.get(key) || [];
    const right = rightByKey.get(key) || [];
    if (left.length > 1 || right.length > 1) {
      result.unresolved.push({
        reason: 'column-corner-topology-ambiguous',
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

    const selected = right[0];
    const semanticKey = columnBarSemanticKey(left[0]);
    if (semanticKey !== columnBarSemanticKey(selected)) {
      result.unresolved.push({
        reason: 'semantic-mismatch',
        semanticKey,
        leftBars: left,
        rightBars: right,
      });
      continue;
    }

    const alternatives = stableBars(allUpperBars)
      .filter(
        (candidate) => candidate !== selected && columnBarSemanticKey(candidate) === semanticKey,
      )
      .map((candidate) => ({
        target: topologyRef(candidate),
        reason: 'LOWER_TOPOLOGY_PRIORITY',
      }));

    result.matches.push({
      left: left[0],
      right: selected,
      distance: Math.hypot(selected.u - left[0].u, selected.v - left[0].v),
      semanticKey,
      matchBasis: 'column-corner-priority',
      rejectedAlternatives: alternatives,
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
      matchBasis: match.matchBasis || 'semantic-position-residual',
      rejectedAlternatives: match.rejectedAlternatives || [],
    })),
    unmatchedLeft: stableBars(matched.unmatchedLeft),
    unmatchedRight: stableBars(matched.unmatchedRight),
  };
}

/**
 * @param {Array<object>} lowerBars world-coordinate lower endpoint bars after straight-first
 * @param {Array<object>} upperBars world-coordinate upper endpoint bars after straight-first
 * @param {{cornerPriority?: boolean, topologyFrameCompatible?: boolean, matcherOptions?: object}} options
 */
export function resolveColumnPriorityResidual(lowerBars, upperBars, options = {}) {
  const lower = Array.isArray(lowerBars) ? lowerBars.slice() : [];
  const upper = Array.isArray(upperBars) ? upperBars.slice() : [];
  const cornerPriority = options.cornerPriority === true;

  if (!cornerPriority) {
    return {
      ...annotateResidualMatches(matchRebarFacts(lower, upper, options.matcherOptions || {})),
      resolver: Object.freeze({ enabled: false, ruleId: null, cornerMatchCount: 0 }),
    };
  }

  const unresolvedLeft = lower.filter((bar) => !topologyResolved(bar));
  const unresolvedRight = upper.filter((bar) => !topologyResolved(bar));
  const resolvedLeft = lower.filter(topologyResolved);
  const resolvedRight = upper.filter(topologyResolved);

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
          reason: 'column-topology-frame-mismatch',
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
      ruleId: 'COLUMN-CORNER-PRIORITY',
      cornerMatchCount: corner.matches.length,
    }),
  };
}
