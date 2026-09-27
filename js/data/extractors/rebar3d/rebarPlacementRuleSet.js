/**
 * @fileoverview Issue #292: 配筋干渉を単一priority scoreではなく、
 * semantic facts / contextual pairwise rules / derived mobility で扱う共通基盤。
 *
 * この段階ではproduction placementへ接続しない。#273で既に実装済みの
 * column/girder topology classification と continuity resolverを再利用し、
 * cross-member conflictを扱うためのpure resolver契約を先に固定する。
 */

import { getRebarDetailingRule, rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';

export const RebarMobility = Object.freeze({
  FIXED: 'FIXED',
  PREFERRED: 'PREFERRED',
  MOVABLE: 'MOVABLE',
});

export const RebarConflictAction = Object.freeze({
  KEEP_A_MOVE_B: 'KEEP_A_MOVE_B',
  KEEP_B_MOVE_A: 'KEEP_B_MOVE_A',
  UNRESOLVED: 'UNRESOLVED',
});

const VALID_MOBILITY = new Set(Object.values(RebarMobility));
const VALID_ACTIONS = new Set(Object.values(RebarConflictAction));

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim().toUpperCase();
}

function integerOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function roleClass(fact) {
  const explicit = text(fact?.roleClass);
  if (explicit) return explicit;
  const role = text(fact?.role);
  if (['MAIN', 'MAIN_BAR', 'TOP', 'BOTTOM', 'LONGITUDINAL'].includes(role)) return 'MAIN';
  if (['HOOP', 'STIRRUP', 'TIE', 'TRANSVERSE'].includes(role)) return 'TRANSVERSE';
  if (['DISTRIBUTION', 'WEB', 'SIDE'].includes(role)) return 'SECONDARY';
  return role || 'UNKNOWN';
}

function normalizedFact(fact) {
  return Object.freeze({
    memberType: text(fact?.memberType),
    roleClass: roleClass(fact),
    topologyRole: text(fact?.topologyRole),
    layer: integerOrNull(fact?.layer),
    continuity: text(fact?.continuity),
    semanticIdentity: fact?.semanticIdentity ?? fact?.identityKey ?? fact?.id ?? null,
  });
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => cloneAndFreeze(item)));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = cloneAndFreeze(item);
    return Object.freeze(result);
  }
  return value;
}

function freezePattern(pattern = {}) {
  const result = {};
  for (const [key, value] of Object.entries(pattern)) {
    result[key] = Array.isArray(value)
      ? Object.freeze(value.map((item) => text(item)))
      : text(value);
  }
  return Object.freeze(result);
}

function conflictRuleMetadata(rule) {
  const registryRuleId = String(rule.registryRuleId || rule.id);
  const registered = getRebarDetailingRule(registryRuleId);
  if (!registered) {
    return {
      registryRuleId: null,
      ruleType: String(rule.ruleType || 'LOCAL_CONFLICT_RULE'),
      maturity: String(rule.maturity || 'EXPERIMENTAL'),
      precedence: String(rule.precedence || 'LOCAL'),
      source: String(rule.source || 'UNSPECIFIED'),
      normative: rule.normative === true,
      autoApply: rule.autoApply === true,
      activation: String(rule.activation || (rule.autoApply === true ? 'AUTO' : 'PROJECT_OPT_IN')),
      statement: String(rule.statement || ''),
    };
  }

  const declared = {
    maturity: 'maturity' in rule ? String(rule.maturity) : null,
    source: 'source' in rule ? String(rule.source) : null,
    activation: 'activation' in rule ? String(rule.activation) : null,
    autoApply: 'autoApply' in rule ? rule.autoApply === true : null,
  };
  const expected = {
    maturity: registered.maturity,
    source: registered.source,
    activation: registered.activation || (registered.autoApply ? 'AUTO' : 'PROJECT_OPT_IN'),
    autoApply: registered.autoApply,
  };
  for (const key of Object.keys(declared)) {
    if (declared[key] !== null && declared[key] !== expected[key]) {
      throw new TypeError(
        `Conflict rule metadata must match Rule Registry for ${registryRuleId}: ${key}`,
      );
    }
  }

  return {
    registryRuleId,
    ruleType: registered.type,
    maturity: registered.maturity,
    precedence: registered.precedence,
    source: registered.source,
    normative: registered.normative,
    autoApply: registered.autoApply,
    activation: expected.activation,
    statement: registered.statement || '',
  };
}

