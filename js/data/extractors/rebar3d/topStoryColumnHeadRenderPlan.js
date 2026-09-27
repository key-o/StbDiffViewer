/**
 * @fileoverview R8-D: 最上階柱頭の柱内拘束筋をproductionへ渡すrender plan。
 *
 * STANDARD_WITH_STBでは図8-2-5の「上側梁主筋側」をworld座標で一意に解けたケースを
 * placement candidateとして公開し、閉鎖形状・フック形状は推定しない。
 * EXPLICITではproject detailingに対象モデル・柱頭とworld Line中心線が明示された場合だけRebarPathへ変換する。
 */

import { buildTopStoryColumnHeadDetailingChecks } from './topStoryColumnHeadDetailing.js';
import { createLine, createRebarPath, validateRebarPath } from './rebarPath.js';
import {
  SPECIAL_DETAILING_GATE_STATUS,
  SPECIAL_DETAILING_PRODUCTION_MODE,
  resolveSpecialDetailingProductionGate,
} from './specialDetailingProductionGate.js';

function gateFields(raw, gate) {
  return {
    ...raw,
    productionGateStatus: gate.status,
    productionGateReady: gate.ready,
    productionGateSource: gate.source,
    productionGateMode: gate.mode,
    productionGateBlockers: gate.blockers,
    productionGateEvaluated: true,
  };
}

function unresolvedCheck(check, blocker) {
  return {
    ...check,
    generationStatus: 'UNRESOLVED',
    productionGateStatus: SPECIAL_DETAILING_GATE_STATUS.UNRESOLVED,
    productionGateReady: false,
    productionGateBlockers: [...new Set([...(check.productionGateBlockers || []), blocker])],
  };
}

function placementCandidate(check) {
  const geometry = check?.restraintPlacementGeometry;
  if (!geometry) return null;
  return {
    columnId: check.elementId || null,
    columnName: check.elementName || null,
    nodeId: check.nodeId || geometry.nodeId || null,
    diaMm: Number(check.diaMm),
    diaName: check.diaName || null,
    maxPitchMm: Number(check.maxPitchMm),
    placementGeometry: geometry,
    sourceCheck: check,
  };
}

function finitePoint3d(point) {
  return (
    Boolean(point) &&
    typeof point.x === 'number' &&
    typeof point.y === 'number' &&
    typeof point.z === 'number' &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Number.isFinite(point.z)
  );
}

function normalizedModelSource(value) {
  const source = String(value || '')
    .trim()
    .toUpperCase();
  return source === 'A' || source === 'B' ? source : null;
}

function targetCandidates(geometry) {
  if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry)) return [];
  return Array.isArray(geometry.targets) ? geometry.targets : [geometry];
}

function targetMatchesModelSource(target, geometry, modelSource) {
  const expected = normalizedModelSource(modelSource);
  if (!expected) return true;
  const actual = normalizedModelSource(target?.modelSource ?? geometry?.modelSource);
  return actual === expected;
}

function explicitTarget(check, gate, modelSource) {
  if (gate.source !== 'project-detailing') {
    return {
      ok: false,
      blocker: 'explicit-world-paths-project-detailing-required',
      target: null,
    };
  }

  const geometry = gate.detail?.geometry;
  const candidates = targetCandidates(geometry).filter(
    (target) =>
      targetMatchesModelSource(target, geometry, modelSource) &&
      String(target?.elementId || '') === String(check.elementId || '') &&
      String(target?.nodeId || '') === String(check.nodeId || ''),
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      blocker: normalizedModelSource(modelSource)
        ? 'explicit-restraint-model-target-unresolved'
        : 'explicit-restraint-target-unresolved',
      target: null,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      blocker: 'explicit-restraint-target-ambiguous',
      target: null,
    };
  }

  const target = candidates[0];
  const coordinateSpace = target.coordinateSpace || geometry?.coordinateSpace;
  if (coordinateSpace !== 'world' || !Array.isArray(target.paths)) {
    return {
      ok: false,
      blocker: 'explicit-restraint-world-paths-unresolved',
      target: null,
    };
  }
  if (target.paths.length === 0) {
    return {
      ok: false,
      blocker: 'explicit-restraint-world-paths-empty',
      target: null,
    };
  }
  return { ok: true, blocker: null, target };
}

