/**
 * @fileoverview Issue #292: project-scoped placement conflict override authoring helpers.
 *
 * The resolver remains fail-closed and owns final activation/geometry validation.
 * This module only builds stable semantic fingerprints and performs deterministic,
 * pair-local read/modify/write operations against the runtime projectDetailing source.
 */

import { getRebarProjectDetailing, setRebarProjectDetailing } from './rebarProjectDetailing.js';

const DETAILING_TYPE = 'REBAR_PLACEMENT_CONFLICT_OVERRIDE';
const VALID_ACTIONS = new Set(['KEEP_COLUMN_MOVE_BEAM', 'KEEP_BEAM_MOVE_COLUMN']);

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

function nonNegativeInteger(value) {
  const number = finite(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeModelSource(value) {
  const normalized = upper(value);
  return normalized === 'A' || normalized === 'B' ? normalized : null;
}

function normalizeLocalPosition(value) {
  if (!isPlainObject(value)) return null;
  const u = finite(value.u);
  const v = finite(value.v);
  return u === null || v === null ? null : { u, v };
}

function normalizeFingerprint(value) {
  if (!isPlainObject(value)) return null;
  const role = upper(value.role);
  const layer = nonNegativeInteger(value.layer);
  const diaName = upper(value.diaName || value.dia);
  const topologyPosition = nonBlank(value.topologyPosition);
  const localPosition = normalizeLocalPosition(value.localPosition);
  if (!role || layer === null || !diaName || !topologyPosition || !localPosition) return null;
  return {
    role,
    layer,
    diaName,
    grade: upper(value.grade),
    topologyPosition,
    localPosition,
  };
}

function normalizeScope(value = {}) {
  const modelSource = normalizeModelSource(value.modelSource);
  const nodeId = nonBlank(value.nodeId);
  const columnRef = nonBlank(value.columnRef);
  const beamRef = nonBlank(value.beamRef);
  if (!modelSource || !nodeId || !columnRef || !beamRef) return null;
  return { modelSource, nodeId, columnRef, beamRef };
}

function scopeKey(value) {
  const scope = normalizeScope(value);
  return scope
    ? `${scope.modelSource}\u0000${scope.nodeId}\u0000${scope.columnRef}\u0000${scope.beamRef}`
    : null;
}

function cloneSnapshotValue(value) {
  if (Array.isArray(value)) return value.map(cloneSnapshotValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneSnapshotValue(item)]),
    );
  }
  return value;
}

function assignmentMatchesScope(value, scope) {
  const key = scopeKey(value);
  return key !== null && key === scopeKey(scope);
}

function snapshotEntry(resolved, scope) {
  if (resolved.location === 'missing') {
    return {
      ok: true,
      scope,
      location: 'missing',
      entryPresent: false,
      entryProperties: null,
      assignmentsPropertyPresent: false,
      assignments: [],
    };
  }
  if (!isPlainObject(resolved.entry)) {
    return { ok: false, error: 'placement override entry must be an object' };
  }
  const hasAssignments = Object.prototype.hasOwnProperty.call(resolved.entry, 'assignments');
  const assignments = hasAssignments ? resolved.entry.assignments : [];
  if (!Array.isArray(assignments)) {
    return { ok: false, error: 'placement override assignments must be an array' };
  }
  const entryProperties = Object.fromEntries(
    Object.entries(resolved.entry)
      .filter(([key]) => key !== 'assignments')
      .map(([key, value]) => [key, cloneSnapshotValue(value)]),
  );
  return {
    ok: true,
    scope,
    location: resolved.location,
    entryPresent: true,
    entryProperties,
    assignmentsPropertyPresent: hasAssignments,
    assignments: assignments.flatMap((value, index) =>
      assignmentMatchesScope(value, scope) ? [{ index, value: cloneSnapshotValue(value) }] : [],
    ),
  };
}

function snapshotAssignmentValues(snapshot) {
  if (!Array.isArray(snapshot?.assignments)) return null;
  return snapshot.assignments.map((item) =>
    isPlainObject(item) && Number.isInteger(item.index) && item.index >= 0
      ? { index: item.index, value: cloneSnapshotValue(item.value) }
      : null,
  );
}

