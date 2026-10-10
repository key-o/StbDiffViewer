/**
 * @fileoverview R12-AL 図9-4 C形筋の材軸stationを先端小梁あばら筋表示phaseへ一致させる。
 *
 * C形筋は「先端小梁あばら筋と同径・同間隔」なので、独自のfirst-bar phaseを作らない。
 * viewerのstirrup loopと同じcentered-spacing materializerを使い、片持ち梁幅Bと交差する
 * 先端小梁stationだけをC形筋候補として保持する。断面内C形geometryは後段。
 */

import { materializeHoopAxialPositions } from './rebarAxialPositions.js';

const SOURCE = 'R12-AL-small-beam-cantilever-tip-beam-c-bar-stationing';
const EPS = 1e-6;

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    stationingReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    stations: [],
    blockers: [reason],
    ...extra,
  };
}

function sameNumber(left, right) {
  return (
    Number.isFinite(Number(left)) &&
    Number.isFinite(Number(right)) &&
    Math.abs(Number(left) - Number(right)) <= EPS
  );
}

function stationMatchesCBar(station, cBarPlan) {
  const diaMatch = (station?.diaMm || []).some((dia) => sameNumber(dia, cBarPlan?.diaMm));
  const pitchMatch = sameNumber(station?.pitchMm, cBarPlan?.pitchMm);
  return diaMatch && pitchMatch;
}

function duplicateStations(stations) {
  const duplicates = [];
  for (let i = 1; i < stations.length; i += 1) {
    if (Math.abs(stations[i].fromStartMm - stations[i - 1].fromStartMm) <= EPS) {
      duplicates.push({
        left: stations[i - 1],
        right: stations[i],
      });
    }
  }
  return duplicates;
}

export function resolveSmallBeamCantileverTipBeamCBarStationing({
  fact,
  tipBeamStirrupLayout,
} = {}) {
  if (!fact?.resolved) {
    return unresolved(fact?.reason || 'cantilever-tip-beam-fact-unresolved');
  }

  const pathPlan = fact.tipBeamPathPlan;
  const cBarPlan = pathPlan?.cBarPlan;
  if (!pathPlan?.resolved || !cBarPlan) {
    return unresolved(
      pathPlan?.cBarRule?.reason ||
        pathPlan?.reason ||
        'cantilever-tip-beam-c-bar-path-plan-not-ready',
    );
  }

  const geometry = fact.tipBeamPlanGeometry;
  if (!geometry?.resolved) {
    return unresolved(geometry?.reason || 'cantilever-tip-beam-plan-geometry-unresolved');
  }
  if (geometry.horizontalPlanCompatible !== true) {
    return unresolved('cantilever-tip-beam-c-bar-sloped-plan-not-supported', {
      planLengthMm: geometry.planLengthMm ?? null,
      spatialLengthMm: geometry.spatialLengthMm ?? null,
    });
  }

  const memberLengthMm = Number(geometry.planLengthMm);
  const connectionStationMm = Number(geometry.connectionPlanStationMm);
  const cantileverBeamWidthMm = Number(fact.cantileverTipSection?.widthMm);
  if (
    !(memberLengthMm > 0) ||
    !Number.isFinite(connectionStationMm) ||
    !(cantileverBeamWidthMm > 0)
  ) {
    return unresolved('cantilever-tip-beam-c-bar-station-input-unresolved');
  }
  if (!tipBeamStirrupLayout?.segments?.length) {
    return unresolved('cantilever-tip-beam-stirrup-layout-unresolved');
  }

  const allStations = materializeHoopAxialPositions(tipBeamStirrupLayout, memberLengthMm);
  if (allStations.length === 0) {
    return unresolved('cantilever-tip-beam-stirrup-stations-empty');
  }

  const halfWidthMm = cantileverBeamWidthMm / 2;
  const overlapStartMm = Math.max(0, connectionStationMm - halfWidthMm);
  const overlapEndMm = Math.min(memberLengthMm, connectionStationMm + halfWidthMm);
  if (!(overlapEndMm > overlapStartMm - EPS)) {
    return unresolved('cantilever-tip-beam-c-bar-overlap-band-invalid', {
      connectionStationMm,
      cantileverBeamWidthMm,
      overlapStartMm,
      overlapEndMm,
    });
  }

  const overlapStations = allStations.filter(
    (station) =>
      station.fromStartMm >= overlapStartMm - EPS && station.fromStartMm <= overlapEndMm + EPS,
  );
  if (overlapStations.length === 0) {
    return unresolved('cantilever-tip-beam-c-bar-no-stirrup-station-in-overlap', {
      connectionStationMm,
      cantileverBeamWidthMm,
      overlapStartMm,
      overlapEndMm,
    });
  }

  const mismatched = overlapStations.filter((station) => !stationMatchesCBar(station, cBarPlan));
  if (mismatched.length > 0) {
    return unresolved('cantilever-tip-beam-c-bar-overlap-stirrup-rule-varies', {
      expectedDiaMm: cBarPlan.diaMm,
      expectedPitchMm: cBarPlan.pitchMm,
      mismatchedStations: mismatched,
    });
  }

  const duplicates = duplicateStations(overlapStations);
  if (duplicates.length > 0) {
    return unresolved('cantilever-tip-beam-c-bar-station-duplicate', {
      duplicates,
    });
  }

  const stations = overlapStations.map((station, index) => ({
    index,
    fromTipBeamStartMm: station.fromStartMm,
    tipBeamLocalZMm: station.localZMm,
    offsetFromConnectionMm: station.fromStartMm - connectionStationMm,
    pitchMm: station.pitchMm,
    diaMm: cBarPlan.diaMm,
    grade: cBarPlan.grade,
    positionZone: station.positionZone,
    sourceSegmentIndex: station.segmentIndex,
  }));

  return {
    resolved: true,
    stationingReady: true,
    productionReady: false,
    reason: null,
    source: SOURCE,
    geometryBasis: 'TIP_BEAM_PLAN_XY',
    memberLengthMm,
    connectionStationMm,
    cantileverBeamWidthMm,
    overlapStartMm,
    overlapEndMm,
    stationCount: stations.length,
    stations,
    blockers: ['cantilever-tip-beam-c-bar-cross-section-path-not-yet-resolved'],
  };
}

