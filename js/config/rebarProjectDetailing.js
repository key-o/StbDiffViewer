/**
 * @fileoverview Project-scoped RC special-detailing runtime source.
 *
 * World-coordinate EXPLICIT geometry is intentionally kept separate from
 * rebarCommonConfig because it belongs to the current project/model context.
 * The application render/check paths consume this source when callers do not
 * supply an explicit projectDetailing option.
 */

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SPECIAL_DETAILING_TYPES = new Set([
  'GIRDER_HANGER_REBAR',
  'GIRDER_HAUNCH_CORNER_CONTINUITY',
  'TOP_STORY_COLUMN_INTERNAL_RESTRAINT',
  'FOUNDATION_BEAM_ANCHORAGE',
  'APPENDIX_A2_CORNER_U_SHAPE_PAIRING',
  'APPENDIX_A2_CORNER_CONGESTION_GEOMETRY',
  'COLUMN_BAR_CONTINUITY_OVERRIDE',
  'GIRDER_BAR_CONTINUITY_OVERRIDE',
  'REBAR_PLACEMENT_CONFLICT_RULES',
  'REBAR_PLACEMENT_CONFLICT_OVERRIDE',
  'SMALL_OPENING_REBAR_DEFLECTION',
  'SMALL_OPENING_REBAR_DEFLECTION_TARGET',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !UNSAFE_OBJECT_KEYS.has(key))
        .map(([key, item]) => [key, cloneValue(item)]),
    );
  }
  return value;
}

function validateEntryShapes(value) {
  for (const type of SPECIAL_DETAILING_TYPES) {
    if (Object.prototype.hasOwnProperty.call(value, type) && !isPlainObject(value[type])) {
      return `project detailing ${type} must be an object`;
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, 'special')) {
    if (!isPlainObject(value.special)) return 'project detailing special must be an object';
    for (const type of SPECIAL_DETAILING_TYPES) {
      if (
        Object.prototype.hasOwnProperty.call(value.special, type) &&
        !isPlainObject(value.special[type])
      ) {
        return `project detailing special.${type} must be an object`;
      }
    }
  }
  return null;
}

let currentProjectDetailing = {};
let rebarProjectDetailingRevision = 0;

export function getRebarProjectDetailingRevision() {
  return rebarProjectDetailingRevision;
}

function bumpRebarProjectDetailingRevision() {
  rebarProjectDetailingRevision += 1;
  return rebarProjectDetailingRevision;
}

export function getRebarProjectDetailing() {
  return cloneValue(currentProjectDetailing);
}

export function setRebarProjectDetailing(value) {
  if (!isPlainObject(value)) {
    return { ok: false, error: 'project detailing must be an object' };
  }
  const shapeError = validateEntryShapes(value);
  if (shapeError) return { ok: false, error: shapeError };

  currentProjectDetailing = cloneValue(value);
  bumpRebarProjectDetailingRevision();
  return { ok: true, projectDetailing: getRebarProjectDetailing() };
}

export function clearRebarProjectDetailing() {
  currentProjectDetailing = {};
  bumpRebarProjectDetailingRevision();
  return getRebarProjectDetailing();
}

// Project-detailing importers and host integrations can populate the runtime
// source without coupling world coordinates to the common rebar standard.
if (typeof window !== 'undefined') {
  window.getRebarProjectDetailing = getRebarProjectDetailing;
  window.setRebarProjectDetailing = setRebarProjectDetailing;
  window.clearRebarProjectDetailing = clearRebarProjectDetailing;
}