function explicitWorldPaths(check, gate, modelSource) {
  const resolved = explicitTarget(check, gate, modelSource);
  if (!resolved.ok) return { ok: false, blocker: resolved.blocker, paths: [] };

  const paths = [];
  for (const sourcePath of resolved.target.paths) {
    const rawDiaMm = sourcePath?.diaMm;
    if (
      typeof rawDiaMm !== 'number' ||
      !Number.isFinite(rawDiaMm) ||
      !(rawDiaMm > 0) ||
      rawDiaMm !== Number(check.diaMm)
    ) {
      return {
        ok: false,
        blocker: 'explicit-restraint-diameter-inconsistent',
        paths: [],
      };
    }
    const diaMm = rawDiaMm;
    if (!Array.isArray(sourcePath?.primitives) || sourcePath.primitives.length === 0) {
      return {
        ok: false,
        blocker: 'explicit-restraint-primitives-unresolved',
        paths: [],
      };
    }

    const primitives = [];
    for (const primitive of sourcePath.primitives) {
      if (
        primitive?.type !== 'line' ||
        !finitePoint3d(primitive.start) ||
        !finitePoint3d(primitive.end)
      ) {
        return {
          ok: false,
          blocker: 'explicit-restraint-line-invalid',
          paths: [],
        };
      }
      primitives.push(createLine(primitive.start, primitive.end));
    }

    const path = createRebarPath(primitives, {
      memberId: check.elementId || null,
      memberTag: 'StbColumn',
      role: 'columnInternalRestraint',
      dia: diaMm,
      diaName: check.diaName || `D${diaMm}`,
      grade: sourcePath.grade || check.grade || null,
      source: 'top-story-r8-explicit',
      ruleId: '8-2-5',
      endpoint: 'top',
      coordinateSpace: 'world',
      modelSource: normalizedModelSource(modelSource),
      nodeId: check.nodeId || null,
      specialDetailingType: check.specialDetailingType,
    });
    if (!validateRebarPath(path).ok) {
      return {
        ok: false,
        blocker: 'explicit-restraint-path-invalid',
        paths: [],
      };
    }
    paths.push(path);
  }
  return { ok: true, blocker: null, paths };
}

/**
 * 最上階柱頭の柱内拘束筋production計画を作る。
 * @returns {{checks:Array<Object>, placementCandidates:Array<Object>, paths:Array<Object>}}
 */
export function buildTopStoryColumnHeadRenderPlan(xmlDoc, girderLayouts, options = {}) {
  const rawChecks = buildTopStoryColumnHeadDetailingChecks(
    xmlDoc,
    girderLayouts,
    options.scanTag || null,
  );
  const placementCandidates = [];
  const paths = [];

  const checks = rawChecks.map((raw) => {
    const gate = resolveSpecialDetailingProductionGate(raw, {
      commonConfig: options.commonConfig,
      projectDetailing: options.projectDetailing,
    });
    const check = gateFields(raw, gate);
    if (gate.status !== SPECIAL_DETAILING_GATE_STATUS.READY) return check;

    if (gate.mode === SPECIAL_DETAILING_PRODUCTION_MODE.EXPLICIT) {
      const explicit = explicitWorldPaths(check, gate, options.modelSource);
      if (!explicit.ok) return unresolvedCheck(check, explicit.blocker);
      paths.push(...explicit.paths);
      return {
        ...check,
        generationStatus: 'CENTERLINE_READY',
        productionPathCandidate: true,
        productionConsumer: 'explicit-world-path',
      };
    }

    if (gate.mode !== SPECIAL_DETAILING_PRODUCTION_MODE.STANDARD_WITH_STB) return check;
    const candidate = placementCandidate(check);
    if (!candidate) return unresolvedCheck(check, 'restraint-placement-candidate-unresolved');

    placementCandidates.push(candidate);
    return {
      ...check,
      productionPlacementCandidate: true,
      productionConsumerPending: 'column-restraint-shape',
    };
  });

  return { checks, placementCandidates, paths };
}
