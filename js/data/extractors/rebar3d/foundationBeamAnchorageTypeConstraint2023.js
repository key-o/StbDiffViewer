/**
 * @fileoverview 日建連・JSCA「鉄筋コンクリート造配筋標準図」2023年版 §6 の
 * 基礎梁typeと適用条件の整合性だけを検証する。
 *
 * 基礎大梁 (§6-1):
 * - べた基礎・連続基礎: A1
 * - 杭基礎・独立基礎: B1/B2/C1/C2
 * - 浮上りなし: A1/B1/C1
 * - 浮上りあり: A1/B2/C2
 *
 * 基礎小梁 (§6-2):
 * - 連続する: A1/B1
 * - 連続しない: A2/B2
 *
 * A/B/C系そのものの採用は「配置は構造図による」ため、このmoduleは自動選択しない。
 */

const GIRDER_TYPES = new Set(['A1', 'B1', 'B2', 'C1', 'C2']);
const SMALL_BEAM_TYPES = new Set(['A1', 'A2', 'B1', 'B2']);
const FOUNDATION_SYSTEMS = new Set(['RAFT_OR_CONTINUOUS', 'PILE_OR_ISOLATED']);

function normalizeMemberKind(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  if (normalized === 'STBGIRDER' || normalized === 'GIRDER') return 'GIRDER';
  if (normalized === 'STBBEAM' || normalized === 'BEAM') return 'BEAM';
  return null;
}

function normalizeType(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

function normalizeFoundationSystem(value) {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : null;
  return normalized && FOUNDATION_SYSTEMS.has(normalized) ? normalized : null;
}

function invalid(reason, extra = {}) {
  return {
    status: 'INVALID',
    resolved: false,
    valid: false,
    blockers: [reason],
    source: 'NIKKENREN-JSCA-RC-REBAR-STANDARD-2023-SECTION-6',
    ...extra,
  };
}

function unresolved(reason, extra = {}) {
  return {
    status: 'UNRESOLVED',
    resolved: false,
    valid: null,
    blockers: [reason],
    source: 'NIKKENREN-JSCA-RC-REBAR-STANDARD-2023-SECTION-6',
    ...extra,
  };
}

function ready(extra = {}) {
  return {
    status: 'READY',
    resolved: true,
    valid: true,
    blockers: [],
    source: 'NIKKENREN-JSCA-RC-REBAR-STANDARD-2023-SECTION-6',
    ...extra,
  };
}

/**
 * explicitに選択された基礎梁typeが、分かっている標準図適用条件と矛盾しないかを検証する。
 * 条件が不足している場合はtypeを推定せずUNRESOLVEDを返す。
 */
export function validateFoundationBeamAnchorageType2023({
  memberTag,
  type,
  uplift = null,
  foundationSystem = null,
  continuous = null,
} = {}) {
  const memberKind = normalizeMemberKind(memberTag);
  if (!memberKind) return invalid('foundation-type-constraint-member-kind-invalid');

  const normalizedType = normalizeType(type);
  if (!normalizedType) return invalid('foundation-type-constraint-type-missing', { memberKind });

  if (memberKind === 'GIRDER') {
    if (!GIRDER_TYPES.has(normalizedType)) {
      return invalid('foundation-type-constraint-type-invalid', {
        memberKind,
        type: normalizedType,
      });
    }

    const checks = [];
    if (foundationSystem !== null && foundationSystem !== undefined) {
      const system = normalizeFoundationSystem(foundationSystem);
      if (!system) {
        return invalid('foundation-type-constraint-foundation-system-invalid', {
          memberKind,
          type: normalizedType,
          foundationSystem,
        });
      }
      const systemAllowed =
        system === 'RAFT_OR_CONTINUOUS' ? new Set(['A1']) : new Set(['B1', 'B2', 'C1', 'C2']);
      checks.push({
        kind: 'FOUNDATION_SYSTEM',
        value: system,
        allowedTypes: [...systemAllowed],
        satisfied: systemAllowed.has(normalizedType),
      });
    }

    if (uplift !== null && uplift !== undefined) {
      if (typeof uplift !== 'boolean') {
        return invalid('foundation-type-constraint-uplift-invalid', {
          memberKind,
          type: normalizedType,
          uplift,
        });
      }
      const upliftAllowed = uplift ? new Set(['A1', 'B2', 'C2']) : new Set(['A1', 'B1', 'C1']);
      checks.push({
        kind: 'UPLIFT',
        value: uplift,
        allowedTypes: [...upliftAllowed],
        satisfied: upliftAllowed.has(normalizedType),
      });
    }

    if (!checks.length) {
      return unresolved('foundation-type-constraint-context-not-specified', {
        memberKind,
        type: normalizedType,
      });
    }
    const failed = checks.filter((check) => !check.satisfied);
    if (failed.length) {
      return invalid('foundation-type-constraint-mismatch', {
        memberKind,
        type: normalizedType,
        checks,
        failedChecks: failed,
      });
    }
    return ready({ memberKind, type: normalizedType, checks });
  }

  if (!SMALL_BEAM_TYPES.has(normalizedType)) {
    return invalid('foundation-type-constraint-type-invalid', {
      memberKind,
      type: normalizedType,
    });
  }
  if (continuous === null || continuous === undefined) {
    return unresolved('foundation-type-constraint-continuity-not-specified', {
      memberKind,
      type: normalizedType,
    });
  }
  if (typeof continuous !== 'boolean') {
    return invalid('foundation-type-constraint-continuity-invalid', {
      memberKind,
      type: normalizedType,
      continuous,
    });
  }

  const allowed = continuous ? new Set(['A1', 'B1']) : new Set(['A2', 'B2']);
  const check = {
    kind: 'CONTINUITY',
    value: continuous,
    allowedTypes: [...allowed],
    satisfied: allowed.has(normalizedType),
  };
  if (!check.satisfied) {
    return invalid('foundation-type-constraint-mismatch', {
      memberKind,
      type: normalizedType,
      checks: [check],
      failedChecks: [check],
    });
  }
  return ready({ memberKind, type: normalizedType, checks: [check] });
}

export const _foundationBeamAnchorageTypeConstraint2023Internals = Object.freeze({
  normalizeMemberKind,
  normalizeType,
  normalizeFoundationSystem,
});