function snapshotsMatch(current, expected, scope) {
  if (
    !expected ||
    scopeKey(expected.scope) !== scopeKey(scope) ||
    !['missing', 'top', 'special'].includes(expected.location) ||
    (expected.entryPresent && !isPlainObject(expected.entryProperties))
  ) {
    return false;
  }
  const currentAssignments = snapshotAssignmentValues(current);
  const expectedAssignments = snapshotAssignmentValues(expected);
  if (
    !currentAssignments ||
    !expectedAssignments ||
    currentAssignments.some((item) => item === null) ||
    expectedAssignments.some((item) => item === null) ||
    expectedAssignments.some(({ value }) => !assignmentMatchesScope(value, scope))
  ) {
    return false;
  }
  return (
    current.location === expected.location &&
    current.entryPresent === expected.entryPresent &&
    current.assignmentsPropertyPresent === expected.assignmentsPropertyPresent &&
    JSON.stringify(current.entryProperties) === JSON.stringify(expected.entryProperties) &&
    JSON.stringify(currentAssignments) === JSON.stringify(expectedAssignments)
  );
}

/**
 * 現在のpair-local overrideを、assignmentの妥当性判定を行わずraw snapshotとして取得する。
 * stale fingerprintやscopeが特定できる不正assignmentをUndoで正確に戻すために使う。
 */
export function captureRebarPlacementConflictOverrideSnapshot(scopeValue) {
  const scope = normalizeScope(scopeValue);
  if (!scope) return { ok: false, error: 'placement override selector is incomplete' };
  const projectDetailing = getRebarProjectDetailing();
  const resolved = resolveEntryLocation(projectDetailing);
  if (!resolved.ok) return resolved;
  return snapshotEntry(resolved, scope);
}

/**
 * 期待される現在のpair snapshotと一致する場合にだけ、target snapshotを復元する。
 * 他pairのassignmentは現在値のまま保持する。
 */
export function restoreRebarPlacementConflictOverrideSnapshot(
  scopeValue,
  targetSnapshot,
  expectedCurrentSnapshot = null,
) {
  const scope = normalizeScope(scopeValue);
  if (!scope) return { ok: false, error: 'placement override selector is incomplete' };
  if (!targetSnapshot || scopeKey(targetSnapshot.scope) !== scopeKey(scope)) {
    return { ok: false, error: 'placement override snapshot scope does not match' };
  }
  if (
    !['missing', 'top', 'special'].includes(targetSnapshot.location) ||
    (targetSnapshot.entryPresent && !isPlainObject(targetSnapshot.entryProperties))
  ) {
    return { ok: false, error: 'placement override snapshot is invalid' };
  }
  const targetAssignments = snapshotAssignmentValues(targetSnapshot);
  if (!targetAssignments || targetAssignments.some((item) => item === null)) {
    return { ok: false, error: 'placement override snapshot is invalid' };
  }
  if (targetAssignments.some(({ value }) => !assignmentMatchesScope(value, scope))) {
    return { ok: false, error: 'placement override snapshot contains another pair' };
  }
  if (!targetSnapshot.entryPresent && targetAssignments.length > 0) {
    return { ok: false, error: 'missing placement override entry cannot contain assignments' };
  }
  const projectDetailing = getRebarProjectDetailing();
  const resolved = resolveEntryLocation(projectDetailing);
  if (!resolved.ok) return resolved;
  const currentSnapshot = snapshotEntry(resolved, scope);
  if (!currentSnapshot.ok) return currentSnapshot;
  if (expectedCurrentSnapshot && !snapshotsMatch(currentSnapshot, expectedCurrentSnapshot, scope)) {
    return {
      ok: false,
      error: 'placement override changed since this history entry was recorded',
    };
  }

  const currentAssignments =
    resolved.location === 'missing' ? [] : resolved.entry.assignments || [];
  const unrelatedAssignments = currentAssignments.filter(
    (value) => !assignmentMatchesScope(value, scope),
  );
  const nextAssignments = [...unrelatedAssignments];
  for (const { index, value } of targetAssignments) {
    nextAssignments.splice(Math.min(index, nextAssignments.length), 0, value);
  }

  const hasUnrelatedAssignments = unrelatedAssignments.length > 0;
  const shouldKeepEntry = targetSnapshot.entryPresent || hasUnrelatedAssignments;
  if (!shouldKeepEntry) {
    if (resolved.location === 'missing') {
      return { ok: true, changed: false, projectDetailing };
    }
    const write = deleteEntry(projectDetailing, resolved.location);
    return write.ok ? { ok: true, changed: true, projectDetailing: write.projectDetailing } : write;
  }

  const location =
    resolved.location !== 'missing'
      ? resolved.location
      : targetSnapshot.location === 'special'
        ? 'special'
        : 'top';
  const baseProperties = hasUnrelatedAssignments
    ? Object.fromEntries(
        Object.entries(resolved.entry)
          .filter(([key]) => key !== 'assignments')
          .map(([key, value]) => [key, cloneSnapshotValue(value)]),
      )
    : cloneSnapshotValue(targetSnapshot.entryProperties || {});
  const assignmentsPropertyPresent = hasUnrelatedAssignments
    ? Object.prototype.hasOwnProperty.call(resolved.entry, 'assignments')
    : targetSnapshot.assignmentsPropertyPresent === true;
  const entry = { ...baseProperties };
  if (assignmentsPropertyPresent || nextAssignments.length > 0) entry.assignments = nextAssignments;
  const write = writeEntry(projectDetailing, location, entry);
  return write.ok ? { ok: true, changed: true, projectDetailing: write.projectDetailing } : write;
}

