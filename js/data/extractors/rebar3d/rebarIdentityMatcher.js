/**
 * @fileoverview RC梁主筋の区間間 identity matcher
 *
 * LEFT/CENTER/RIGHT の独立した断面内配置を、role / layer / dia / grade / face の
 * semantic key を先に一致させたうえで、断面内位置の距離から one-to-one 対応する。
 * 単純nearest matchingは行わず、相互に一意な最近傍だけを確定し、同距離候補は
 * unresolved として残す。
 *
 * @module data/extractors/rebar3d/rebarIdentityMatcher
 */

const DEFAULT_MAX_NORMALIZED_DISTANCE = 0.2;
const DEFAULT_TIE_TOLERANCE = 1e-9;

function text(value, fallback = '') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function roleLayerFaceKey(bar) {
  const role = text(bar?.role, 'UNKNOWN');
  const layer = text(bar?.layer, '-');
  const face = text(bar?.face ?? bar?.side, role);
  return `${role}|${layer}|${face}`;
}

/**
 * 鉄筋を通し筋候補集合へ分ける semantic key。
 * 径名があれば径名を優先し、なければ数値径を使う。
 */
export function rebarSemanticKey(bar) {
  const dia = text(bar?.diaName, Number.isFinite(Number(bar?.dia)) ? Number(bar.dia) : 'UNKNOWN');
  const grade = text(bar?.grade, '-');
  return `${roleLayerFaceKey(bar)}|${dia}|${grade}`;
}

function groupBy(values, keyOf) {
  const result = new Map();
  for (const value of values || []) {
    const key = keyOf(value);
    const list = result.get(key);
    if (list) list.push(value);
    else result.set(key, [value]);
  }
  return result;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedCoordinate(bar, axis, bounds) {
  if (axis === 'u') {
    const width = finite(bar?.sectionWidthMm);
    const u = finite(bar?.u);
    if (u === null) return NaN;
    if (width !== null && width > 0) return u / (width / 2);
    if (bounds.rangeU > 0) return ((u - bounds.minU) / bounds.rangeU) * 2 - 1;
    return 0;
  }

  const depth = finite(bar?.sectionDepthMm);
  const centerFromTop = finite(bar?.centerFromTopMm);
  if (depth !== null && depth > 0 && centerFromTop !== null) {
    return centerFromTop / depth;
  }
  const v = finite(bar?.v);
  if (v === null) return NaN;
  if (depth !== null && depth > 0) return v / (depth / 2);
  if (bounds.rangeV > 0) return ((v - bounds.minV) / bounds.rangeV) * 2 - 1;
  return 0;
}

function groupBounds(bars) {
  const us = bars.map((bar) => finite(bar?.u)).filter((value) => value !== null);
  const vs = bars.map((bar) => finite(bar?.v)).filter((value) => value !== null);
  const minU = us.length ? Math.min(...us) : 0;
  const maxU = us.length ? Math.max(...us) : 0;
  const minV = vs.length ? Math.min(...vs) : 0;
  const maxV = vs.length ? Math.max(...vs) : 0;
  return { minU, maxU, rangeU: maxU - minU, minV, maxV, rangeV: maxV - minV };
}

function positionDistance(left, right, leftBounds, rightBounds) {
  const lu = normalizedCoordinate(left, 'u', leftBounds);
  const lv = normalizedCoordinate(left, 'v', leftBounds);
  const ru = normalizedCoordinate(right, 'u', rightBounds);
  const rv = normalizedCoordinate(right, 'v', rightBounds);
  if (![lu, lv, ru, rv].every(Number.isFinite)) return Infinity;
  return Math.hypot(lu - ru, lv - rv);
}

function uniqueNearest(source, candidates, sourceBounds, candidateBounds, tieTolerance) {
  const result = new Map();
  for (const item of source) {
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        distance: positionDistance(item, candidate, sourceBounds, candidateBounds),
      }))
      .sort((a, b) => a.distance - b.distance);
    if (ranked.length === 0 || !Number.isFinite(ranked[0].distance)) continue;
    const tied =
      ranked.length > 1 && Math.abs(ranked[1].distance - ranked[0].distance) <= tieTolerance;
    result.set(item, {
      candidate: ranked[0].candidate,
      distance: ranked[0].distance,
      unique: !tied,
    });
  }
  return result;
}

function matchSemanticGroup(leftBars, rightBars, options, semanticKey) {
  const maxDistance = Number.isFinite(Number(options.maxNormalizedDistance))
    ? Number(options.maxNormalizedDistance)
    : DEFAULT_MAX_NORMALIZED_DISTANCE;
  const tieTolerance = Number.isFinite(Number(options.tieTolerance))
    ? Number(options.tieTolerance)
    : DEFAULT_TIE_TOLERANCE;
  const leftBounds = groupBounds(leftBars);
  const rightBounds = groupBounds(rightBars);
  const left = leftBars.slice();
  const right = rightBars.slice();
  const matches = [];

  while (left.length > 0 && right.length > 0) {
    const leftNearest = uniqueNearest(left, right, leftBounds, rightBounds, tieTolerance);
    const rightNearest = uniqueNearest(right, left, rightBounds, leftBounds, tieTolerance);
    const round = [];

    for (const leftBar of left) {
      const forward = leftNearest.get(leftBar);
      if (!forward?.unique || forward.distance > maxDistance) continue;
      const reverse = rightNearest.get(forward.candidate);
      if (!reverse?.unique || reverse.candidate !== leftBar) continue;
      if (Math.abs(reverse.distance - forward.distance) > tieTolerance) continue;
      round.push({
        left: leftBar,
        right: forward.candidate,
        distance: forward.distance,
        semanticKey,
      });
    }

    if (round.length === 0) break;
    for (const pair of round) {
      matches.push(pair);
      left.splice(left.indexOf(pair.left), 1);
      right.splice(right.indexOf(pair.right), 1);
    }
  }

  if (left.length > 0 && right.length > 0) {
    return {
      matches,
      unmatchedLeft: [],
      unmatchedRight: [],
      unresolved: [
        {
          reason: 'ambiguous-position-match',
          semanticKey,
          leftBars: left,
          rightBars: right,
        },
      ],
    };
  }

  return {
    matches,
    unmatchedLeft: left,
    unmatchedRight: right,
    unresolved: [],
  };
}

