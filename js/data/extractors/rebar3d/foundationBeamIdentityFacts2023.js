/**
 * @fileoverview R13 基礎大梁端部bar factsへ既存beam main-bar identityを付与する。
 *
 * beamRebarPathBuilderと同じassignBeamBarIdentities()を同一layoutへ適用し、
 * role/layer/dia/grade/u/vが一致する端部barだけをidentityへ接続する。
 * 一意に照合できない場合は推定せずbar/end/member単位でfail-closed情報を残す。
 */

import { assignBeamBarIdentities } from './rebarIdentityMatcher.js';

const POSITION_TOLERANCE_MM = 1e-6;
const SOURCE = 'R13-foundation-beam-identity-facts-2023';

function normalizeLayer(value) {
  return value === null || value === undefined || value === '' ? null : Number(value);
}

function gradeKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function mainBars(segment) {
  return (segment?.bars || []).filter((bar) => bar?.role === 'top' || bar?.role === 'bottom');
}

function endpointSegment(layout, side) {
  const segments = [...(layout?.segments || [])].filter(
    (segment) =>
      Number.isFinite(Number(segment?.startRatio)) && Number.isFinite(Number(segment?.endRatio)),
  );
  if (!segments.length) return null;
  segments.sort(
    (left, right) =>
      Number(left.startRatio) - Number(right.startRatio) ||
      Number(left.endRatio) - Number(right.endRatio),
  );
  return side === 'end' ? segments[segments.length - 1] : segments[0];
}

function matchesFact(raw, fact, tolerance = POSITION_TOLERANCE_MM) {
  return (
    raw?.role === fact?.role &&
    normalizeLayer(raw?.layer) === normalizeLayer(fact?.layer) &&
    Number(raw?.dia) === Number(fact?.diaMm) &&
    gradeKey(raw?.grade) === gradeKey(fact?.grade) &&
    Number.isFinite(Number(raw?.u)) &&
    Number.isFinite(Number(raw?.v)) &&
    Number.isFinite(Number(fact?.u)) &&
    Number.isFinite(Number(fact?.v)) &&
    Math.abs(Number(raw.u) - Number(fact.u)) <= tolerance &&
    Math.abs(Number(raw.v) - Number(fact.v)) <= tolerance
  );
}

function unresolvedBar(bar, reason, extra = {}) {
  return {
    ...bar,
    identityResolved: false,
    identityKey: null,
    identityStatus: 'unresolved',
    identityReason: reason,
    identitySource: SOURCE,
    ...extra,
  };
}

function resolveBarIdentity(bar, rawBars, tolerance) {
  const candidates = rawBars.filter((raw) => matchesFact(raw, bar, tolerance));
  if (candidates.length !== 1) {
    return unresolvedBar(
      bar,
      candidates.length === 0
        ? 'foundation-beam-identity-main-bar-not-found'
        : 'foundation-beam-identity-main-bar-ambiguous',
      { identityCandidateCount: candidates.length },
    );
  }
  const raw = candidates[0];
  if (!raw.identityKey || raw.unresolvedMatch === true || raw.identityStatus === 'unresolved') {
    return unresolvedBar(bar, 'foundation-beam-identity-main-bar-unresolved', {
      identityCandidateCount: 1,
      rawIdentityStatus: raw.identityStatus || null,
    });
  }
  return {
    ...bar,
    identityResolved: true,
    identityKey: raw.identityKey,
    identityStatus: raw.identityStatus || 'local',
    identityReason: null,
    identitySource: SOURCE,
  };
}

function enrichEnd(end, layout, tolerance) {
  if (!end || !['start', 'end'].includes(end.side)) return end;
  const segment = endpointSegment(layout, end.side);
  if (!segment) {
    return {
      ...end,
      bars: (end.bars || []).map((bar) =>
        unresolvedBar(bar, 'foundation-beam-identity-end-segment-unresolved'),
      ),
      identityResolved: false,
      identityReason: 'foundation-beam-identity-end-segment-unresolved',
      identitySource: SOURCE,
    };
  }
  const rawBars = mainBars(segment);
  const bars = (end.bars || []).map((bar) => resolveBarIdentity(bar, rawBars, tolerance));
  const identityResolved = bars.length > 0 && bars.every((bar) => bar.identityResolved === true);
  return {
    ...end,
    bars,
    identityResolved,
    identityReason: identityResolved
      ? null
      : bars.find((bar) => !bar.identityResolved)?.identityReason ||
        'foundation-beam-identity-unresolved',
    identitySource: SOURCE,
  };
}

export function applyFoundationBeamMainBarIdentities2023(
  mainBarFacts,
  girderLayoutMap,
  options = {},
) {
  if (!(mainBarFacts?.beam instanceof Map) || !(girderLayoutMap instanceof Map))
    return mainBarFacts;
  const tolerance = Number.isFinite(Number(options.positionToleranceMm))
    ? Number(options.positionToleranceMm)
    : POSITION_TOLERANCE_MM;
  const beam = new Map();
  const unresolved = [];

  for (const [elementId, sourceBeam] of mainBarFacts.beam) {
    if (sourceBeam?.memberTag !== 'StbGirder') {
      beam.set(String(elementId), sourceBeam);
      continue;
    }
    const layout = girderLayoutMap.get(String(sourceBeam.sectionId));
    if (!layout?.segments?.length) {
      const ends = (sourceBeam.ends || []).map((end) => ({
        ...end,
        bars: (end.bars || []).map((bar) =>
          unresolvedBar(bar, 'foundation-beam-identity-layout-missing'),
        ),
        identityResolved: false,
        identityReason: 'foundation-beam-identity-layout-missing',
        identitySource: SOURCE,
      }));
      const fact = { ...sourceBeam, ends, identityResolved: false, identitySource: SOURCE };
      beam.set(String(elementId), fact);
      unresolved.push({
        elementId: String(elementId),
        reason: 'foundation-beam-identity-layout-missing',
        source: SOURCE,
      });
      continue;
    }

    assignBeamBarIdentities(layout.segments, options.identityOptions || {});
    const ends = (sourceBeam.ends || []).map((end) => enrichEnd(end, layout, tolerance));
    const identityResolved = ends.length > 0 && ends.every((end) => end?.identityResolved === true);
    const fact = { ...sourceBeam, ends, identityResolved, identitySource: SOURCE };
    beam.set(String(elementId), fact);
    for (const end of ends) {
      if (end?.identityResolved === true) continue;
      unresolved.push({
        elementId: String(elementId),
        side: end?.side || null,
        reason: end?.identityReason || 'foundation-beam-identity-unresolved',
        source: SOURCE,
      });
    }
  }

  return {
    ...mainBarFacts,
    beam,
    identityUnresolved: unresolved,
  };
}

export const _foundationBeamIdentityFacts2023Internals = Object.freeze({
  endpointSegment,
  matchesFact,
  resolveBarIdentity,
  enrichEnd,
});
