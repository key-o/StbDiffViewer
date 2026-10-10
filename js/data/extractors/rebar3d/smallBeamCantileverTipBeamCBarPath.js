/**
 * @fileoverview R12-AM 図9-4 C形筋の明示断面geometryをactual-arc member-local RebarPathへ変換する。
 *
 * 図9-4はC形筋の断面内高さ・開口方向を一意に規定しないため、project detailの
 * EXPLICIT_MEMBER_LOCAL geometryが検証済みの場合だけ生成する。25d脚長と曲げ半径は
 * R12-AKの標準ruleを正本とし、project値で上書きしない。
 */

import { createLine, createRebarPath, getPathEnd, getPathStart } from './rebarPath.js';
import { resolveRoundedTransitionCorner } from './rebarTransitionArcGeometry.js';
import { validateTangentContinuousRebarPath } from './shearRebarPathGeometry.js';
import { resolveSmallBeamCantileverTipBeamCBarCrossSection } from './smallBeamCantileverTipBeamProjectDetailing.js';

const SOURCE = 'R12-AM-small-beam-cantilever-tip-beam-c-bar-cross-section-path';
const EPS = 1e-6;

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    pathReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    paths: [],
    blockers: [reason],
    ...extra,
  };
}

function explicitCrossSection(fact) {
  const contract = resolveSmallBeamCantileverTipBeamCBarCrossSection(
    fact?.tipBeamDetailing?.assignment?.cBarCrossSection,
  );
  if (!contract.resolved) {
    return { ok: false, reason: contract.reason };
  }
  return {
    ok: true,
    value: {
      ...contract.value,
      openSign: contract.value.openDirection === 'POSITIVE_U' ? 1 : -1,
    },
  };
}

function appendLine(primitives, start, end) {
  if (Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z) <= EPS) {
    return;
  }
  primitives.push(createLine(start, end));
}

function buildStationPath({ fact, station, crossSection, cBarPlan }) {
  const z = Number(station?.tipBeamLocalZMm);
  const legLengthMm = Number(cBarPlan?.legLengthMm);
  const diaMm = Number(cBarPlan?.diaMm);
  const grade = cBarPlan?.grade || cBarPlan?.normalizedGrade || null;
  if (!Number.isFinite(z) || !(legLengthMm > 0) || !(diaMm > 0) || !grade) {
    return unresolved('cantilever-tip-beam-c-bar-path-input-unresolved', {
      station,
    });
  }

  const sign = crossSection.openSign;
  const topCorner = { x: crossSection.spineUMm, y: crossSection.topVMm, z };
  const bottomCorner = { x: crossSection.spineUMm, y: crossSection.bottomVMm, z };
  const topFree = {
    x: crossSection.spineUMm + sign * legLengthMm,
    y: crossSection.topVMm,
    z,
  };
  const bottomFree = {
    x: crossSection.spineUMm + sign * legLengthMm,
    y: crossSection.bottomVMm,
    z,
  };

  const topBend = resolveRoundedTransitionCorner({
    corner: topCorner,
    incomingDirection: { x: -sign, y: 0, z: 0 },
    outgoingDirection: { x: 0, y: -1, z: 0 },
    grade,
    barDiaMm: diaMm,
  });
  if (!topBend.ok) {
    return unresolved(topBend.reason || 'cantilever-tip-beam-c-bar-top-bend-unresolved', {
      station,
      topBend,
    });
  }

  const bottomBend = resolveRoundedTransitionCorner({
    corner: bottomCorner,
    incomingDirection: { x: 0, y: -1, z: 0 },
    outgoingDirection: { x: sign, y: 0, z: 0 },
    grade,
    barDiaMm: diaMm,
  });
  if (!bottomBend.ok) {
    return unresolved(bottomBend.reason || 'cantilever-tip-beam-c-bar-bottom-bend-unresolved', {
      station,
      bottomBend,
    });
  }

  const topStraightMm = legLengthMm - topBend.tangentDistanceMm;
  const bottomStraightMm = legLengthMm - bottomBend.tangentDistanceMm;
  const spineStraightMm =
    crossSection.topVMm -
    crossSection.bottomVMm -
    topBend.tangentDistanceMm -
    bottomBend.tangentDistanceMm;
  if (!(topStraightMm > EPS) || !(bottomStraightMm > EPS)) {
    return unresolved('cantilever-tip-beam-c-bar-leg-too-short-for-bend', {
      station,
      legLengthMm,
      topStraightMm,
      bottomStraightMm,
    });
  }
  if (!(spineStraightMm > EPS)) {
    return unresolved('cantilever-tip-beam-c-bar-spine-too-short-for-bends', {
      station,
      spineStraightMm,
      verticalSpanMm: crossSection.topVMm - crossSection.bottomVMm,
    });
  }

  const primitives = [];
  appendLine(primitives, topFree, topBend.incomingTangent);
  primitives.push(topBend.arc);
  appendLine(primitives, topBend.outgoingTangent, bottomBend.incomingTangent);
  primitives.push(bottomBend.arc);
  appendLine(primitives, bottomBend.outgoingTangent, bottomFree);

  const path = createRebarPath(primitives, {
    memberId: String(fact.tipBeamId),
    memberTag: 'StbBeam',
    coordinateSpace: 'member-local',
    source: SOURCE,
    ruleId: 'R12-AM',
    sourceFigure: fact.figureCase,
    role: 'c-bar',
    rebarRole: 'cantilever-tip-beam-c-bar',
    dia: diaMm,
    grade,
    bendGeometry: 'actual-arc',
    bendAnglesDeg: [90, 90],
    insideDiameterMm: [topBend.insideDiameterMm, bottomBend.insideDiameterMm],
    centerlineRadiusMm: [topBend.centerlineRadiusMm, bottomBend.centerlineRadiusMm],
    stationIndex: station.index ?? null,
    tipBeamStationMm: station.fromTipBeamStartMm ?? null,
    offsetFromConnectionMm: station.offsetFromConnectionMm ?? null,
    crossSectionMode: crossSection.mode,
    cBarOpenDirection: crossSection.openDirection,
  });
  const validation = validateTangentContinuousRebarPath(path);
  if (!validation.ok) {
    return unresolved('cantilever-tip-beam-c-bar-path-invalid', {
      station,
      validation,
    });
  }

  return {
    resolved: true,
    pathReady: true,
    productionReady: false,
    reason: null,
    source: SOURCE,
    station,
    path,
    pathStart: getPathStart(path),
    pathEnd: getPathEnd(path),
    topStraightMm,
    spineStraightMm,
    bottomStraightMm,
    blockers: ['cantilever-tip-beam-c-bar-world-path-not-yet-connected'],
  };
}

