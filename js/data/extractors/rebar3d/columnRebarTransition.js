/**
 * @fileoverview 日建連・JSCA 2023 §7-4 の上下階柱主筋の位置遷移。
 * eは対応する主筋中心間の水平距離。jt不明・不正値は推定生成しない。
 * R10-Dでは折曲げ通し中心線を表2-1/§2-1注2の実半径Arcへ置換する。
 */
import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { createLine, createRebarPath, validateRebarPath } from './rebarPath.js';
import { buildDoglegTransitionPath } from './rebarTransitionArcGeometry.js';

export const COLUMN_BENT_CONTINUOUS_MAX_RATIO = 1 / 6;
export const COLUMN_SEPARATE_ANCHORAGE_BEAM_FACE_FACTOR = 15;
const EPS = 1e-6;

/** 空値やbooleanを0に変換しない。 */
export function finiteTransitionNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finitePoint(bar) {
  const u = finiteTransitionNumber(bar?.u);
  const v = finiteTransitionNumber(bar?.v);
  return u !== null && v !== null ? { u, v } : null;
}

export function columnBarSemanticKey(bar) {
  const grade = REBAR_STANDARD_RULES.normalizeGrade(bar?.grade) || bar?.grade || '';
  return [bar?.role || 'main', bar?.layer ?? '', bar?.diaName || `D${bar?.dia}`, grade]
    .map((value) => String(value).toUpperCase())
    .join('|');
}

/** SEPARATE_ANCHORAGEは別定着が必要という分類であり、定着可否OKを意味しない。 */
export function classifyColumnBarTransition({ bottomBar, topBar, jtMm }, options = {}) {
  const result = {
    bottomBar,
    topBar,
    eMm: null,
    jtMm: finiteTransitionNumber(jtMm),
    ratio: null,
    maxRatio: COLUMN_BENT_CONTINUOUS_MAX_RATIO,
    disposition: 'SPECIAL',
    unresolvedReason: null,
  };
  const special = (reason) => ({ ...result, unresolvedReason: reason });
  const bottom = finitePoint(bottomBar);
  const top = finitePoint(topBar);
  if (!bottom || !top) return special('invalid-bar-position');
  if ([bottomBar, topBar].some((bar) => !(finiteTransitionNumber(bar?.dia) > 0))) {
    return special('invalid-bar-diameter');
  }
  if ([bottomBar, topBar].some((bar) => bar?.placementEstimated || bar?.unresolvedMatch)) {
    return special('bar-identity-unresolved');
  }
  if (
    columnBarSemanticKey(bottomBar) !== columnBarSemanticKey(topBar) ||
    Number(bottomBar.dia) !== Number(topBar.dia)
  ) {
    return special('semantic-mismatch');
  }
  const maxRatio = finiteTransitionNumber(options.maxRatio);
  if (maxRatio !== null && (!(maxRatio > 0) || maxRatio > result.maxRatio)) {
    return special('unsupported-ratio-override');
  }
  result.maxRatio = maxRatio ?? result.maxRatio;
  result.eMm = Math.hypot(top.u - bottom.u, top.v - bottom.v);
  if (result.eMm <= EPS) {
    return {
      ...result,
      jtMm: result.jtMm > 0 ? result.jtMm : null,
      ratio: 0,
      disposition: 'STRAIGHT',
    };
  }
  if (!(result.jtMm > 0)) return special('jt-unresolved');
  result.ratio = result.eMm / result.jtMm;
  return {
    ...result,
    disposition: result.ratio <= result.maxRatio + 1e-9 ? 'BENT_CONTINUOUS' : 'SEPARATE_ANCHORAGE',
  };
}

/**
 * §7-4-2 の別定着に必要な上下柱主筋のZ制約を、§7-1のL2・15dから求める。
 * ここでは上下の筋を接続しない。実際のmember path置換はcolumnJointRenderPlanで行う。
 */
export function buildColumnSeparateAnchorageConstraints(transition, options = {}) {
  const fail = (unresolvedReason) => ({ unresolvedReason });
  if (!transition) return fail('special-required');

  const classified = classifyColumnBarTransition(transition, { maxRatio: transition.maxRatio });
  if (classified.disposition !== transition.disposition) {
    return fail('transition-contract-mismatch');
  }
  if (classified.disposition !== 'SEPARATE_ANCHORAGE') {
    return fail(classified.unresolvedReason || 'separate-anchorage-not-required');
  }

  const beamLevels = options.beamLevels;
  const highestBottomZ = finiteTransitionNumber(beamLevels?.highestBottomZ);
  const highestTopZ = finiteTransitionNumber(beamLevels?.highestTopZ);
  const lowestTopZ = finiteTransitionNumber(beamLevels?.lowestTopZ);
  const lowestBottomZ = finiteTransitionNumber(beamLevels?.lowestBottomZ);
  if ([highestBottomZ, highestTopZ, lowestTopZ, lowestBottomZ].some((value) => value === null)) {
    return fail('beam-face-levels-unresolved');
  }

  const lowerFc = finiteTransitionNumber(options.lowerFc);
  const upperFc = finiteTransitionNumber(options.upperFc);
  if (!(lowerFc > 0) || !(upperFc > 0)) {
    return fail('column-concrete-strength-unresolved');
  }

  const lowerGrade =
    REBAR_STANDARD_RULES.normalizeGrade(transition.bottomBar?.grade) ||
    transition.bottomBar?.grade ||
    '';
  const upperGrade =
    REBAR_STANDARD_RULES.normalizeGrade(transition.topBar?.grade) || transition.topBar?.grade || '';
  const lowerL2 = REBAR_STANDARD_RULES.resolveLengthFactor({
    kind: 'l2',
    fc: lowerFc,
    grade: lowerGrade,
  });
  const upperL2 = REBAR_STANDARD_RULES.resolveLengthFactor({
    kind: 'l2',
    fc: upperFc,
    grade: upperGrade,
  });
  if (!lowerL2.ok || !upperL2.ok) return fail('l2-unresolved');

  const lowerDia = Number(transition.bottomBar.dia);
  const upperDia = Number(transition.topBar.dia);
  const lowerL2Mm = lowerL2.factor * lowerDia;
  const upperL2Mm = upperL2.factor * upperDia;
  const lower15dMm = COLUMN_SEPARATE_ANCHORAGE_BEAM_FACE_FACTOR * lowerDia;
  const upper15dMm = COLUMN_SEPARATE_ANCHORAGE_BEAM_FACE_FACTOR * upperDia;

  const lowerEndZ = Math.max(highestBottomZ + lowerL2Mm, highestTopZ + lower15dMm);
  const upperStartZ = Math.min(lowestTopZ - upperL2Mm, lowestBottomZ - upper15dMm);
  if (![lowerEndZ, upperStartZ].every(Number.isFinite)) {
    return fail('separate-anchorage-geometry-unresolved');
  }

  return {
    unresolvedReason: null,
    lowerEndZ,
    upperStartZ,
    lowerL2Mm,
    upperL2Mm,
    lower15dMm,
    upper15dMm,
    lowerL2Factor: lowerL2.factor,
    upperL2Factor: upperL2.factor,
    standardId: lowerL2.standardId || upperL2.standardId || 'NIKKENREN-JSCA-2023',
  };
}

