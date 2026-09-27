/**
 * @fileoverview RC柱主筋の断面内配置算定（3D配筋用）
 */
import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { extractRcColumnSections } from '../columnSectionListExtractor.js';
import { buildColumnArrangementFacts } from './columnRebarFacts.js';
import { annotateColumnArrangementTopology } from './columnRebarTopology.js';
import { createSegment } from './rebarSectionUtils.js';

const SAME_POSITION_TOLERANCE_MM = 1e-6;
const SAME_POSITION_TOLERANCE_SQ = SAME_POSITION_TOLERANCE_MM ** 2;

function buildArrangement(dimensions, arrangement, options) {
  return annotateColumnArrangementTopology(
    buildColumnArrangementFacts(dimensions, arrangement, options),
    dimensions,
  );
}

function normalizedGrade(grade) {
  return REBAR_STANDARD_RULES.normalizeGrade(grade) || String(grade || '').toUpperCase() || null;
}

function identityKey(bar) {
  return [
    bar?.role || 'main',
    bar?.layer ?? '',
    bar?.diaName || bar?.dia || '',
    normalizedGrade(bar?.grade) || '',
  ]
    .map((value) => String(value).toUpperCase())
    .join('|');
}

function finitePosition(bar) {
  const u = Number(bar?.u);
  const v = Number(bar?.v);
  return Number.isFinite(u) && Number.isFinite(v) ? { u, v } : null;
}

function distanceSquared(first, second) {
  const left = finitePosition(first);
  const right = finitePosition(second);
  if (!left || !right) return Infinity;
  return (left.u - right.u) ** 2 + (left.v - right.v) ** 2;
}

function groupWithIndex(bars) {
  const groups = new Map();
  for (const [index, bar] of (bars || []).entries()) {
    const key = identityKey(bar);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ bar, index });
  }
  return groups;
}

function exactStraightMatches(top, bottom, semanticKey) {
  const matches = [];
  const remainingTop = top.slice();
  const remainingBottom = bottom.slice();

  while (remainingTop.length > 0 && remainingBottom.length > 0) {
    const round = [];
    for (const topItem of remainingTop) {
      const candidates = remainingBottom.filter(
        (bottomItem) => distanceSquared(topItem.bar, bottomItem.bar) <= SAME_POSITION_TOLERANCE_SQ,
      );
      if (candidates.length !== 1) continue;
      const bottomItem = candidates[0];
      const reverse = remainingTop.filter(
        (candidate) => distanceSquared(candidate.bar, bottomItem.bar) <= SAME_POSITION_TOLERANCE_SQ,
      );
      if (reverse.length !== 1 || reverse[0] !== topItem) continue;
      round.push({ topItem, bottomItem });
    }
    if (round.length === 0) break;
    for (const { topItem, bottomItem } of round) {
      matches.push({
        top: topItem.bar,
        bottom: bottomItem.bar,
        distanceSquared: 0,
        matchBasis: 'same-position',
        semanticKey,
      });
      remainingTop.splice(remainingTop.indexOf(topItem), 1);
      remainingBottom.splice(remainingBottom.indexOf(bottomItem), 1);
    }
  }

  return { matches, remainingTop, remainingBottom };
}

/**
 * TOP/BOTTOM bar factsを role/layer/dia/grade で対応付ける。
 *
 * 全体の距離greedyより先に同一断面内座標を確定し、直線で通せる筋を別のslotへ
 * 付け替えない。残筋は従来互換の最短距離 one-to-one でidentityを保持するが、
 * 位置差がある組は memberTransitionRequired として後段へ送り、3D本体では直線化しない。
 */
export function matchColumnBarFacts(topBars = [], bottomBars = []) {
  const topGroups = groupWithIndex(topBars);
  const bottomGroups = groupWithIndex(bottomBars);
  const keys = new Set([...topGroups.keys(), ...bottomGroups.keys()]);
  const matches = [];

  for (const key of keys) {
    const topGroup = topGroups.get(key) || [];
    const bottomGroup = bottomGroups.get(key) || [];
    if (topGroup.length === 0 || bottomGroup.length === 0) continue;

    const exact = exactStraightMatches(topGroup, bottomGroup, key);
    matches.push(...exact.matches);

    const candidates = [];
    for (const top of exact.remainingTop) {
      for (const bottom of exact.remainingBottom) {
        candidates.push({ top, bottom, distance: distanceSquared(top.bar, bottom.bar) });
      }
    }
    candidates.sort(
      (a, b) =>
        a.distance - b.distance || a.top.index - b.top.index || a.bottom.index - b.bottom.index,
    );
    const usedTop = new Set();
    const usedBottom = new Set();
    for (const candidate of candidates) {
      if (!Number.isFinite(candidate.distance)) continue;
      if (usedTop.has(candidate.top.index) || usedBottom.has(candidate.bottom.index)) continue;
      usedTop.add(candidate.top.index);
      usedBottom.add(candidate.bottom.index);
      matches.push({
        top: candidate.top.bar,
        bottom: candidate.bottom.bar,
        distanceSquared: candidate.distance,
        matchBasis: 'nearest-position-transition',
        semanticKey: key,
      });
    }
  }

  const matchedTop = new Set(matches.map((match) => match.top));
  const matchedBottom = new Set(matches.map((match) => match.bottom));
  return {
    matches,
    unmatchedTop: topBars.filter((bar) => !matchedTop.has(bar)),
    unmatchedBottom: bottomBars.filter((bar) => !matchedBottom.has(bar)),
  };
}