function freezeConflictRule(rule) {
  if (!rule?.id) throw new TypeError('Rebar conflict rule requires id');
  if ('priority' in rule || 'score' in rule || 'weight' in rule) {
    throw new TypeError(
      `Rebar conflict rule must not use scalar priority/score/weight: ${rule.id}`,
    );
  }
  if (!VALID_ACTIONS.has(rule.action) || rule.action === RebarConflictAction.UNRESOLVED) {
    throw new TypeError(`Invalid rebar conflict action: ${rule.action}`);
  }
  const metadata = conflictRuleMetadata(rule);
  return Object.freeze({
    id: String(rule.id),
    a: freezePattern(rule.a),
    b: freezePattern(rule.b),
    action: rule.action,
    symmetric: rule.symmetric === true,
    mayMovePreferred: rule.mayMovePreferred === true,
    ...metadata,
    reason: String(rule.reason || metadata.statement || ''),
  });
}

export function createRebarPlacementRuleSet({
  id,
  classificationRules = [],
  conflictRules = [],
  geometryConstraints = [],
  overridePolicy = {},
} = {}) {
  if (!id) throw new TypeError('Rebar placement RuleSet requires id');
  const ids = new Set();
  const frozenConflictRules = conflictRules.map((rule) => {
    const frozen = freezeConflictRule(rule);
    if (ids.has(frozen.id)) throw new TypeError(`Duplicate rebar conflict rule id: ${frozen.id}`);
    ids.add(frozen.id);
    return frozen;
  });
  return Object.freeze({
    id: String(id),
    classificationRules: cloneAndFreeze(classificationRules),
    conflictRules: Object.freeze(frozenConflictRules),
    geometryConstraints: cloneAndFreeze(geometryConstraints),
    overridePolicy: cloneAndFreeze(overridePolicy),
  });
}

const DEFAULT_CONFLICT_RULES = [
  {
    id: 'ISSUE292-COLUMN-CORNER-VS-GIRDER-INTERMEDIATE',
    a: { memberType: 'COLUMN', roleClass: 'MAIN', topologyRole: 'CORNER' },
    b: {
      memberType: ['GIRDER', 'BEAM'],
      roleClass: 'MAIN',
      topologyRole: 'INTERMEDIATE',
    },
    action: RebarConflictAction.KEEP_A_MOVE_B,
    symmetric: true,
  },
  {
    id: 'ISSUE292-MAIN-VS-TRANSVERSE-FOLLOW',
    a: { roleClass: 'MAIN' },
    b: { roleClass: 'TRANSVERSE' },
    action: RebarConflictAction.KEEP_A_MOVE_B,
    symmetric: true,
  },
  {
    id: 'ISSUE292-A2-SIDE-COLUMN-CORNER-VS-BEAM-CORNER',
    a: { memberType: 'COLUMN', roleClass: 'MAIN', topologyRole: 'CORNER' },
    b: {
      memberType: ['GIRDER', 'BEAM'],
      roleClass: 'MAIN',
      topologyRole: 'CORNER',
      layer: 1,
    },
    action: RebarConflictAction.KEEP_A_MOVE_B,
    symmetric: true,
  },
];

export const DEFAULT_REBAR_PLACEMENT_RULE_SET = createRebarPlacementRuleSet({
  id: 'default-rebar-placement-v1',
  conflictRules: DEFAULT_CONFLICT_RULES,
  overridePolicy: {
    localOnly: true,
    hardConstraintOverrideAllowed: false,
  },
});

