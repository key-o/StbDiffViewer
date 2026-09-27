/**
 * @fileoverview Issue #327 / #320 Phase 6b-O3:
 * 小開口主筋deflectionのproject-scoped EXPLICIT assignment契約。
 *
 * ST-Bridgeだけでは一意に復元できない opening-edge cover と
 * BEND / SHIFT geometry を exact scope で保持・解決する。
 */

import { getRebarProjectDetailing, setRebarProjectDetailing } from './rebarProjectDetailing.js';

export const SMALL_OPENING_REBAR_DEFLECTION_DETAILING_TYPE = 'SMALL_OPENING_REBAR_DEFLECTION';
export const SMALL_OPENING_REBAR_DEFLECTION_SOURCE =
  'PROJECT_DETAILING:SMALL_OPENING_REBAR_DEFLECTION';

const VALID_MEMBER_TYPES = new Set(['WALL', 'SLAB']);
const VALID_COVER_STATUS = new Set(['PASS', 'FAIL']);
const VALID_METHODS = new Set(['BEND', 'SHIFT']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonBlank(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function upper(value) {
  return nonBlank(value)?.toUpperCase() || null;
}

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hasValue(value) {
  return !(
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '')
  );
}

function normalizeModelSource(value) {
  const normalized = upper(value);
  return normalized === 'A' || normalized === 'B' ? normalized : null;
}

function normalizeMemberType(value) {
  const normalized = upper(value);
  return VALID_MEMBER_TYPES.has(normalized) ? normalized : null;
}

function normalizeScope(value = {}) {
  if (!isPlainObject(value)) return null;
  const modelSource = normalizeModelSource(value.modelSource);
  const memberType = normalizeMemberType(value.memberType);
  const memberId = nonBlank(value.memberId);
  const openingId = nonBlank(value.openingId);
  if (!modelSource || !memberType || !memberId || !openingId) return null;
  return { modelSource, memberType, memberId, openingId };
}

function scopeKey(value) {
  const scope = normalizeScope(value);
  return scope
    ? `${scope.modelSource}\u0000${scope.memberType}\u0000${scope.memberId}\u0000${scope.openingId}`
    : null;
}

function normalizeAssignment(value) {
  if (!isPlainObject(value)) {
    return { ok: false, error: 'small opening deflection assignment must be an object' };
  }

  const scope = normalizeScope(value);
  if (!scope) {
    return { ok: false, error: 'small opening deflection assignment selector is incomplete' };
  }

  const coverStatus = upper(value.coverStatus);
  if (!VALID_COVER_STATUS.has(coverStatus)) {
    return { ok: false, error: 'small opening deflection coverStatus must be PASS or FAIL' };
  }

  const method = upper(value.method);
  if (!VALID_METHODS.has(method)) {
    return { ok: false, error: 'small opening deflection method must be BEND or SHIFT' };
  }

  const assignment = {
    ...scope,
    coverStatus,
    method,
    bendOffsetMm: null,
    bendRunMm: null,
    shiftMm: null,
    note: nonBlank(value.note),
  };

  if (method === 'BEND') {
    if (hasValue(value.shiftMm)) {
      return {
        ok: false,
        error: 'small opening BEND assignment must not include shift geometry',
      };
    }
    const bendOffsetMm = finite(value.bendOffsetMm);
    const bendRunMm = finite(value.bendRunMm);
    if (bendOffsetMm === null || bendRunMm === null || !(bendRunMm > 0)) {
      return { ok: false, error: 'small opening BEND geometry is incomplete' };
    }
    assignment.bendOffsetMm = bendOffsetMm;
    assignment.bendRunMm = bendRunMm;
  } else {
    if (hasValue(value.bendOffsetMm) || hasValue(value.bendRunMm)) {
      return {
        ok: false,
        error: 'small opening SHIFT assignment must not include bend geometry',
      };
    }
    const shiftMm = finite(value.shiftMm);
    if (shiftMm === null) {
      return { ok: false, error: 'small opening SHIFT geometry is incomplete' };
    }
    assignment.shiftMm = shiftMm;
  }

  return { ok: true, assignment };
}

function entryLocation(projectDetailing) {
  if (!isPlainObject(projectDetailing)) {
    return { ok: false, error: 'project detailing must be an object' };
  }
  const type = SMALL_OPENING_REBAR_DEFLECTION_DETAILING_TYPE;
  const topLevel = Object.prototype.hasOwnProperty.call(projectDetailing, type);
  if (
    Object.prototype.hasOwnProperty.call(projectDetailing, 'special') &&
    !isPlainObject(projectDetailing.special)
  ) {
    return { ok: false, error: 'project detailing special must be an object' };
  }
  const nested =
    isPlainObject(projectDetailing.special) &&
    Object.prototype.hasOwnProperty.call(projectDetailing.special, type);

  if (topLevel && nested) {
    return {
      ok: false,
      error: 'small opening deflection exists in both top-level and special scopes',
    };
  }
  if (topLevel) return { ok: true, location: 'top', entry: projectDetailing[type] };
  if (nested) {
    return { ok: true, location: 'special', entry: projectDetailing.special[type] };
  }
  return { ok: true, location: 'missing', entry: null };
}

function validateEntry(entry) {
  if (!isPlainObject(entry)) {
    return { ok: false, error: 'small opening deflection entry must be an object' };
  }
  if (entry.productionMode !== 'EXPLICIT') {
    return { ok: false, error: 'small opening deflection entry must use EXPLICIT mode' };
  }
  if (!Array.isArray(entry.assignments)) {
    return { ok: false, error: 'small opening deflection assignments must be an array' };
  }

  const assignments = [];
  const seen = new Set();
  for (const raw of entry.assignments) {
    const normalized = normalizeAssignment(raw);
    if (!normalized.ok) return normalized;
    const key = scopeKey(normalized.assignment);
    if (seen.has(key)) {
      return { ok: false, error: 'small opening deflection assignment scope is ambiguous' };
    }
    seen.add(key);
    assignments.push(normalized.assignment);
  }

  return { ok: true, entry, assignments };
}

function inactive(status = 'NOT_CONFIGURED') {
  return Object.freeze({
    active: false,
    resolved: true,
    status,
    reason: null,
    source: null,
    sourceRef: null,
    assignment: null,
  });
}

function unresolved(reason, details = {}) {
  return Object.freeze({
    active: true,
    resolved: false,
    status: 'UNRESOLVED',
    reason,
    source: 'project-detailing',
    sourceRef: SMALL_OPENING_REBAR_DEFLECTION_SOURCE,
    assignment: null,
    ...details,
  });
}

function sortedAssignments(assignments) {
  return [...assignments].sort((a, b) => {
    const left = scopeKey(a);
    const right = scopeKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function writeEntry(projectDetailing, location, entry) {
  const type = SMALL_OPENING_REBAR_DEFLECTION_DETAILING_TYPE;
  const next = { ...projectDetailing };
  if (location === 'special') {
    next.special = { ...(projectDetailing.special || {}), [type]: entry };
  } else {
    next[type] = entry;
  }
  return setRebarProjectDetailing(next);
}

function deleteEntry(projectDetailing, location) {
  const type = SMALL_OPENING_REBAR_DEFLECTION_DETAILING_TYPE;
  const next = { ...projectDetailing };
  if (location === 'special') {
    const special = { ...(projectDetailing.special || {}) };
    delete special[type];
    if (Object.keys(special).length === 0) delete next.special;
    else next.special = special;
  } else {
    delete next[type];
  }
  return setRebarProjectDetailing(next);
}

export function createSmallOpeningRebarDeflectionAssignment(value = {}) {
  return normalizeAssignment(value);
}

export function createSmallOpeningRebarDeflectionAssignmentResolver(projectDetailing) {
  const location = entryLocation(projectDetailing);
  let configurationResult = null;
  let assignmentsByScope = null;

  if (!location.ok) {
    configurationResult = unresolved('small-opening-project-entry-ambiguous-or-invalid', {
      detail: location.error,
    });
  } else if (location.location === 'missing') {
    configurationResult = inactive();
  } else {
    const checked = validateEntry(location.entry);
    if (!checked.ok) {
      configurationResult = unresolved('small-opening-project-entry-invalid', {
        detail: checked.error,
      });
    } else if (location.entry.productionEnabled !== true) {
      configurationResult = inactive('DISABLED');
    } else {
      assignmentsByScope = new Map(
        checked.assignments.map((assignment) => [scopeKey(assignment), assignment]),
      );
    }
  }

  return (scopeValue = {}) => {
    const scope = normalizeScope(scopeValue);
    if (!scope) {
      return unresolved('small-opening-project-assignment-selector-invalid');
    }
    if (configurationResult) return configurationResult;

    const assignment = assignmentsByScope.get(scopeKey(scope));
    if (!assignment) return inactive('NO_ASSIGNMENT');

    return Object.freeze({
      active: true,
      resolved: true,
      status: 'ASSIGNMENT_READY',
      reason: null,
      source: 'project-detailing',
      sourceRef: SMALL_OPENING_REBAR_DEFLECTION_SOURCE,
      assignment: Object.freeze({ ...assignment }),
    });
  };
}

export function resolveSmallOpeningRebarDeflectionAssignment(options = {}) {
  if (!isPlainObject(options)) {
    return unresolved('small-opening-project-assignment-selector-invalid');
  }
  const source =
    options.projectDetailing === undefined ? getRebarProjectDetailing() : options.projectDetailing;
  return createSmallOpeningRebarDeflectionAssignmentResolver(source)(options);
}

export function upsertSmallOpeningRebarDeflectionAssignment(value) {
  const normalized = normalizeAssignment(value);
  if (!normalized.ok) return normalized;

  const projectDetailing = getRebarProjectDetailing();
  const location = entryLocation(projectDetailing);
  if (!location.ok) return location;

  let existing = { entry: {}, assignments: [] };
  if (location.location !== 'missing') {
    existing = validateEntry(location.entry);
    if (!existing.ok) return existing;
  }

  const targetKey = scopeKey(normalized.assignment);
  const retained = existing.assignments.filter((assignment) => scopeKey(assignment) !== targetKey);
  const assignments = sortedAssignments([...retained, normalized.assignment]);
  const entry = {
    ...existing.entry,
    productionEnabled: true,
    productionMode: 'EXPLICIT',
    assignments,
  };

  const write = writeEntry(
    projectDetailing,
    location.location === 'missing' ? 'top' : location.location,
    entry,
  );
  return write.ok
    ? {
        ok: true,
        assignment: normalized.assignment,
        projectDetailing: write.projectDetailing,
      }
    : write;
}

export function removeSmallOpeningRebarDeflectionAssignment(scopeValue) {
  const targetKey = scopeKey(scopeValue);
  if (!targetKey) {
    return { ok: false, error: 'small opening deflection selector is incomplete' };
  }

  const projectDetailing = getRebarProjectDetailing();
  const location = entryLocation(projectDetailing);
  if (!location.ok) return location;
  if (location.location === 'missing') {
    return { ok: true, changed: false, projectDetailing };
  }

  const existing = validateEntry(location.entry);
  if (!existing.ok) return existing;

  const assignments = existing.assignments.filter(
    (assignment) => scopeKey(assignment) !== targetKey,
  );
  if (assignments.length === existing.assignments.length) {
    return { ok: true, changed: false, projectDetailing };
  }

  const write =
    assignments.length === 0
      ? deleteEntry(projectDetailing, location.location)
      : writeEntry(projectDetailing, location.location, {
          ...existing.entry,
          assignments: sortedAssignments(assignments),
        });

  return write.ok ? { ok: true, changed: true, projectDetailing: write.projectDetailing } : write;
}

export const __testOnly = Object.freeze({
  normalizeAssignment,
  normalizeScope,
  scopeKey,
});
