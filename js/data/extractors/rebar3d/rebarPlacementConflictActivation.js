/**
 * @fileoverview Project activation and explicit override contracts for Issue #292.
 */

import { getRebarProjectDetailing } from '../../../config/rebarProjectDetailing.js';
import { DEFAULT_REBAR_PLACEMENT_RULE_SET } from './rebarPlacementRuleSet.js';
import { getRebarDetailingRule } from './rebarDetailingRuleRegistry.js';

const EPS = 1e-6;
const PLACEMENT_RULE_DETAILING_TYPE = 'REBAR_PLACEMENT_CONFLICT_RULES';
const PLACEMENT_OVERRIDE_DETAILING_TYPE = 'REBAR_PLACEMENT_CONFLICT_OVERRIDE';
const VALID_OVERRIDE_ACTIONS = new Set(['KEEP_COLUMN_MOVE_BEAM', 'KEEP_BEAM_MOVE_COLUMN']);
const PROJECT_ENTRY_MISSING = Symbol('project-entry-missing');

function automaticConflictRuleIds() {
  return DEFAULT_REBAR_PLACEMENT_RULE_SET.conflictRules
    .map((rule) => getRebarDetailingRule(rule.id))
    .filter(
      (rule) =>
        rule?.activation === 'GEOMETRY_CONDITION_REQUIRED' &&
        ['NORMATIVE', 'DERIVED', 'EXPERT_ACCEPTED'].includes(rule?.maturity),
    )
    .map((rule) => rule.id)
    .sort();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function projectEntry(projectDetailing, type) {
  if (!isPlainObject(projectDetailing)) return PROJECT_ENTRY_MISSING;
  if (Object.prototype.hasOwnProperty.call(projectDetailing, type)) {
    return projectDetailing[type];
  }
  if (
    isPlainObject(projectDetailing.special) &&
    Object.prototype.hasOwnProperty.call(projectDetailing.special, type)
  ) {
    return projectDetailing.special[type];
  }
  return PROJECT_ENTRY_MISSING;
}

export function resolveRebarPlacementConflictRuleActivation(projectDetailing) {
  const source = projectDetailing === undefined ? getRebarProjectDetailing() : projectDetailing;
  const autoRuleIds = automaticConflictRuleIds();
  const entry = projectEntry(source, PLACEMENT_RULE_DETAILING_TYPE);
  if (entry === PROJECT_ENTRY_MISSING) {
    return Object.freeze({
      active: autoRuleIds.length > 0,
      resolved: true,
      status: autoRuleIds.length > 0 ? 'AUTO_RULES_READY' : 'NOT_CONFIGURED',
      reason: null,
      source: autoRuleIds.length > 0 ? 'rule-registry' : null,
      enabledRuleIds: Object.freeze(autoRuleIds.slice()),
      autoRuleIds: Object.freeze(autoRuleIds.slice()),
    });
  }
  if (!isPlainObject(entry)) {
    return Object.freeze({
      active: true,
      resolved: false,
      status: 'UNRESOLVED',
      reason: 'rebar-placement-conflict-rules-entry-invalid',
      source: 'project-detailing',
      enabledRuleIds: Object.freeze([]),
    });
  }
  if (entry.productionEnabled !== true) {
    return Object.freeze({
      active: autoRuleIds.length > 0,
      resolved: true,
      status: autoRuleIds.length > 0 ? 'AUTO_RULES_READY' : 'DISABLED',
      reason: null,
      source: autoRuleIds.length > 0 ? 'rule-registry' : 'project-detailing',
      enabledRuleIds: Object.freeze(autoRuleIds.slice()),
      autoRuleIds: Object.freeze(autoRuleIds.slice()),
    });
  }
  if (entry.productionMode !== 'RULE_ALLOWLIST') {
    return Object.freeze({
      active: true,
      resolved: false,
      status: 'UNRESOLVED',
      reason: 'rebar-placement-conflict-rules-rule-allowlist-required',
      source: 'project-detailing',
      enabledRuleIds: Object.freeze([]),
    });
  }
  if (!Array.isArray(entry.enabledRuleIds) || entry.enabledRuleIds.length === 0) {
    return Object.freeze({
      active: true,
      resolved: false,
      status: 'UNRESOLVED',
      reason: 'rebar-placement-conflict-rules-enabled-rule-ids-required',
      source: 'project-detailing',
      enabledRuleIds: Object.freeze([]),
    });
  }

  const allowedConflictIds = new Set(
    DEFAULT_REBAR_PLACEMENT_RULE_SET.conflictRules.map((rule) => rule.id),
  );
  const projectEnabledRuleIds = [
    ...new Set(entry.enabledRuleIds.map((value) => String(value).trim()).filter(Boolean)),
  ].sort();
  for (const ruleId of projectEnabledRuleIds) {
    if (!allowedConflictIds.has(ruleId)) {
      return Object.freeze({
        active: true,
        resolved: false,
        status: 'UNRESOLVED',
        reason: `rebar-placement-conflict-rule-not-in-ruleset:${ruleId}`,
        source: 'project-detailing',
        enabledRuleIds: Object.freeze([]),
      });
    }
    if (autoRuleIds.includes(ruleId)) {
      // Backward compatibility: an older project may still list the A2 rule
      // explicitly. It is now geometry-conditioned by default, so the redundant
      // allowlist entry is accepted and deduplicated rather than treated as invalid.
      continue;
    }
    const rule = getRebarDetailingRule(ruleId);
    if (!rule || rule.activation !== 'PROJECT_OPT_IN' || rule.autoApply !== false) {
      return Object.freeze({
        active: true,
        resolved: false,
        status: 'UNRESOLVED',
        reason: `rebar-placement-conflict-rule-not-project-opt-in:${ruleId}`,
        source: 'project-detailing',
        enabledRuleIds: Object.freeze([]),
      });
    }
    if (rule.maturity === 'EXPERIMENTAL' && entry.acceptExperimental !== true) {
      return Object.freeze({
        active: true,
        resolved: false,
        status: 'UNRESOLVED',
        reason: `rebar-placement-conflict-rule-experimental-acceptance-required:${ruleId}`,
        source: 'project-detailing',
        enabledRuleIds: Object.freeze([]),
      });
    }
  }

  const enabledRuleIds = [...new Set([...autoRuleIds, ...projectEnabledRuleIds])].sort();
  return Object.freeze({
    active: true,
    resolved: true,
    status: 'RULE_ALLOWLIST_READY',
    reason: null,
    source: 'project-detailing',
    enabledRuleIds: Object.freeze(enabledRuleIds),
    autoRuleIds: Object.freeze(autoRuleIds.slice()),
    acceptExperimental: entry.acceptExperimental === true,
  });
}

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim().toUpperCase();
}

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonBlank(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizedModelSource(value) {
  const normalized = text(value);
  return normalized === 'A' || normalized === 'B' ? normalized : null;
}

function localPosition(value) {
  if (!isPlainObject(value)) return null;
  const u = finite(value.u);
  const v = finite(value.v);
  return u === null || v === null ? null : Object.freeze({ u, v });
}

function nonNegativeInteger(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeOverrideFingerprint(value, index, side) {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      reason: `rebar-placement-conflict-override-assignment-${index}-${side}-fingerprint-required`,
    };
  }
  const role = nonBlank(value.role);
  const layer = nonNegativeInteger(value.layer);
  const diaName = nonBlank(value.diaName);
  const topologyPosition = nonBlank(value.topologyPosition);
  const position = localPosition(value.localPosition);
  if (!role || layer === null || !diaName || !topologyPosition || !position) {
    return {
      ok: false,
      reason: `rebar-placement-conflict-override-assignment-${index}-${side}-fingerprint-invalid`,
    };
  }
  return {
    ok: true,
    fingerprint: Object.freeze({
      role: role.toUpperCase(),
      layer,
      diaName: diaName.toUpperCase(),
      grade: nonBlank(value.grade)?.toUpperCase() || null,
      topologyPosition,
      localPosition: position,
    }),
  };
}