function mobilityOverride(fact, context) {
  const override = context?.override ?? fact?.override ?? null;
  const mobility = text(override?.mobility);
  if (VALID_MOBILITY.has(mobility)) {
    return Object.freeze({
      mobility,
      source: 'USER_OVERRIDE',
      reason: 'explicit-mobility-override',
    });
  }
  if (text(override?.action) === 'KEEP') {
    return Object.freeze({
      mobility: RebarMobility.FIXED,
      source: 'USER_OVERRIDE',
      reason: 'explicit-keep-override',
    });
  }
  return null;
}

/**
 * mobilityは鉄筋へ永続化する絶対属性ではなく、現在のsemantic/contextから導出する。
 */
export function deriveRebarMobility(fact, context = {}) {
  const explicit = mobilityOverride(fact, context);
  if (explicit) return explicit;

  const normalized = normalizedFact(fact);
  const matchBasis = String(context?.matchBasis || fact?.matchBasis || '');
  const continuityPreferred = [
    'STRAIGHT',
    'STRAIGHT_THROUGH',
    'CONTINUOUS',
    'BENT_CONTINUOUS',
    'BENT_VERTICAL_THROUGH',
  ];
  const continuityReleased = ['NEW', 'TERMINATE', 'SEPARATE_ANCHORAGE'];
  if (
    matchBasis === 'world-straight-first' ||
    continuityPreferred.includes(normalized.continuity)
  ) {
    return Object.freeze({
      mobility: RebarMobility.PREFERRED,
      source: 'DERIVED',
      reason: 'continuity-preference',
    });
  }

  if (continuityReleased.includes(normalized.continuity)) {
    return Object.freeze({
      mobility: RebarMobility.MOVABLE,
      source: 'DERIVED',
      reason: 'non-continuous-end-condition',
    });
  }

  if (normalized.topologyRole === 'CORNER' && context?.cornerPriority === true) {
    return Object.freeze({
      mobility: RebarMobility.PREFERRED,
      source: 'DERIVED',
      reason: 'contextual-corner-preference',
    });
  }

  return Object.freeze({
    mobility: RebarMobility.MOVABLE,
    source: 'DERIVED',
    reason: normalized.roleClass === 'TRANSVERSE' ? 'transverse-follow' : 'no-restraint-derived',
  });
}

function patternMatches(pattern, fact) {
  for (const [key, expected] of Object.entries(pattern || {})) {
    const actual = fact[key];
    if (Array.isArray(expected)) {
      if (!expected.includes(text(actual))) return false;
    } else if (text(actual) !== expected) {
      return false;
    }
  }
  return true;
}

function reverseAction(action) {
  if (action === RebarConflictAction.KEEP_A_MOVE_B) return RebarConflictAction.KEEP_B_MOVE_A;
  if (action === RebarConflictAction.KEEP_B_MOVE_A) return RebarConflictAction.KEEP_A_MOVE_B;
  return action;
}

function isRuleEnabled(rule, enabledRuleIds) {
  return rule.autoApply === true || enabledRuleIds.has(rule.id);
}

function matchingRuleDecisions(ruleSet, factA, factB, enabledRuleIds) {
  const decisions = [];
  for (const rule of ruleSet.conflictRules) {
    if (!isRuleEnabled(rule, enabledRuleIds)) continue;
    if (patternMatches(rule.a, factA) && patternMatches(rule.b, factB)) {
      decisions.push({ rule, action: rule.action, direction: 'DIRECT' });
      continue;
    }
    if (rule.symmetric && patternMatches(rule.a, factB) && patternMatches(rule.b, factA)) {
      decisions.push({ rule, action: reverseAction(rule.action), direction: 'REVERSED' });
    }
  }
  return decisions.sort((left, right) => left.rule.id.localeCompare(right.rule.id));
}

function conflictRuleTraceMetadata(rule, direction = 'DIRECT') {
  const metadata = rule.registryRuleId
    ? rebarRuleTraceMetadata(rule.registryRuleId)
    : Object.freeze({
        ruleId: rule.id,
        ruleType: rule.ruleType,
        maturity: rule.maturity,
        precedence: rule.precedence,
        source: rule.source,
        normative: rule.normative,
        autoApply: rule.autoApply,
      });
  return Object.freeze({ ...metadata, direction });
}