function normalizeAssignment(value) {
  if (!isPlainObject(value)) {
    return { ok: false, error: 'placement override assignment must be an object' };
  }
  const scope = normalizeScope(value);
  if (!scope) {
    return { ok: false, error: 'placement override assignment selector is incomplete' };
  }
  const action = upper(value.action);
  if (!VALID_ACTIONS.has(action)) {
    return { ok: false, error: 'placement override action is invalid' };
  }
  const columnFingerprint = normalizeFingerprint(value.columnFingerprint);
  const beamFingerprint = normalizeFingerprint(value.beamFingerprint);
  if (!columnFingerprint || !beamFingerprint) {
    return { ok: false, error: 'placement override semantic fingerprint is incomplete' };
  }
  return {
    ok: true,
    assignment: {
      ...scope,
      action,
      columnFingerprint,
      beamFingerprint,
      note: nonBlank(value.note),
    },
  };
}

function resolveEntryLocation(projectDetailing) {
  const topLevel = Object.prototype.hasOwnProperty.call(projectDetailing, DETAILING_TYPE);
  const nested =
    isPlainObject(projectDetailing.special) &&
    Object.prototype.hasOwnProperty.call(projectDetailing.special, DETAILING_TYPE);
  if (topLevel && nested) {
    return { ok: false, error: 'placement override exists in both top-level and special scopes' };
  }
  if (topLevel) return { ok: true, location: 'top', entry: projectDetailing[DETAILING_TYPE] };
  if (nested) {
    return { ok: true, location: 'special', entry: projectDetailing.special[DETAILING_TYPE] };
  }
  return { ok: true, location: 'missing', entry: null };
}

function normalizeExistingAssignments(entry) {
  if (entry === null) return { ok: true, entry: {}, assignments: [] };
  if (!isPlainObject(entry)) {
    return { ok: false, error: 'placement override entry must be an object' };
  }
  if (entry.productionMode !== undefined && entry.productionMode !== 'EXPLICIT') {
    return { ok: false, error: 'placement override entry must use EXPLICIT mode' };
  }
  if (entry.assignments !== undefined && !Array.isArray(entry.assignments)) {
    return { ok: false, error: 'placement override assignments must be an array' };
  }
  const assignments = [];
  const seen = new Set();
  for (const raw of entry.assignments || []) {
    if (!isPlainObject(raw)) {
      return { ok: false, error: 'existing placement override assignment must be an object' };
    }
    const key = scopeKey(raw);
    if (!key) {
      return { ok: false, error: 'existing placement override assignment selector is incomplete' };
    }
    if (seen.has(key)) {
      return { ok: false, error: 'existing placement override assignment scope is ambiguous' };
    }
    seen.add(key);
    assignments.push(raw);
  }
  return { ok: true, entry, assignments };
}