export function attachSmallBeamCantileverTipBeamCBarStationing(facts, beamStirrupLayoutMap) {
  if (!facts?.beam) {
    return {
      ...(facts || {}),
      cBarStationingUnresolved: [],
    };
  }

  const cBarStationingUnresolved = [];
  for (const [elementId, fact] of facts.beam) {
    if (!fact?.resolved) continue;
    const layout = beamStirrupLayoutMap?.get?.(String(fact.tipBeamSection?.sectionId));
    fact.tipBeamCBarStationing = resolveSmallBeamCantileverTipBeamCBarStationing({
      fact,
      tipBeamStirrupLayout: layout,
    });

    if (fact.tipBeamCBarStationing.resolved && fact.tipBeamPathPlan?.cBarPlan) {
      fact.tipBeamPathPlan.cBarPlan = {
        ...fact.tipBeamPathPlan.cBarPlan,
        stationingReady: true,
        stationSource: SOURCE,
        stations: fact.tipBeamCBarStationing.stations,
      };
      fact.tipBeamPathPlan.blockers = [
        ...(fact.tipBeamPathPlan.blockers || []).filter(
          (blocker) => blocker !== 'cantilever-tip-beam-c-bar-stationing-not-yet-resolved',
        ),
        'cantilever-tip-beam-c-bar-cross-section-path-not-yet-resolved',
      ].filter((value, index, array) => array.indexOf(value) === index);
    } else if (!fact.tipBeamCBarStationing.resolved) {
      cBarStationingUnresolved.push({
        elementId: String(elementId),
        tipBeamId: fact.tipBeamId || null,
        figureCase: fact.figureCase || null,
        reason: fact.tipBeamCBarStationing.reason,
      });
    }
  }

  return {
    ...facts,
    cBarStationingUnresolved,
  };
}
