/**
 * @fileoverview R8-D: 特殊納まりをproduction geometryへ進めるためのfail-closed gate。
 *
 * 標準図が要求の存在だけを定めるケースと、STB明示幾何からproduction候補にできるケースを
 * 分離する。project detailing > rebarCommonConfig > STB明示facts の順に評価し、
 * 不足情報を暗黙値で補完しない。
 */

import { getRebarCommonConfig } from '../../../config/rebarCommonConfig.js';
import { getRebarProjectDetailing } from '../../../config/rebarProjectDetailing.js';

export const SPECIAL_DETAILING_GATE_STATUS = Object.freeze({
  NOT_REQUIRED: 'NOT_REQUIRED',
  READY: 'READY',
  UNRESOLVED: 'UNRESOLVED',
  INVALID: 'INVALID',
});

export const SPECIAL_DETAILING_PRODUCTION_MODE = Object.freeze({
  EXPLICIT: 'EXPLICIT',
  STANDARD_WITH_STB: 'STANDARD_WITH_STB',
});

const SUPPORTED_TYPES = new Set([
  'GIRDER_HANGER_REBAR',
  'GIRDER_HAUNCH_CORNER_CONTINUITY',
  'TOP_STORY_COLUMN_INTERNAL_RESTRAINT',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function detailEntry(config, type) {
  const special = config?.detailing?.special;
  if (!isPlainObject(special)) return null;
  const value = special[type];
  return isPlainObject(value) ? value : null;
}

function projectSourceEntry(type, projectDetailing) {
  if (!isPlainObject(projectDetailing)) return null;

  if (hasOwn(projectDetailing, type)) {
    const value = projectDetailing[type];
    return isPlainObject(value)
      ? { source: 'project-detailing', value, malformedReason: null }
      : {
          source: 'project-detailing',
          value: null,
          malformedReason: 'project-detailing-entry-invalid',
        };
  }

  if (hasOwn(projectDetailing, 'special')) {
    const special = projectDetailing.special;
    if (!isPlainObject(special)) {
      return {
        source: 'project-detailing',
        value: null,
        malformedReason: 'project-detailing-special-invalid',
      };
    }
    if (hasOwn(special, type)) {
      const value = special[type];
      return isPlainObject(value)
        ? { source: 'project-detailing', value, malformedReason: null }
        : {
            source: 'project-detailing',
            value: null,
            malformedReason: 'project-detailing-entry-invalid',
          };
    }
  }
  return null;
}

function sourceEntry(type, commonConfig, projectDetailing) {
  const project = projectSourceEntry(type, projectDetailing);
  // project側に対象typeが存在する場合、malformedでもcommonへfallbackしない。
  if (project) return project;
  const common = detailEntry(commonConfig, type);
  if (common) {
    return { source: 'rebar-common-config', value: common, malformedReason: null };
  }
  return { source: null, value: null, malformedReason: null };
}

function invalid(reason, source = null) {
  return {
    status: SPECIAL_DETAILING_GATE_STATUS.INVALID,
    ready: false,
    source,
    mode: null,
    blockers: [reason],
    detail: null,
  };
}

function unresolved(blockers, source = null, mode = null, detail = null) {
  return {
    status: SPECIAL_DETAILING_GATE_STATUS.UNRESOLVED,
    ready: false,
    source,
    mode,
    blockers,
    detail,
  };
}

function ready(source, mode, detail = null) {
  return {
    status: SPECIAL_DETAILING_GATE_STATUS.READY,
    ready: true,
    source,
    mode,
    blockers: [],
    detail,
  };
}

function validateExplicitOverride(entry) {
  if (!entry) return { ok: false, blockers: ['explicit-detailing-required'] };
  if (entry.productionEnabled !== true) {
    return { ok: false, blockers: ['production-not-enabled'] };
  }
  if (entry.productionMode !== SPECIAL_DETAILING_PRODUCTION_MODE.EXPLICIT) {
    return { ok: false, blockers: ['explicit-production-mode-required'] };
  }
  if (!isPlainObject(entry.geometry)) {
    return { ok: false, blockers: ['explicit-geometry-required'] };
  }
  return { ok: true, blockers: [] };
}

function resolveHanger(fact, explicit) {
  const checked = validateExplicitOverride(explicit.value);
  if (!checked.ok) {
    return unresolved(checked.blockers, explicit.source, explicit.value?.productionMode || null);
  }
  return ready(explicit.source, SPECIAL_DETAILING_PRODUCTION_MODE.EXPLICIT, explicit.value);
}

function finiteLocalPoint(value) {
  return (
    isPlainObject(value) &&
    typeof value.u === 'number' &&
    typeof value.v === 'number' &&
    Number.isFinite(value.u) &&
    Number.isFinite(value.v)
  );
}

function validateHaunchProductionGeometry(fact) {
  const blockers = [];
  if (fact?.haunchProductionBlocker) blockers.push(String(fact.haunchProductionBlocker));

  const geometry = fact?.haunchProductionGeometry;
  if (!isPlainObject(geometry)) {
    blockers.push('stb-haunch-production-geometry-unresolved');
    return blockers;
  }

  if (geometry.coordinateSpace !== 'member-local') {
    blockers.push('stb-haunch-production-coordinate-space-invalid');
  }
  if (!['start', 'end'].includes(geometry.side) || geometry.side !== fact?.side) {
    blockers.push('stb-haunch-production-side-inconsistent');
  }
  const lengthMm = Number(geometry.lengthMm);
  const factLengthMm = Number(fact?.haunchLengthMm);
  if (!(lengthMm > 0) || !(factLengthMm > 0) || Math.abs(lengthMm - factLengthMm) > 1e-6) {
    blockers.push('stb-haunch-production-length-inconsistent');
  }

  const transitions = geometry.cornerTransitions;
  if (!Array.isArray(transitions) || transitions.length === 0) {
    blockers.push('stb-haunch-corner-transitions-unresolved');
    return blockers;
  }
  const expectedCount = Number(fact?.count);
  if (
    Number.isInteger(expectedCount) &&
    expectedCount > 0 &&
    transitions.length !== expectedCount
  ) {
    blockers.push('stb-haunch-corner-transition-count-inconsistent');
  }
  for (const transition of transitions) {
    if (!['top', 'bottom'].includes(transition?.role)) {
      blockers.push('stb-haunch-corner-transition-role-invalid');
      break;
    }
    if (!(Number(transition?.diaMm) > 0) || Number(transition.diaMm) !== Number(fact?.diaMm)) {
      blockers.push('stb-haunch-corner-transition-diameter-inconsistent');
      break;
    }
    if (!finiteLocalPoint(transition.from) || !finiteLocalPoint(transition.to)) {
      blockers.push('stb-haunch-corner-transition-position-unresolved');
      break;
    }
  }
  return blockers;
}

function resolveHaunch(fact, explicit) {
  if (explicit.value) {
    if (explicit.value.productionEnabled !== true) {
      return unresolved(
        ['production-not-enabled'],
        explicit.source,
        explicit.value.productionMode || null,
      );
    }
    if (explicit.value.productionMode === SPECIAL_DETAILING_PRODUCTION_MODE.EXPLICIT) {
      if (!isPlainObject(explicit.value.geometry)) {
        return unresolved(
          ['explicit-geometry-required'],
          explicit.source,
          explicit.value.productionMode,
        );
      }
      return unresolved(
        ['explicit-haunch-consumer-unimplemented'],
        explicit.source,
        explicit.value.productionMode,
        explicit.value,
      );
    }
    if (explicit.value.productionMode !== SPECIAL_DETAILING_PRODUCTION_MODE.STANDARD_WITH_STB) {
      return invalid('unsupported-production-mode', explicit.source);
    }
  }

  const lengthMm = Number(fact?.haunchLengthMm);
  const diaMm = Number(fact?.diaMm);
  const count = Number(fact?.count);
  const source = String(fact?.haunchGeometrySource || '');
  const blockers = [];
  if (!(lengthMm > 0)) blockers.push('stb-haunch-length-unresolved');
  if (!source.startsWith('stb-')) blockers.push('stb-haunch-geometry-unresolved');
  if (!(diaMm > 0)) blockers.push('corner-bar-diameter-unresolved');
  if (!Number.isInteger(count) || count <= 0) blockers.push('corner-bar-count-unresolved');
  blockers.push(...validateHaunchProductionGeometry(fact));
  if (blockers.length) {
    return unresolved(
      [...new Set(blockers)],
      explicit.source || (source.startsWith('stb-') ? 'stb-explicit' : null),
      explicit.value?.productionMode || SPECIAL_DETAILING_PRODUCTION_MODE.STANDARD_WITH_STB,
      explicit.value,
    );
  }

  return ready(
    explicit.source || 'stb-explicit',
    explicit.value?.productionMode || SPECIAL_DETAILING_PRODUCTION_MODE.STANDARD_WITH_STB,
    explicit.value,
  );
}

function finiteWorldAxis(value) {
  if (!isPlainObject(value)) return false;
  const x = Number(value.x);
  const y = Number(value.y);
  return [x, y].every(Number.isFinite) && Math.hypot(x, y) > 1e-9;
}

function validateTopStoryRestraintPlacementGeometry(fact) {
  const geometry = fact?.restraintPlacementGeometry;
  if (fact?.restraintPlacementResolved !== true || !isPlainObject(geometry)) {
    return ['restraint-placement-geometry-unresolved'];
  }

  const blockers = [];
  if (geometry.coordinateSpace !== 'world') {
    blockers.push('restraint-placement-coordinate-space-invalid');
  }
  if (fact?.nodeId && String(geometry.nodeId || '') !== String(fact.nodeId)) {
    blockers.push('restraint-placement-node-inconsistent');
  }
  if (!finiteWorldAxis(geometry.upperAxis) || !finiteWorldAxis(geometry.lowerAxis)) {
    blockers.push('restraint-placement-axis-unresolved');
  } else {
    const dot =
      Number(geometry.upperAxis.x) * Number(geometry.lowerAxis.x) +
      Number(geometry.upperAxis.y) * Number(geometry.lowerAxis.y);
    if (Math.abs(dot) > 1e-4) blockers.push('restraint-placement-axis-not-orthogonal');
  }

  const upper = Number(geometry.upperMainBarElevationMm);
  const lower = Number(geometry.lowerMainBarElevationMm);
  const separation = Number(geometry.verticalSeparationMm);
  if (![upper, lower, separation].every(Number.isFinite)) {
    blockers.push('restraint-placement-elevation-unresolved');
  } else if (!(separation > 0) || Math.abs(upper - lower - separation) > 1e-3) {
    blockers.push('restraint-placement-separation-inconsistent');
  }

  if (!Array.isArray(geometry.upperGirderIds) || geometry.upperGirderIds.length === 0) {
    blockers.push('restraint-upper-girder-unresolved');
  }
  if (!Array.isArray(geometry.lowerGirderIds) || geometry.lowerGirderIds.length === 0) {
    blockers.push('restraint-lower-girder-unresolved');
  }
  return blockers;
}

function resolveTopStoryRestraint(fact, explicit) {
  if (fact?.requirementResolved !== true || !(Number(fact?.diaMm) > 0)) {
    return unresolved(['restraint-requirement-unresolved'], explicit.source);
  }
  if (!explicit.value) {
    return unresolved(['production-authorization-required'], null);
  }
  if (explicit.value.productionEnabled !== true) {
    return unresolved(
      ['production-not-enabled'],
      explicit.source,
      explicit.value.productionMode || null,
    );
  }
  const mode = explicit.value.productionMode;
  if (mode === SPECIAL_DETAILING_PRODUCTION_MODE.EXPLICIT) {
    if (!isPlainObject(explicit.value.geometry)) {
      return unresolved(['explicit-geometry-required'], explicit.source, mode);
    }
    return ready(explicit.source, mode, explicit.value);
  }
  if (mode === SPECIAL_DETAILING_PRODUCTION_MODE.STANDARD_WITH_STB) {
    const blockers = validateTopStoryRestraintPlacementGeometry(fact);
    if (blockers.length) return unresolved(blockers, explicit.source, mode, explicit.value);
    return ready(explicit.source, mode, explicit.value);
  }
  return invalid('unsupported-production-mode', explicit.source);
}

export function resolveSpecialDetailingProductionGate(fact, options = {}) {
  if (!fact?.specialDetailingRequired) {
    return {
      status: SPECIAL_DETAILING_GATE_STATUS.NOT_REQUIRED,
      ready: false,
      source: null,
      mode: null,
      blockers: [],
      detail: null,
    };
  }

  const type = String(fact.specialDetailingType || '');
  if (!SUPPORTED_TYPES.has(type)) return invalid('unsupported-special-detailing-type');

  const commonConfig = options.commonConfig || getRebarCommonConfig();
  const projectDetailing =
    options.projectDetailing === undefined ? getRebarProjectDetailing() : options.projectDetailing;
  const explicit = sourceEntry(type, commonConfig, projectDetailing);
  if (explicit.malformedReason) return invalid(explicit.malformedReason, explicit.source);

  if (type === 'GIRDER_HANGER_REBAR') return resolveHanger(fact, explicit);
  if (type === 'GIRDER_HAUNCH_CORNER_CONTINUITY') return resolveHaunch(fact, explicit);
  return resolveTopStoryRestraint(fact, explicit);
}

export function attachSpecialDetailingProductionGate(fact, options = {}) {
  if (!fact?.specialDetailingRequired || fact?.productionGateEvaluated === true) return fact;
  const gate = resolveSpecialDetailingProductionGate(fact, options);
  return {
    ...fact,
    productionGateStatus: gate.status,
    productionGateReady: gate.ready,
    productionGateSource: gate.source,
    productionGateMode: gate.mode,
    productionGateBlockers: gate.blockers,
    productionGateEvaluated: true,
  };
}