function validatePlacementOverrideAssignment(assignment, index) {
  if (!isPlainObject(assignment)) {
    return { ok: false, reason: `rebar-placement-conflict-override-assignment-${index}-invalid` };
  }
  const modelSource = normalizedModelSource(assignment.modelSource);
  const nodeId = nonBlank(assignment.nodeId);
  const columnRef = nonBlank(assignment.columnRef);
  const beamRef = nonBlank(assignment.beamRef);
  const action = text(assignment.action);
  if (!modelSource || !nodeId || !columnRef || !beamRef) {
    return {
      ok: false,
      reason: `rebar-placement-conflict-override-assignment-${index}-selector-required`,
    };
  }
  if (!VALID_OVERRIDE_ACTIONS.has(action)) {
    return {
      ok: false,
      reason: `rebar-placement-conflict-override-assignment-${index}-action-invalid`,
    };
  }
  const columnFingerprint = normalizeOverrideFingerprint(
    assignment.columnFingerprint,
    index,
    'column',
  );
  if (!columnFingerprint.ok) return columnFingerprint;
  const beamFingerprint = normalizeOverrideFingerprint(assignment.beamFingerprint, index, 'beam');
  if (!beamFingerprint.ok) return beamFingerprint;
  return {
    ok: true,
    assignment: Object.freeze({
      modelSource,
      nodeId,
      columnRef,
      beamRef,
      action,
      columnFingerprint: columnFingerprint.fingerprint,
      beamFingerprint: beamFingerprint.fingerprint,
      note: nonBlank(assignment.note),
    }),
  };
}

