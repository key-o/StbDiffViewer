/**
 * @fileoverview R8-A: 大梁折曲げ定着の吊上げ筋をEXPLICIT world pathへ接続するrender plan。
 *
 * 図8-2-3は吊上げ筋を折り曲げた主筋すべてに掛けることを要求する一方、
 * 径・本数・具体形状は構造図によるためSTANDARD_WITH_STBでは生成しない。
 * project detailingで対象モデル・大梁端とworld Line中心線が明示された場合だけRebarPathへ変換する。
 */

import { createLine, createRebarPath, validateRebarPath } from './rebarPath.js';
import {
  SPECIAL_DETAILING_GATE_STATUS,
  SPECIAL_DETAILING_PRODUCTION_MODE,
  resolveSpecialDetailingProductionGate,
} from './specialDetailingProductionGate.js';

const SPECIAL_TYPE = 'GIRDER_HANGER_REBAR';

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

function normalizedSide(value) {
  const side = String(value || '').toLowerCase();
  return side === 'start' || side === 'end' ? side : null;
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
      blocker: 'explicit-hanger-world-paths-project-detailing-required',
      target: null,
    };
  }

  const geometry = gate.detail?.geometry;
  const candidates = targetCandidates(geometry).filter(
    (target) =>
      targetMatchesModelSource(target, geometry, modelSource) &&
      String(target?.elementId || '') === String(check.elementId || '') &&
      normalizedSide(target?.side) === normalizedSide(check.side),
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      blocker: normalizedModelSource(modelSource)
        ? 'explicit-hanger-model-target-unresolved'
        : 'explicit-hanger-target-unresolved',
      target: null,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      blocker: 'explicit-hanger-target-ambiguous',
      target: null,
    };
  }

  const target = candidates[0];
  const coordinateSpace = target.coordinateSpace || geometry?.coordinateSpace;
  if (coordinateSpace !== 'world') {
    return {
      ok: false,
      blocker: 'explicit-hanger-coordinate-space-invalid',
      target: null,
    };
  }
  if (!Array.isArray(target.paths) || target.paths.length === 0) {
    return {
      ok: false,
      blocker: 'explicit-hanger-world-paths-empty',
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
    if (typeof rawDiaMm !== 'number' || !Number.isFinite(rawDiaMm) || !(rawDiaMm > 0)) {
      return {
        ok: false,
        blocker: 'explicit-hanger-diameter-unresolved',
        paths: [],
      };
    }
    const diaMm = rawDiaMm;
    if (!Array.isArray(sourcePath?.primitives) || sourcePath.primitives.length === 0) {
      return {
        ok: false,
        blocker: 'explicit-hanger-primitives-unresolved',
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
          blocker: 'explicit-hanger-line-invalid',
          paths: [],
        };
      }
      primitives.push(createLine(primitive.start, primitive.end));
    }

    const path = createRebarPath(primitives, {
      memberId: check.elementId || null,
      memberTag: 'StbGirder',
      role: 'girderHanger',
      dia: diaMm,
      diaName: sourcePath.diaName || `D${diaMm}`,
      grade: sourcePath.grade || null,
      source: 'girder-r8-hanger-explicit',
      ruleId: '8-2-3',
      endpoint: normalizedSide(check.side),
      coordinateSpace: 'world',
      modelSource: normalizedModelSource(modelSource),
      specialDetailingType: SPECIAL_TYPE,
    });
    if (!validateRebarPath(path).ok) {
      return { ok: false, blocker: 'explicit-hanger-path-invalid', paths: [] };
    }
    paths.push(path);
  }
  return { ok: true, blocker: null, paths };
}

function targetKey(check, modelSource) {
  return `${normalizedModelSource(modelSource) || '-'}|${String(check?.elementId || '')}|${normalizedSide(check?.side) || ''}`;
}

/**
 * 梁定着checkへ付加された吊上げ筋要求をproduction計画へ変換する。
 * 同一モデル・同一大梁端に複数の主筋checkがある場合でも明示吊上げ筋pathは1度だけ描画する。
 * @returns {{checks:Array<Object>, paths:Array<Object>}}
 */
export function buildGirderHangerRenderPlan(checks, options = {}) {
  const paths = [];
  const resolvedTargets = new Map();
  const emittedTargets = new Set();

  const resultChecks = (checks || []).map((raw) => {
    if (raw?.specialDetailingRequired !== true || raw?.specialDetailingType !== SPECIAL_TYPE) {
      return raw;
    }

    const gate = resolveSpecialDetailingProductionGate(raw, {
      commonConfig: options.commonConfig,
      projectDetailing: options.projectDetailing,
    });
    const check = gateFields(raw, gate);
    if (gate.status !== SPECIAL_DETAILING_GATE_STATUS.READY) return check;
    if (gate.mode !== SPECIAL_DETAILING_PRODUCTION_MODE.EXPLICIT) {
      return unresolvedCheck(check, 'explicit-hanger-production-mode-required');
    }

    const key = targetKey(check, options.modelSource);
    let explicit = resolvedTargets.get(key);
    if (!explicit) {
      explicit = explicitWorldPaths(check, gate, options.modelSource);
      resolvedTargets.set(key, explicit);
    }
    if (!explicit.ok) return unresolvedCheck(check, explicit.blocker);

    if (!emittedTargets.has(key)) {
      paths.push(...explicit.paths);
      emittedTargets.add(key);
    }
    return {
      ...check,
      generationStatus: 'CENTERLINE_READY',
      productionPathCandidate: true,
      productionConsumer: 'explicit-world-path',
    };
  });

  return { checks: resultChecks, paths };
}