/**
 * 2区間のbar factsをsemantic-firstで対応付ける。
 * semantic key不一致でも role/layer/face が同じなら異径・異材質切替とみなし unresolved。
 */
export function matchRebarFacts(leftBars, rightBars, options = {}) {
  const leftByBase = groupBy(leftBars, roleLayerFaceKey);
  const rightByBase = groupBy(rightBars, roleLayerFaceKey);
  const baseKeys = new Set([...leftByBase.keys(), ...rightByBase.keys()]);
  const result = {
    matches: [],
    unmatchedLeft: [],
    unmatchedRight: [],
    unresolved: [],
  };

  for (const baseKey of baseKeys) {
    const leftBase = leftByBase.get(baseKey) || [];
    const rightBase = rightByBase.get(baseKey) || [];
    if (leftBase.length === 0) {
      result.unmatchedRight.push(...rightBase);
      continue;
    }
    if (rightBase.length === 0) {
      result.unmatchedLeft.push(...leftBase);
      continue;
    }

    const leftBySemantic = groupBy(leftBase, rebarSemanticKey);
    const rightBySemantic = groupBy(rightBase, rebarSemanticKey);
    const semanticKeys = new Set([...leftBySemantic.keys(), ...rightBySemantic.keys()]);
    for (const semanticKey of semanticKeys) {
      const left = leftBySemantic.get(semanticKey) || [];
      const right = rightBySemantic.get(semanticKey) || [];
      if (left.length === 0 || right.length === 0) {
        result.unresolved.push({
          reason: 'semantic-mismatch',
          baseKey,
          semanticKey,
          leftBars: left,
          rightBars: right,
        });
        continue;
      }
      const matched = matchSemanticGroup(left, right, options, semanticKey);
      result.matches.push(...matched.matches);
      result.unmatchedLeft.push(...matched.unmatchedLeft);
      result.unmatchedRight.push(...matched.unmatchedRight);
      result.unresolved.push(...matched.unresolved);
    }
  }

  return result;
}

function mainBars(segment) {
  return (segment?.bars || []).filter((bar) => bar?.role === 'top' || bar?.role === 'bottom');
}

function nextIdentity(serials, bar) {
  const key = rebarSemanticKey(bar);
  const serial = (serials.get(key) || 0) + 1;
  serials.set(key, serial);
  return `${key}#${serial}`;
}

/**
 * LEFT→CENTER→RIGHT の主筋へ安定した identityKey を付ける。
 * bar facts自体へmetadataを付加するため、segmentとpositionFactsが同一bar objectを共有する
 * 現行layoutでも同じidentityを参照できる。
 */
export function assignBeamBarIdentities(segments, options = {}) {
  const serials = new Map();
  const transitions = [];
  const unresolvedMatches = [];
  if (!Array.isArray(segments) || segments.length === 0) {
    return { transitions, unresolvedMatches };
  }

  for (const bar of mainBars(segments[0])) {
    bar.identityKey = nextIdentity(serials, bar);
    bar.identityStatus = 'local';
    bar.unresolvedMatch = false;
  }

  for (let index = 1; index < segments.length; index += 1) {
    const previous = mainBars(segments[index - 1]);
    const current = mainBars(segments[index]);
    const matched = matchRebarFacts(previous, current, options);

    for (const pair of matched.matches) {
      pair.right.identityKey = pair.left.identityKey || nextIdentity(serials, pair.left);
      pair.right.identityStatus = 'matched';
      pair.right.unresolvedMatch = false;
    }
    for (const bar of matched.unmatchedRight) {
      bar.identityKey = nextIdentity(serials, bar);
      bar.identityStatus = 'local';
      bar.unresolvedMatch = false;
    }
    for (const unresolved of matched.unresolved) {
      for (const bar of unresolved.rightBars || []) {
        bar.identityKey = null;
        bar.identityStatus = 'unresolved';
        bar.unresolvedMatch = true;
      }
      unresolvedMatches.push({ transitionIndex: index - 1, ...unresolved });
    }

    transitions.push({
      fromZone: segments[index - 1].positionZone || null,
      toZone: segments[index].positionZone || null,
      matches: matched.matches,
      unmatchedFrom: matched.unmatchedLeft,
      unmatchedTo: matched.unmatchedRight,
      unresolved: matched.unresolved,
    });
  }

  return { transitions, unresolvedMatches };
}
