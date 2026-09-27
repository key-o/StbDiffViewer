/**
 * @fileoverview Issue #333 / #320 Phase 6b-O4:
 * 小開口deflectionのbar-level explicit target assignment契約。
 *
 * opening-levelの設計factとは分離し、actual mutation対象のbar identityだけを
 * exact scopeで保持する。nearest bar推定やcrossing bar全体への暗黙展開は行わない。
 */

import { getRebarProjectDetailing, setRebarProjectDetailing } from './rebarProjectDetailing.js';

export const SMALL_OPENING_REBAR_DEFLECTION_TARGET_DETAILING_TYPE =
  'SMALL_OPENING_REBAR_DEFLECTION_TARGET';
export const SMALL_OPENING_REBAR_DEFLECTION_TARGET_SOURCE =
  'PROJECT_DETAILING:SMALL_OPENING_REBAR_DEFLECTION_TARGET';

const VALID_MEMBER_TYPES = new Set(['WALL', 'SLAB']);

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

function normalizeModelSource(value) {
  const normalized = upper(value);
  return normalized === 'A' || normalized === 'B' ? normalized : null;
}

function normalizeMemberType(value) {
  const normalized = upper(value);
  return VALID_MEMBER_TYPES.has(normalized) ? normalized : null;
}

function normalizeOpeningScope(value = {}) {
  if (!isPlainObject(value)) return null;
  const modelSource = normalizeModelSource(value.modelSource);
  const memberType = normalizeMemberType(value.memberType);
  const memberId = nonBlank(value.memberId);
  const openingId = nonBlank(value.openingId);
  if (!modelSource || !memberType || !memberId || !openingId) return null;
  return { modelSource, memberType, memberId, openingId };
}

function openingScopeKey(value) {
  const scope = normalizeOpeningScope(value);
  return scope
    ? `${scope.modelSource}\u0000${scope.memberType}\u0000${scope.memberId}\u0000${scope.openingId}`
    : null;
}

function normalizeAssignment(value) {
  if (!isPlainObject(value)) {
    return { ok: false, error: 'small opening target assignment must be an object' };
  }

  const scope = normalizeOpeningScope(value);
  const barIdentity = nonBlank(value.barIdentity);
  if (!scope || !barIdentity) {
    return { ok: false, error: 'small opening target assignment selector is incomplete' };
  }

  return {
    ok: true,
    assignment: {
      ...scope,
      barIdentity,
      note: nonBlank(value.note),
    },
  };
}

function targetKey(value) {
  const normalized = normalizeAssignment(value);
  if (!normalized.ok) return null;
  return `${openingScopeKey(normalized.assignment)}\u0000${normalized.assignment.barIdentity}`;
}

function entryLocation(projectDetailing) {
  if (!isPlainObject(projectDetailing)) {
    return { ok: false, error: 'project detailing must be an object' };
  }
  const type = SMALL_OPENING_REBAR_DEFLECTION_TARGET_DETAILING_TYPE;
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
      error: 'small opening target exists in both top-level and special scopes',
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
    return { ok: false, error: 'small opening target entry must be an object' };
  }
  if (entry.productionMode !== 'EXPLICIT') {
    return { ok: false, error: 'small opening target entry must use EXPLICIT mode' };
  }
  if (!Array.isArray(entry.assignments)) {
    return { ok: false, error: 'small opening target assignments must be an array' };
  }

  const assignments = [];
  const seen = new Set();
  for (const raw of entry.assignments) {
    const normalized = normalizeAssignment(raw);
    if (!normalized.ok) return normalized;
    const key = targetKey(normalized.assignment);
    if (seen.has(key)) {
      return { ok: false, error: 'small opening target exact scope is ambiguous' };
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
    targets: Object.freeze([]),
  });
}

function unresolved(reason, details = {}) {
  return Object.freeze({
    active: true,
    resolved: false,
    status: 'UNRESOLVED',
    reason,
    source: 'project-detailing',
    sourceRef: SMALL_OPENING_REBAR_DEFLECTION_TARGET_SOURCE,
    targets: Object.freeze([]),
    ...details,
  });
}

function sortedAssignments(assignments) {
  return [...assignments].sort((a, b) => {
    const left = targetKey(a);
    const right = targetKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function writeEntry(projectDetailing, location, entry) {
  const type = SMALL_OPENING_REBAR_DEFLECTION_TARGET_DETAILING_TYPE;
  const next = { ...projectDetailing };
  if (location === 'special') {
    next.special = { ...(projectDetailing.special || {}), [type]: entry };
  } else {
    next[type] = entry;
  }
  return setRebarProjectDetailing(next);
}

function deleteEntry(projectDetailing, location) {
  const type = SMALL_OPENING_REBAR_DEFLECTION_TARGET_DETAILING_TYPE;
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

export function createSmallOpeningRebarDeflectionTargetAssignment(value = {}) {
  return normalizeAssignment(value);
}

export function resolveSmallOpeningRebarDeflectionTargets(options = {}) {
  if (!isPlainObject(options)) {
    return unresolved('small-opening-target-selector-invalid');
  }
  const { modelSource, memberType, memberId, openingId, projectDetailing } = options;
  const scope = normalizeOpeningScope({ modelSource, memberType, memberId, openingId });
  if (!scope) {
    return unresolved('small-opening-target-selector-invalid');
  }

  const source = projectDetailing === undefined ? getRebarProjectDetailing() : projectDetailing;
  const location = entryLocation(source);
  if (!location.ok) {
    return unresolved('small-opening-target-entry-ambiguous-or-invalid', {
      detail: location.error,
    });
  }
  if (location.location === 'missing') return inactive();

  const checked = validateEntry(location.entry);
  if (!checked.ok) {
    return unresolved('small-opening-target-entry-invalid', { detail: checked.error });
  }
  if (location.entry.productionEnabled !== true) return inactive('DISABLED');

  const scopeKey = openingScopeKey(scope);
  const targets = checked.assignments
    .filter((assignment) => openingScopeKey(assignment) === scopeKey)
    .sort((a, b) => (a.barIdentity < b.barIdentity ? -1 : a.barIdentity > b.barIdentity ? 1 : 0))
    .map((assignment) => Object.freeze({ ...assignment }));

  if (targets.length === 0) return inactive('NO_TARGET');

  return Object.freeze({
    active: true,
    resolved: true,
    status: 'TARGETS_READY',
    reason: null,
    source: 'project-detailing',
    sourceRef: SMALL_OPENING_REBAR_DEFLECTION_TARGET_SOURCE,
    targets: Object.freeze(targets),
  });
}

export function upsertSmallOpeningRebarDeflectionTargetAssignment(value) {
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

  const key = targetKey(normalized.assignment);
  const retained = existing.assignments.filter((assignment) => targetKey(assignment) !== key);
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

export function removeSmallOpeningRebarDeflectionTargetAssignment(value) {
  const key = targetKey(value);
  if (!key) {
    return { ok: false, error: 'small opening target selector is incomplete' };
  }

  const projectDetailing = getRebarProjectDetailing();
  const location = entryLocation(projectDetailing);
  if (!location.ok) return location;
  if (location.location === 'missing') {
    return { ok: true, changed: false, projectDetailing };
  }

  const existing = validateEntry(location.entry);
  if (!existing.ok) return existing;

  const assignments = existing.assignments.filter((assignment) => targetKey(assignment) !== key);
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
  normalizeOpeningScope,
  openingScopeKey,
  targetKey,
});