function overrideFingerprintMatches(bar, expected) {
  if (!bar || !expected) return false;
  const actualPosition = localPosition(bar.localPosition);
  if (!actualPosition) return false;
  return (
    text(bar.role) === expected.role &&
    nonNegativeInteger(bar.layer) === expected.layer &&
    text(bar.diaName || bar.dia) === expected.diaName &&
    text(bar.grade) === text(expected.grade) &&
    String(bar.topologyPosition || '') === expected.topologyPosition &&
    Math.hypot(
      actualPosition.u - expected.localPosition.u,
      actualPosition.v - expected.localPosition.v,
    ) <= EPS
  );
}

function placementOverrideActivationResult({
  active,
  resolved,
  status,
  reason = null,
  source = null,
}) {
  return Object.freeze({
    active,
    resolved,
    status,
    reason,
    source,
    enabledRuleIds: Object.freeze([]),
  });
}

function hasPlacementOverrideScope(raw) {
  return (
    isPlainObject(raw) &&
    normalizedModelSource(raw.modelSource) !== null &&
    nonBlank(raw.nodeId) !== null &&
    nonBlank(raw.columnRef) !== null &&
    nonBlank(raw.beamRef) !== null
  );
}

export function resolveRebarPlacementConflictOverrideActivation(projectDetailing) {
  const source = projectDetailing === undefined ? getRebarProjectDetailing() : projectDetailing;
  const entry = projectEntry(source, PLACEMENT_OVERRIDE_DETAILING_TYPE);
  if (entry === PROJECT_ENTRY_MISSING) {
    return placementOverrideActivationResult({
      active: false,
      resolved: true,
      status: 'NOT_CONFIGURED',
    });
  }
  if (!isPlainObject(entry)) {
    return placementOverrideActivationResult({
      active: true,
      resolved: false,
      status: 'UNRESOLVED',
      reason: 'rebar-placement-conflict-override-entry-invalid',
      source: 'project-detailing',
    });
  }
  if (entry.productionEnabled !== true) {
    return placementOverrideActivationResult({
      active: false,
      resolved: true,
      status: 'DISABLED',
      source: 'project-detailing',
    });
  }
  if (entry.productionMode !== 'EXPLICIT') {
    return placementOverrideActivationResult({
      active: true,
      resolved: false,
      status: 'UNRESOLVED',
      reason: 'rebar-placement-conflict-override-explicit-mode-required',
      source: 'project-detailing',
    });
  }
  if (!Array.isArray(entry.assignments) || entry.assignments.length === 0) {
    return placementOverrideActivationResult({
      active: true,
      resolved: false,
      status: 'UNRESOLVED',
      reason: 'rebar-placement-conflict-override-assignments-required',
      source: 'project-detailing',
    });
  }
  if (entry.assignments.some((assignment) => !hasPlacementOverrideScope(assignment))) {
    return placementOverrideActivationResult({
      active: true,
      resolved: false,
      status: 'UNRESOLVED',
      reason: 'rebar-placement-conflict-override-assignment-scope-required',
      source: 'project-detailing',
    });
  }
  return placementOverrideActivationResult({
    active: true,
    resolved: true,
    status: 'EXPLICIT_OVERRIDE_READY',
    source: 'project-detailing',
  });
}