export function resolveSmallBeamCantileverTipBeamCBarPaths(fact) {
  if (!fact?.resolved) {
    return unresolved(fact?.reason || 'cantilever-tip-beam-fact-unresolved');
  }
  const stationing = fact.tipBeamCBarStationing;
  const cBarPlan = fact.tipBeamPathPlan?.cBarPlan;
  if (
    !stationing?.resolved ||
    stationing.stationingReady !== true ||
    !Array.isArray(stationing.stations) ||
    stationing.stations.length === 0
  ) {
    return unresolved(stationing?.reason || 'cantilever-tip-beam-c-bar-stationing-not-ready');
  }
  if (!cBarPlan) {
    return unresolved('cantilever-tip-beam-c-bar-plan-unresolved');
  }

  const crossSection = explicitCrossSection(fact);
  if (!crossSection.ok) return unresolved(crossSection.reason);

  const entries = stationing.stations.map((station) =>
    buildStationPath({
      fact,
      station,
      crossSection: crossSection.value,
      cBarPlan,
    }),
  );
  const failed = entries.find((entry) => !entry.resolved);
  if (failed) {
    return unresolved(failed.reason, {
      failedEntry: failed,
      entries,
    });
  }

  return {
    resolved: true,
    pathReady: true,
    productionReady: false,
    reason: null,
    source: SOURCE,
    crossSection: crossSection.value,
    stationCount: entries.length,
    entries,
    paths: entries.map((entry) => entry.path),
    blockers: ['cantilever-tip-beam-c-bar-world-path-not-yet-connected'],
  };
}

export function attachSmallBeamCantileverTipBeamCBarPaths(facts) {
  if (!facts?.beam) {
    return {
      ...(facts || {}),
      cBarPathUnresolved: [],
    };
  }

  const cBarPathUnresolved = [];
  for (const [elementId, fact] of facts.beam) {
    if (!fact?.resolved) continue;
    fact.tipBeamCBarPaths = resolveSmallBeamCantileverTipBeamCBarPaths(fact);
    if (fact.tipBeamCBarPaths.resolved) {
      if (fact.tipBeamPathPlan?.cBarPlan) {
        fact.tipBeamPathPlan.cBarPlan = {
          ...fact.tipBeamPathPlan.cBarPlan,
          crossSectionReady: true,
          pathReady: true,
          paths: fact.tipBeamCBarPaths.paths,
        };
      }
      fact.tipBeamPathPlan.blockers = [
        ...(fact.tipBeamPathPlan?.blockers || []).filter(
          (blocker) => blocker !== 'cantilever-tip-beam-c-bar-cross-section-path-not-yet-resolved',
        ),
        'cantilever-tip-beam-c-bar-world-path-not-yet-connected',
      ].filter((value, index, array) => array.indexOf(value) === index);
    } else {
      cBarPathUnresolved.push({
        elementId: String(elementId),
        tipBeamId: fact.tipBeamId || null,
        figureCase: fact.figureCase || null,
        reason: fact.tipBeamCBarPaths.reason,
      });
    }
  }

  return {
    ...facts,
    cBarPathUnresolved,
  };
}