function mobilityConflictForAction(action, mobilityA, mobilityB, decisions) {
  const movesA = action === RebarConflictAction.KEEP_B_MOVE_A;
  const moved = movesA ? mobilityA : mobilityB;
  const kept = movesA ? mobilityB : mobilityA;
  if (moved.mobility === RebarMobility.FIXED) return 'rule-would-move-fixed-bar';
  if (
    moved.mobility === RebarMobility.PREFERRED &&
    kept.mobility === RebarMobility.MOVABLE &&
    !decisions.every((decision) => decision.rule.mayMovePreferred === true)
  ) {
    return 'rule-would-move-preferred-over-movable';
  }
  return null;
}

function barRef(fact) {
  return fact?.semanticIdentity ?? fact?.identityKey ?? fact?.id ?? fact?.barIndex ?? null;
}

function finiteMovementNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function freezeMovement(movement) {
  if (!movement || typeof movement !== 'object') return null;
  const vector = movement.vector;
  const vectorValues = vector ? [vector.x, vector.y, vector.z].map(finiteMovementNumber) : null;
  const frozenVector =
    vectorValues && vectorValues.every((value) => value !== null)
      ? Object.freeze({
          x: vectorValues[0],
          y: vectorValues[1],
          z: vectorValues[2],
        })
      : null;
  const distanceMm = finiteMovementNumber(movement.distanceMm);
  return Object.freeze({
    kind: String(movement.kind || 'UNSPECIFIED'),
    ...(frozenVector ? { vector: frozenVector } : {}),
    ...(distanceMm !== null ? { distanceMm } : {}),
    ...(movement.effectType ? { effectType: String(movement.effectType) } : {}),
    ...(movement.source ? { source: String(movement.source) } : {}),
  });
}

function unresolvedResult(reason, factA, factB, mobilityA, mobilityB, extra = {}) {
  return Object.freeze({
    status: 'UNRESOLVED',
    selectedAction: RebarConflictAction.UNRESOLVED,
    movedBar: null,
    barA: barRef(factA),
    barB: barRef(factB),
    mobilityA,
    mobilityB,
    appliedRule: null,
    rejectedAlternatives: Object.freeze([]),
    reason,
    source: 'FAIL_CLOSED',
    ...extra,
  });
}

/**
 * pairwise/contextual conflict resolver。
 * Hard Constraint -> explicit FIXED -> pairwise rule の順で評価し、
 * rule tieでactionが競合する場合は配列順で決めずUNRESOLVEDとする。
 */