export function resolveRebarPlacementConflictActivation(projectDetailing) {
  const ruleActivation = resolveRebarPlacementConflictRuleActivation(projectDetailing);
  const overrideActivation = resolveRebarPlacementConflictOverrideActivation(projectDetailing);
  const active = ruleActivation.active || overrideActivation.active;
  const resolved =
    (!ruleActivation.active || ruleActivation.resolved) &&
    (!overrideActivation.active || overrideActivation.resolved);

  return Object.freeze({
    active,
    resolved,
    status: !active ? 'NOT_CONFIGURED' : resolved ? 'PLACEMENT_CONFLICT_READY' : 'UNRESOLVED',
    reason:
      (ruleActivation.active && !ruleActivation.resolved ? ruleActivation.reason : null) ||
      (overrideActivation.active && !overrideActivation.resolved
        ? overrideActivation.reason
        : null),
    enabledRuleIds: ruleActivation.resolved ? ruleActivation.enabledRuleIds : Object.freeze([]),
    ruleActivation,
    overrideActivation,
  });
}

export function resolveRebarPlacementConflictOverride(
  projectDetailing,
  { modelSource = null, nodeId = null, column = null, beam = null } = {},
) {
  const source = projectDetailing === undefined ? getRebarProjectDetailing() : projectDetailing;
  const activation = resolveRebarPlacementConflictOverrideActivation(source);
  const inactive = (status = activation.status) =>
    Object.freeze({
      active: false,
      resolved: true,
      status,
      reason: null,
      source: activation.source,
      action: null,
      assignment: null,
    });
  const unresolved = (reason = activation.reason) =>
    Object.freeze({
      active: true,
      resolved: false,
      status: 'UNRESOLVED',
      reason,
      source: activation.source || 'project-detailing',
      action: null,
      assignment: null,
    });

  if (!activation.active) return inactive();
  if (!activation.resolved) return unresolved();

  const entry = projectEntry(source, PLACEMENT_OVERRIDE_DETAILING_TYPE);

  const key = {
    modelSource: normalizedModelSource(modelSource),
    nodeId: nonBlank(nodeId),
    columnRef: nonBlank(column?.semanticIdentity),
    beamRef: nonBlank(beam?.semanticIdentity),
  };
  if (!key.modelSource || !key.nodeId || !key.columnRef || !key.beamRef) {
    return unresolved('rebar-placement-conflict-override-candidate-key-unresolved');
  }

  const matches = [];
  for (const [index, raw] of entry.assignments.entries()) {
    if (!isPlainObject(raw)) {
      return unresolved(`rebar-placement-conflict-override-assignment-${index}-invalid`);
    }

    const rawScope = [
      [normalizedModelSource(raw.modelSource), key.modelSource],
      [nonBlank(raw.nodeId), key.nodeId],
      [nonBlank(raw.columnRef), key.columnRef],
      [nonBlank(raw.beamRef), key.beamRef],
    ];
    const clearlyOtherPair = rawScope.some(
      ([actual, expected]) => actual !== null && actual !== expected,
    );
    if (clearlyOtherPair) continue;

    const checked = validatePlacementOverrideAssignment(raw, index);
    if (!checked.ok) return unresolved(checked.reason);
    const assignment = checked.assignment;
    if (
      assignment.modelSource === key.modelSource &&
      assignment.nodeId === key.nodeId &&
      assignment.columnRef === key.columnRef &&
      assignment.beamRef === key.beamRef
    ) {
      matches.push(assignment);
    }
  }

  if (matches.length === 0) return inactive('NO_ASSIGNMENT');
  if (matches.length !== 1) {
    return unresolved('rebar-placement-conflict-override-assignment-ambiguous');
  }

  const assignment = matches[0];
  if (!overrideFingerprintMatches(column, assignment.columnFingerprint)) {
    return unresolved('rebar-placement-conflict-override-column-fingerprint-stale');
  }
  if (!overrideFingerprintMatches(beam, assignment.beamFingerprint)) {
    return unresolved('rebar-placement-conflict-override-beam-fingerprint-stale');
  }

  return Object.freeze({
    active: true,
    resolved: true,
    status: 'OVERRIDE_READY',
    reason: null,
    source: 'project-detailing',
    action: assignment.action,
    assignment,
  });
}