function sortedAssignments(assignments) {
  return [...assignments].sort((a, b) => {
    const left = scopeKey(a);
    const right = scopeKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function writeEntry(projectDetailing, location, entry) {
  const next = { ...projectDetailing };
  if (location === 'special') {
    next.special = { ...(projectDetailing.special || {}), [DETAILING_TYPE]: entry };
  } else {
    next[DETAILING_TYPE] = entry;
  }
  return setRebarProjectDetailing(next);
}

function deleteEntry(projectDetailing, location) {
  const next = { ...projectDetailing };
  if (location === 'special') {
    const special = { ...(projectDetailing.special || {}) };
    delete special[DETAILING_TYPE];
    if (Object.keys(special).length === 0) delete next.special;
    else next.special = special;
  } else {
    delete next[DETAILING_TYPE];
  }
  return setRebarProjectDetailing(next);
}

export function createRebarPlacementConflictOverrideAssignment({
  modelSource,
  nodeId,
  column,
  beam,
  action,
  note = null,
} = {}) {
  const raw = {
    modelSource,
    nodeId,
    columnRef: nonBlank(column?.semanticIdentity),
    beamRef: nonBlank(beam?.semanticIdentity),
    action,
    columnFingerprint: column,
    beamFingerprint: beam,
    note,
  };
  return normalizeAssignment(raw);
}

export function upsertRebarPlacementConflictOverrideAssignment(value) {
  const normalized = normalizeAssignment(value);
  if (!normalized.ok) return normalized;

  const projectDetailing = getRebarProjectDetailing();
  const resolved = resolveEntryLocation(projectDetailing);
  if (!resolved.ok) return resolved;
  const existing = normalizeExistingAssignments(resolved.entry);
  let existingAssignments = existing.assignments;
  if (!existing.ok) {
    if (!isPlainObject(resolved.entry)) return existing;
    if (
      resolved.entry.productionMode !== undefined &&
      resolved.entry.productionMode !== 'EXPLICIT'
    ) {
      return existing;
    }
    const rawAssignments = resolved.entry.assignments;
    if (rawAssignments !== undefined && !Array.isArray(rawAssignments)) return existing;
    const assignments = rawAssignments || [];
    const targetKey = scopeKey(normalized.assignment);
    const hasInvalidTarget = assignments.some((item) => scopeKey(item) === targetKey);
    if (!hasInvalidTarget) return existing;
    const retained = normalizeExistingAssignments({
      ...resolved.entry,
      assignments: assignments.filter((item) => scopeKey(item) !== targetKey),
    });
    if (!retained.ok) return retained;
    existingAssignments = retained.assignments;
  }

  const targetKey = scopeKey(normalized.assignment);
  const retained = existingAssignments.filter((assignment) => scopeKey(assignment) !== targetKey);
  const assignments = sortedAssignments([...retained, normalized.assignment]);
  const entry = {
    ...(resolved.location === 'missing' ? {} : resolved.entry),
    productionEnabled: true,
    productionMode: 'EXPLICIT',
    assignments,
  };
  const write = writeEntry(
    projectDetailing,
    resolved.location === 'missing' ? 'top' : resolved.location,
    entry,
  );
  return write.ok
    ? { ok: true, assignment: normalized.assignment, projectDetailing: write.projectDetailing }
    : write;
}

export function removeRebarPlacementConflictOverrideAssignment(scopeValue) {
  const targetKey = scopeKey(scopeValue);
  if (!targetKey) return { ok: false, error: 'placement override selector is incomplete' };

  const projectDetailing = getRebarProjectDetailing();
  const resolved = resolveEntryLocation(projectDetailing);
  if (!resolved.ok) return resolved;
  if (resolved.location === 'missing') {
    return { ok: true, changed: false, projectDetailing };
  }
  if (!isPlainObject(resolved.entry)) {
    return { ok: false, error: 'placement override entry must be an object' };
  }
  const rawAssignments = resolved.entry.assignments;
  if (rawAssignments !== undefined && !Array.isArray(rawAssignments)) {
    return { ok: false, error: 'placement override assignments must be an array' };
  }
  const currentAssignments = rawAssignments || [];

  const assignments = currentAssignments.filter((assignment) => scopeKey(assignment) !== targetKey);
  if (assignments.length === currentAssignments.length) {
    return { ok: true, changed: false, projectDetailing };
  }
  const write =
    assignments.length === 0
      ? deleteEntry(projectDetailing, resolved.location)
      : writeEntry(projectDetailing, resolved.location, {
          ...resolved.entry,
          assignments,
        });
  return write.ok ? { ok: true, changed: true, projectDetailing: write.projectDetailing } : write;
}