/**
 * 部材中心原点のRebarPath。実折曲げ区間から勾配を再検証し、
 * 大きなjtを渡して短い区間へ急な折曲げを生成することを防ぐ。
 * BENT_CONTINUOUSは上下のsharp bend点を実半径Arcで丸めるため、両側直線runに
 * 接線距離を確保できない場合はfail-closedとする。
 */
export function buildColumnTransitionRebarPath(transition, memberLengthMm, options = {}) {
  const length = finiteTransitionNumber(memberLengthMm);
  const fail = (unresolvedReason) => ({ path: null, unresolvedReason });
  if (!(length > 0)) return fail('member-length');
  if (!transition) return fail('special-required');
  const classified = classifyColumnBarTransition(transition, { maxRatio: transition.maxRatio });
  if (classified.disposition !== transition.disposition)
    return fail('transition-contract-mismatch');
  if (!['STRAIGHT', 'BENT_CONTINUOUS'].includes(classified.disposition)) {
    return fail(classified.unresolvedReason || 'separate-anchorage-required');
  }

  const bottom = finitePoint(transition.bottomBar);
  const top = finitePoint(transition.topBar);
  const bar = transition.bottomBar;
  const memberStart = { x: bottom.u, y: bottom.v, z: -length / 2 };
  const memberEnd = { x: top.u, y: top.v, z: length / 2 };

  if (classified.disposition === 'STRAIGHT') {
    const path = createRebarPath([createLine(memberStart, memberEnd)], {
      role: bar.role,
      layer: bar.layer,
      dia: Number(bar.dia),
      diaName: bar.diaName,
      grade: bar.grade,
      source: 'column-r6-transition',
      ruleId: 'R6',
      disposition: classified.disposition,
      eMm: classified.eMm,
      jtMm: classified.jtMm,
      ratio: classified.ratio,
      coordinateSpace: 'member-local',
      bendGeometry: 'straight',
    });
    const validation = validateRebarPath(path);
    return validation.ok ? { path, unresolvedReason: null } : fail(validation.errors.join(','));
  }

  const start = finiteTransitionNumber(options.bendStartRatio);
  const end = finiteTransitionNumber(options.bendEndRatio);
  if (start === null || end === null || start < 0 || end > 1 || !(end > start)) {
    return fail('bend-zone-unresolved');
  }
  const bendRunMm = length * (end - start);
  if (classified.eMm / bendRunMm > classified.maxRatio + 1e-9) {
    return fail('bend-zone-too-short');
  }

  const sharpStart = {
    x: bottom.u,
    y: bottom.v,
    z: length * (start - 0.5),
  };
  const sharpEnd = {
    x: top.u,
    y: top.v,
    z: length * (end - 0.5),
  };
  const rounded = buildDoglegTransitionPath({
    sharpStart,
    sharpEnd,
    incomingDirection: { x: 0, y: 0, z: 1 },
    outgoingDirection: { x: 0, y: 0, z: 1 },
    grade: bar.grade,
    barDiaMm: Number(bar.dia),
    metadata: {
      role: bar.role,
      layer: bar.layer,
      diaName: bar.diaName,
      source: 'column-r6-transition',
      ruleId: 'R6',
      disposition: classified.disposition,
      eMm: classified.eMm,
      jtMm: classified.jtMm,
      ratio: classified.ratio,
      bendStartRatio: start,
      bendEndRatio: end,
      coordinateSpace: 'member-local',
    },
  });
  if (!rounded.path) return fail(rounded.reason || 'bend-arc-unresolved');

  const roundedStart = rounded.startCorner.incomingTangent;
  const roundedEnd = rounded.endCorner.outgoingTangent;
  if (!(roundedStart.z > memberStart.z + EPS) || !(memberEnd.z > roundedEnd.z + EPS)) {
    return fail('bend-radius-outside-member-run');
  }

  const path = createRebarPath(
    [
      createLine(memberStart, roundedStart),
      ...rounded.path.primitives,
      createLine(roundedEnd, memberEnd),
    ],
    {
      ...rounded.path.metadata,
      bendGeometry: 'actual-arc',
    },
  );
  const validation = validateRebarPath(path);
  return validation.ok ? { path, unresolvedReason: null } : fail(validation.errors.join(','));
}