export function resolveRebarPairConflict(
  barA,
  barB,
  context = {},
  ruleSet = DEFAULT_REBAR_PLACEMENT_RULE_SET,
) {
  const factA = normalizedFact(barA);
  const factB = normalizedFact(barB);
  const mobilityA = deriveRebarMobility(barA, context?.a || context);
  const mobilityB = deriveRebarMobility(barB, context?.b || context);
  const hardConstraintViolations = Array.isArray(context?.hardConstraintViolations)
    ? context.hardConstraintViolations.filter(Boolean)
    : [];

  if (hardConstraintViolations.length) {
    return unresolvedResult('hard-constraint-violation', barA, barB, mobilityA, mobilityB, {
      hardConstraintViolations: Object.freeze(hardConstraintViolations.slice()),
    });
  }

  if (mobilityA.mobility === RebarMobility.FIXED && mobilityB.mobility === RebarMobility.FIXED) {
    return unresolvedResult('both-bars-fixed', barA, barB, mobilityA, mobilityB);
  }
  if (mobilityA.mobility === RebarMobility.FIXED) {
    const overrideRule = Object.freeze({
      ...rebarRuleTraceMetadata('REBAR-PLACEMENT-EXPLICIT-MOBILITY-OVERRIDE'),
      direction: 'DIRECT',
    });
    return Object.freeze({
      status: 'RESOLVED',
      selectedAction: RebarConflictAction.KEEP_A_MOVE_B,
      movedBar: barRef(barB),
      barA: barRef(barA),
      barB: barRef(barB),
      mobilityA,
      mobilityB,
      appliedRule: overrideRule,
      appliedRules: Object.freeze([overrideRule]),
      supportingRuleIds: Object.freeze([overrideRule.ruleId]),
      rejectedAlternatives: Object.freeze([]),
      movement: freezeMovement(context?.movement),
      reason: 'explicit-fixed-mobility-a',
      source: mobilityA.source,
    });
  }
  if (mobilityB.mobility === RebarMobility.FIXED) {
    const overrideRule = Object.freeze({
      ...rebarRuleTraceMetadata('REBAR-PLACEMENT-EXPLICIT-MOBILITY-OVERRIDE'),
      direction: 'DIRECT',
    });
    return Object.freeze({
      status: 'RESOLVED',
      selectedAction: RebarConflictAction.KEEP_B_MOVE_A,
      movedBar: barRef(barA),
      barA: barRef(barA),
      barB: barRef(barB),
      mobilityA,
      mobilityB,
      appliedRule: overrideRule,
      appliedRules: Object.freeze([overrideRule]),
      supportingRuleIds: Object.freeze([overrideRule.ruleId]),
      rejectedAlternatives: Object.freeze([]),
      movement: freezeMovement(context?.movement),
      reason: 'explicit-fixed-mobility-b',
      source: mobilityB.source,
    });
  }

  const enabledRuleIds = new Set((context?.enabledRuleIds || []).map(String));
  const decisions = matchingRuleDecisions(ruleSet, factA, factB, enabledRuleIds);
  if (!decisions.length) {
    return unresolvedResult('no-applicable-conflict-rule', barA, barB, mobilityA, mobilityB);
  }

  const actions = [...new Set(decisions.map((decision) => decision.action))];
  if (actions.length !== 1) {
    return unresolvedResult('conflicting-pairwise-rules', barA, barB, mobilityA, mobilityB, {
      conflictingRuleIds: Object.freeze(decisions.map((decision) => decision.rule.id)),
    });
  }

  const action = actions[0];
  const appliedRules = Object.freeze(
    decisions.map((decision) => conflictRuleTraceMetadata(decision.rule, decision.direction)),
  );
  const supportingRuleIds = Object.freeze(appliedRules.map((rule) => rule.ruleId));
  const mobilityConflict = mobilityConflictForAction(action, mobilityA, mobilityB, decisions);
  if (mobilityConflict) {
    return unresolvedResult('mobility-restraint-conflict', barA, barB, mobilityA, mobilityB, {
      appliedRules,
      supportingRuleIds: Object.freeze([
        ...supportingRuleIds,
        'REBAR-PLACEMENT-MOBILITY-RESTRAINT',
      ]),
      rejectedAlternatives: Object.freeze([Object.freeze({ action, reason: mobilityConflict })]),
      mobilityConflict,
    });
  }

  const movedBar = action === RebarConflictAction.KEEP_A_MOVE_B ? barRef(barB) : barRef(barA);
  const primaryRule = appliedRules.length === 1 ? appliedRules[0] : null;
  return Object.freeze({
    status: 'RESOLVED',
    selectedAction: action,
    movedBar,
    barA: barRef(barA),
    barB: barRef(barB),
    mobilityA,
    mobilityB,
    appliedRule: primaryRule,
    appliedRules,
    supportingRuleIds,
    rejectedAlternatives: Object.freeze([]),
    movement: freezeMovement(context?.movement),
    reason:
      decisions.length === 1
        ? decisions[0].rule.reason || 'pairwise-conflict-rule'
        : 'multiple-supporting-pairwise-rules',
    source: decisions.length === 1 ? decisions[0].rule.source : 'MULTIPLE_SUPPORTING_RULES',
  });
}
