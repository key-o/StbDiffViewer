/**
 * @fileoverview Issue #320 / #273 Phase 6b-F2:
 * foundation-beam count-difference resolver の decision を、既存 R13 定着render planへ適用する。
 *
 * 新しい定着形状は生成しない。R13 で既に解決済みの anchor-local path のうち、
 * F-001 で ANCHORAGE_REQUIRED と判定された individual bar だけを保持し、
 * THROUGH_CANDIDATE は材端定着から除外する。
 *
 * count-difference 側の分類が不完全、R13 identity が欠落/重複、または
 * StbBeam 側に新規定着が必要な場合は fail-closed とし、関連 StbGirder member を
 * production plan から atomic rollback する。
 */

const SOURCE = 'PHASE-6B-F2-FOUNDATION-BEAM-COUNT-DIFFERENCE-PRODUCTION-GATE';
const RULE_ID = 'FOUNDATION-BEAM-COUNT-DIFFERENCE-ANCHORAGE';

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

function endpointKey(context) {
  const memberId = text(context?.memberId);
  if (!memberId || !['start', 'end'].includes(context?.side)) return null;
  return `${text(context.memberTag)}:${memberId}:${context.side}`;
}

function memberKey(context) {
  return context?.memberId === null || context?.memberId === undefined
    ? null
    : String(context.memberId);
}