/**
 * 柱頭・柱脚の配筋差を通し筋と端部筋に分ける。
 *
 * 位置一致筋はそのまま通し、位置差のある対応筋はidentityを維持しつつ
 * memberTransitionRequiredを付ける。遷移位置・折曲げ形状はST-Bridgeから一意に
 * 決められないため、renderer側で全長直線化せずfail-closedにする。
 */
function splitByPosition(dimensions, arrangements, options) {
  const byPosition = (position) => arrangements.find((item) => item.position === position);
  const top = buildArrangement(dimensions, byPosition('TOP'), options);
  const bottom = buildArrangement(dimensions, byPosition('BOTTOM'), options);
  if (!top || !bottom) return null;

  const matched = matchColumnBarFacts(top.bars, bottom.bars);
  const memberTransitions = [];
  const throughBars = matched.matches.map((match) => {
    const memberTransitionRequired = match.distanceSquared > SAME_POSITION_TOLERANCE_SQ;
    const bar = {
      ...match.bottom,
      endpointPosition: {
        bottom: { u: match.bottom.u, v: match.bottom.v },
        top: { u: match.top.u, v: match.top.v },
      },
      memberTransitionRequired,
      memberTransitionBasis: match.matchBasis,
    };
    if (memberTransitionRequired) {
      memberTransitions.push({
        reason: 'column-member-position-transition-unresolved',
        semanticKey: match.semanticKey,
        bottomBar: match.bottom,
        topBar: match.top,
        distanceMm: Math.sqrt(match.distanceSquared),
      });
    }
    return bar;
  });
  const cutoffs = [];
  if (matched.unmatchedTop.length) cutoffs.push({ zone: 'top', bars: matched.unmatchedTop });
  if (matched.unmatchedBottom.length) {
    cutoffs.push({ zone: 'bottom', bars: matched.unmatchedBottom });
  }

  return {
    through: { ...bottom, bars: throughBars },
    cutoffs,
    endpointFacts: { top, bottom },
    memberTransitions,
  };
}

export function computeColumnRebarSectionLayout(sectionDetail, options = {}) {
  const dimensions = sectionDetail?.dimensions;
  if (!dimensions?.type) return null;

  const arrangements = sectionDetail.arrangements || [];
  const split = splitByPosition(dimensions, arrangements, options);
  const built =
    split?.through ??
    buildArrangement(
      dimensions,
      {
        mainBar: sectionDetail.mainBar,
        hoop: sectionDetail.hoop,
        coreBar: sectionDetail.coreBar,
        cover: sectionDetail.cover,
      },
      options,
    );
  if (!built) return null;

  const shape = dimensions.type === 'CIRCLE' ? 'CIRCLE' : 'RECTANGLE';
  const cutoffs = split?.cutoffs || [];
  const memberTransitions = split?.memberTransitions || [];
  return {
    kind: 'columnMain',
    shape,
    ...(shape === 'CIRCLE'
      ? { diameter: dimensions.diameter || 0 }
      : { width: dimensions.width || 0, height: dimensions.height || 0 }),
    segments: [createSegment(0, 1, built.bars)],
    // 旧APIは片側だけのケースに限り維持する。
    cutoff: cutoffs.length === 1 ? cutoffs[0] : null,
    cutoffs,
    endpointFacts: split?.endpointFacts || null,
    memberTransitions,
    sectionName: sectionDetail.name || null,
    dt: built.dt,
    dtFaces: built.dtFaces,
    coverMm: built.coverMm,
    hoopDia: built.hoopDia,
    mainDia: built.mainDia,
    secondLayerInterval: built.secondLayerInterval,
    unresolved: [
      ...(built.unresolved || []),
      ...memberTransitions.map((transition) => transition.reason),
    ],
    estimated: built.estimated,
  };
}

export function buildColumnRebarLayoutMap(xmlDoc, options = {}) {
  const layouts = new Map();
  if (!xmlDoc) return layouts;
  for (const [sectionId, detail] of extractRcColumnSections(xmlDoc)) {
    const layout = computeColumnRebarSectionLayout(detail, options);
    if (layout) layouts.set(sectionId, layout);
  }
  return layouts;
}