function barRef(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function ensureClassification(map, context) {
  const key = endpointKey(context);
  if (!key) return null;
  let entry = map.get(key);
  if (!entry) {
    entry = {
      key,
      memberId: memberKey(context),
      memberTag: context.memberTag || null,
      side: context.side,
      through: new Set(),
      anchorage: new Set(),
      nodeIds: new Set(),
    };
    map.set(key, entry);
  }
  return entry;
}

function addRef(set, value) {
  const ref = barRef(value);
  if (!ref) return false;
  set.add(ref);
  return true;
}

function addUnresolved(unresolved, reason, extra = {}) {
  unresolved.push(
    Object.freeze({
      reason,
      source: SOURCE,
      ruleId: RULE_ID,
      atomicMemberRollback: true,
      ...extra,
    }),
  );
}

function parseMemberRef(ref) {
  const parts = String(ref || '').split(':');
  if (parts.length < 3) return null;
  const side = parts.at(-1);
  const memberId = parts.at(-2);
  const memberTag = parts.slice(0, -2).join(':');
  if (!memberId || !['start', 'end'].includes(side)) return null;
  return { memberTag, memberId, side };
}

function collectClassifications(snapshot) {
  const classifications = new Map();
  const unresolved = [];
  const rollbackMembers = new Set();
  const unsupportedMembers = new Set();

  for (const item of snapshot?.unresolved || []) {
    const refs = (item?.memberRefs || []).map(parseMemberRef).filter(Boolean);
    // single-endのcolumn mediation unresolvedだけでは本数差jointの存在を証明できない。
    // F-001 production gateは、複数member endが同一jointで競合した未解決だけを対象にする。
    if (refs.length < 2) continue;
    for (const context of refs) {
      if (context.memberTag === 'StbGirder') rollbackMembers.add(String(context.memberId));
    }
    addUnresolved(unresolved, item?.reason || 'foundation-beam-count-difference-unresolved', {
      nodeId: item?.nodeId == null ? null : String(item.nodeId),
      memberRefs: Object.freeze([...(item?.memberRefs || [])].map(String)),
      stage: 'COUNT_DIFFERENCE_SNAPSHOT',
    });
  }

  for (const joint of snapshot?.joints || []) {
    const left = ensureClassification(classifications, joint?.left);
    const right = ensureClassification(classifications, joint?.right);
    const contexts = [joint?.left, joint?.right].filter(Boolean);
    const nodeId = joint?.nodeId == null ? null : String(joint.nodeId);
    const jointUnresolved = joint?.status !== 'READY' || (joint?.unresolved || []).length > 0;

    for (const classification of [left, right]) {
      if (classification && nodeId) classification.nodeIds.add(nodeId);
    }

    if (!left || !right) {
      for (const context of contexts) {
        if (context?.memberTag === 'StbGirder') rollbackMembers.add(String(context.memberId));
      }
      addUnresolved(unresolved, 'foundation-beam-count-difference-endpoint-context-unresolved', {
        nodeId,
        stage: 'CLASSIFICATION',
      });
      continue;
    }

    if (jointUnresolved) {
      for (const context of contexts) {
        if (context?.memberTag === 'StbGirder') rollbackMembers.add(String(context.memberId));
      }
      addUnresolved(unresolved, 'foundation-beam-count-difference-joint-not-ready-for-production', {
        nodeId,
        memberRefs: Object.freeze(contexts.map(endpointKey).filter(Boolean)),
        stage: 'CLASSIFICATION',
      });
      continue;
    }

    let classificationInvalid = false;
    for (const match of joint?.matches || []) {
      classificationInvalid = !addRef(left.through, match?.leftBarRef) || classificationInvalid;
      classificationInvalid = !addRef(right.through, match?.rightBarRef) || classificationInvalid;
    }
    for (const assignment of joint?.anchorageRequired || []) {
      const target =
        assignment?.side === 'LEFT' ? left : assignment?.side === 'RIGHT' ? right : null;
      if (!target || !addRef(target.anchorage, assignment?.barRef)) classificationInvalid = true;
      if (target?.memberTag && target.memberTag !== 'StbGirder') {
        unsupportedMembers.add(`${target.memberTag}:${target.memberId}`);
      }
    }

    for (const classification of [left, right]) {
      for (const ref of classification.through) {
        if (classification.anchorage.has(ref)) classificationInvalid = true;
      }
    }

    if (classificationInvalid) {
      for (const context of contexts) {
        if (context?.memberTag === 'StbGirder') rollbackMembers.add(String(context.memberId));
      }
      addUnresolved(unresolved, 'foundation-beam-count-difference-classification-invalid', {
        nodeId,
        memberRefs: Object.freeze(contexts.map(endpointKey).filter(Boolean)),
        stage: 'CLASSIFICATION',
      });
    }
  }

  if (unsupportedMembers.size > 0) {
    for (const joint of snapshot?.joints || []) {
      const contexts = [joint?.left, joint?.right].filter(Boolean);
      if (
        contexts.some((context) =>
          unsupportedMembers.has(`${context.memberTag}:${String(context.memberId)}`),
        )
      ) {
        for (const context of contexts) {
          if (context?.memberTag === 'StbGirder') rollbackMembers.add(String(context.memberId));
        }
      }
    }
    for (const memberRef of [...unsupportedMembers].sort()) {
      addUnresolved(
        unresolved,
        'foundation-beam-count-difference-small-beam-anchorage-production-not-supported',
        { memberRef, stage: 'PRODUCTION_SCOPE' },
      );
    }
  }

  return { classifications, unresolved, rollbackMembers };
}

function classifiedRefs(classification) {
  return new Set([...classification.through, ...classification.anchorage]);
}

function endpointEntries(memberPlan, side) {
  return (memberPlan?.entries || []).filter((entry) => entry?.side === side);
}

function classifyMemberEndpoint(memberPlan, classification) {
  const entries = endpointEntries(memberPlan, classification.side);
  const expected = classifiedRefs(classification);
  if (entries.length !== expected.size || expected.size === 0) {
    return { ok: false, reason: 'foundation-beam-count-difference-r13-entry-coverage-mismatch' };
  }

  const seen = new Set();
  const retained = [];
  let suppressedThrough = 0;
  for (const entry of entries) {
    const identityKey = barRef(entry?.identityKey);
    if (!identityKey || seen.has(identityKey) || !expected.has(identityKey)) {
      return { ok: false, reason: 'foundation-beam-count-difference-r13-entry-identity-mismatch' };
    }
    seen.add(identityKey);
    const isThrough = classification.through.has(identityKey);
    const isAnchorage = classification.anchorage.has(identityKey);
    if (isThrough === isAnchorage) {
      return {
        ok: false,
        reason: 'foundation-beam-count-difference-r13-entry-classification-ambiguous',
      };
    }
    if (isThrough) {
      suppressedThrough += 1;
      continue;
    }
    retained.push(
      Object.freeze({
        ...entry,
        countDifferenceDisposition: 'ANCHORAGE_REQUIRED',
        countDifferenceRuleId: RULE_ID,
        countDifferenceSource: SOURCE,
        countDifferenceNodeIds: Object.freeze([...classification.nodeIds].sort()),
      }),
    );
  }

  return { ok: true, retained, suppressedThrough };
}

function cloneMemberPlan(memberPlan, entries) {
  return {
    ...memberPlan,
    entries,
    countDifferenceGateApplied: true,
    countDifferenceRuleId: RULE_ID,
    countDifferenceSource: SOURCE,
  };
}

/**
 * 既存R13 planへcount-difference decisionを適用する。
 *
 * - THROUGH_CANDIDATE: 当該端部のR13定着pathを抑止
 * - ANCHORAGE_REQUIRED: 既存R13 geometryを再利用
 * - unresolved / identity不一致 / unsupported StbBeam anchorage: 関連StbGirderをatomic rollback
 */
export function applyFoundationBeamCountDifferenceAnchorageProductionGate(renderPlan, snapshot) {
  if (!(renderPlan?.members instanceof Map)) return renderPlan;
  if (!(snapshot?.joints?.length || snapshot?.unresolved?.length)) return renderPlan;

  const analysis = collectClassifications(snapshot);
  const members = new Map(renderPlan.members);
  const unresolved = [...(renderPlan.unresolved || []), ...analysis.unresolved];
  const classificationsByMember = new Map();

  for (const classification of analysis.classifications.values()) {
    if (classification.memberTag !== 'StbGirder') continue;
    const memberId = String(classification.memberId);
    const list = classificationsByMember.get(memberId) || [];
    list.push(classification);
    classificationsByMember.set(memberId, list);
  }

  for (const memberId of analysis.rollbackMembers) members.delete(memberId);

  for (const [memberId, classifications] of classificationsByMember) {
    if (analysis.rollbackMembers.has(memberId)) continue;
    const memberPlan = members.get(memberId);
    if (!memberPlan) {
      analysis.rollbackMembers.add(memberId);
      addUnresolved(unresolved, 'foundation-beam-count-difference-r13-member-plan-missing', {
        memberId,
        stage: 'R13_PLAN_GATE',
      });
      continue;
    }

    let entries = [...(memberPlan.entries || [])];
    let failedReason = null;
    let suppressedThrough = 0;
    for (const classification of classifications.sort((a, b) => a.side.localeCompare(b.side))) {
      const result = classifyMemberEndpoint({ ...memberPlan, entries }, classification);
      if (!result.ok) {
        failedReason = result.reason;
        break;
      }
      entries = [
        ...entries.filter((entry) => entry?.side !== classification.side),
        ...result.retained,
      ];
      suppressedThrough += result.suppressedThrough;
    }

    if (failedReason) {
      members.delete(memberId);
      analysis.rollbackMembers.add(memberId);
      addUnresolved(unresolved, failedReason, { memberId, stage: 'R13_PLAN_GATE' });
      continue;
    }

    if (entries.length === 0) {
      members.delete(memberId);
      continue;
    }
    members.set(
      memberId,
      Object.freeze({
        ...cloneMemberPlan(memberPlan, Object.freeze(entries)),
        countDifferenceSuppressedThroughCount: suppressedThrough,
      }),
    );
  }

  return {
    ...renderPlan,
    resolved: renderPlan.resolved === true && unresolved.length === 0,
    source: renderPlan.source,
    members,
    unresolved,
    countDifferenceProductionGate: Object.freeze({
      applied: true,
      source: SOURCE,
      ruleId: RULE_ID,
      rollbackMembers: Object.freeze([...analysis.rollbackMembers].sort()),
    }),
  };
}

export const _foundationBeamCountDifferenceAnchorageProductionInternals = Object.freeze({
  endpointKey,
  parseMemberRef,
  collectClassifications,
  classifyMemberEndpoint,
});
