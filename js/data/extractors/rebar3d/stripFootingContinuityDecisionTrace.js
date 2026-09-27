/**
 * @fileoverview Issue #273 F-003: R13 strip-footing node junction candidate traces.
 *
 * Exact STB node references and existing R13 placement facts are observable here, but current
 * source data does not identify side/corner column roles or persistent individual bars across
 * members. The trace therefore records junction evidence and stays UNRESOLVED.
 */

import { querySelectorAll } from '../sectionListUtils.js';
import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';
import { parseStripFootingMembers } from './stripFootingRebarSectionFacts.js';

const F003_RULE_ID = 'FOUNDATION-STRIP-FOOTING-CONTINUITY-CANDIDATE';
const FAIL_CLOSED_RULE_ID = 'REBAR-FAIL-CLOSED-UNRESOLVED';
const UNRESOLVED_REASON = 'foundation-strip-footing-continuity-semantics-incomplete';

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function attr(element, name) {
  return text(element?.getAttribute?.(name));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addMemberEndpoint(groups, nodeId, member, endpoint) {
  nodeId = text(nodeId);
  if (!nodeId) return;
  let group = groups.get(nodeId);
  if (!group) {
    group = new Map();
    groups.set(nodeId, group);
  }
  let entry = group.get(member);
  if (!entry) {
    entry = { member, endpoints: new Set() };
    group.set(member, entry);
  }
  entry.endpoints.add(endpoint);
}

function addByMemberId(groups, memberId, value) {
  const key = text(memberId);
  if (!key) return;
  const group = groups.get(key) || [];
  group.push(value);
  groups.set(key, group);
}

function pathPositionCounts(paths) {
  const counts = new Map();
  for (const path of paths) {
    const position = text(path?.metadata?.position);
    if (!position) continue;
    counts.set(position, (counts.get(position) || 0) + 1);
  }
  return Object.freeze(
    [...counts.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([position, count]) => Object.freeze({ position, count })),
  );
}

function freezeMemberEvidence(entry, memberIdMultiplicity, checksByMemberId, pathsByMemberId) {
  const member = entry.member;
  const memberId = text(member.id) || null;
  const endpoints = Object.freeze([...entry.endpoints].sort(compareText));
  const uniqueMemberId = memberId && memberIdMultiplicity.get(memberId) === 1;
  const checks = uniqueMemberId ? checksByMemberId.get(memberId) || [] : [];
  const check = checks.length === 1 ? checks[0] : null;
  const paths = check ? pathsByMemberId.get(memberId) || [] : [];

  let placementStatus = check?.status || 'UNRESOLVED';
  let placementCode = check?.code || null;
  if (!memberId) placementCode = 'STRIP_FOOTING_MEMBER_ID_MISSING';
  else if (!uniqueMemberId || checks.length > 1) {
    placementStatus = 'UNRESOLVED';
    placementCode = 'STRIP_FOOTING_MEMBER_ID_AMBIGUOUS';
  } else if (!check) {
    placementCode = 'STRIP_FOOTING_PLACEMENT_CHECK_MISSING';
  }

  const positions = pathPositionCounts(paths);
  return Object.freeze({
    memberId,
    sectionId: text(member.sectionId) || null,
    endpoints,
    r13Placement: Object.freeze({
      status: placementStatus,
      code: placementCode,
      pathCount: positions.reduce((sum, item) => sum + item.count, 0),
      positions,
    }),
  });
}

function freezeColumnEvidence(column) {
  return Object.freeze({
    columnId: column.columnId || null,
    columnName: column.columnName || null,
    bottomNodeId: column.bottomNodeId,
  });
}

function createUnresolvedTrace(nodeId, modelSource, footingMembers, columns, nodeDeclared) {
  const candidateRule = rebarRuleTraceMetadata(F003_RULE_ID);
  const failClosedRule = rebarRuleTraceMetadata(FAIL_CLOSED_RULE_ID);
  const members = Object.freeze(footingMembers);
  const columnFacts = Object.freeze(columns.map(freezeColumnEvidence));
  const readyMemberCount = members.filter(
    (member) => member.r13Placement.status === 'READY',
  ).length;
  const specialRequiredMemberCount = members.filter(
    (member) => member.r13Placement.status === 'SPECIAL_REQUIRED',
  ).length;
  const r13PathCount = members.reduce((sum, member) => sum + member.r13Placement.pathCount, 0);
  const blockers = Object.freeze([
    ...(!nodeDeclared ? ['foundation-strip-footing-junction-node-not-declared'] : []),
    'foundation-strip-footing-column-role-unresolved',
    'foundation-strip-footing-bar-direction-role-unresolved',
    'foundation-strip-footing-cross-member-bar-identity-unavailable',
  ]);

  return Object.freeze({
    decisionId: `FOUNDATION_STRIP_FOOTING:${modelSource || '-'}:${nodeId}:CONTINUITY`,
    subjectType: 'FOUNDATION_STRIP_FOOTING_JUNCTION',
    subjectKey: nodeId,
    ...(modelSource ? { modelSource } : {}),
    status: 'UNRESOLVED',
    disposition: 'JUNCTION_CANDIDATE',
    sourceRef: `STB_NODE:${nodeId}`,
    targetRef: null,
    appliedRules: Object.freeze([failClosedRule]),
    candidateRules: Object.freeze([candidateRule]),
    rejectedAlternatives: Object.freeze([]),
    metrics: Object.freeze({
      footingMemberCount: members.length,
      columnCount: columnFacts.length,
      r13ReadyMemberCount: readyMemberCount,
      r13SpecialRequiredMemberCount: specialRequiredMemberCount,
      r13PathCount,
    }),
    unresolvedReason: UNRESOLVED_REASON,
    unresolvedPrerequisites: blockers,
    candidateFacts: Object.freeze({
      nodeId,
      nodeDeclared,
      footingMembers: members,
      columns: columnFacts,
    }),
    provenance: Object.freeze({
      kind: 'SDV_GENERATED',
      sources: Object.freeze([
        'STB:StbStripFooting.id_node_start/id_node_end',
        'STB:StbColumn.id_node_bottom',
        'R13:stripFooting.renderPlan',
        `RULE_REGISTRY:${F003_RULE_ID}`,
      ]),
      rules: Object.freeze([FAIL_CLOSED_RULE_ID]),
      assumptions: Object.freeze([]),
    }),
    confidence: 'RULE_BASED',
    warnings: blockers,
  });
}

/**
 * Emit read-only candidate traces where a declared column bottom and at least two
 * strip-footing members refer to the same exact STB node ID.
 *
 * @param {Document} xmlDoc
 * @param {{checks?:Array<Object>,paths?:Array<Object>}} placementPlan Existing R13 plan.
 * @param {{modelSource?:'A'|'B'|string|null,members?:Array<Object>}} [options]
 * @returns {ReadonlyArray<Object>}
 */
export function buildStripFootingContinuityDecisionTraces(
  xmlDoc,
  placementPlan,
  { modelSource = null, members: memberFacts = null } = {},
) {
  if (!xmlDoc) return Object.freeze([]);

  const memberGroups = new Map();
  const members = Array.isArray(memberFacts) ? memberFacts : parseStripFootingMembers(xmlDoc);
  const memberIdMultiplicity = new Map();
  for (const member of members) {
    const memberId = text(member.id);
    if (memberId) memberIdMultiplicity.set(memberId, (memberIdMultiplicity.get(memberId) || 0) + 1);
    addMemberEndpoint(memberGroups, member.startNodeId, member, 'start');
    addMemberEndpoint(memberGroups, member.endNodeId, member, 'end');
  }

  const columnsByBottomNode = new Map();
  for (const element of querySelectorAll(xmlDoc, 'StbColumn')) {
    const bottomNodeId = attr(element, 'id_node_bottom');
    if (!bottomNodeId) continue;
    addByMemberId(columnsByBottomNode, bottomNodeId, {
      columnId: attr(element, 'id') || null,
      columnName: attr(element, 'name') || null,
      bottomNodeId,
    });
  }

  const declaredNodeIds = new Set(
    querySelectorAll(xmlDoc, 'StbNode')
      .map((element) => attr(element, 'id'))
      .filter(Boolean),
  );
  const checksByMemberId = new Map();
  for (const check of placementPlan?.checks || []) {
    addByMemberId(checksByMemberId, check?.memberId, check);
  }
  const pathsByMemberId = new Map();
  for (const path of placementPlan?.paths || []) {
    addByMemberId(pathsByMemberId, path?.metadata?.memberId, path);
  }

  const traces = [];
  for (const [nodeId, group] of memberGroups) {
    const incident = [...group.values()];
    const columns = columnsByBottomNode.get(nodeId) || [];
    if (incident.length < 2 || columns.length === 0) continue;

    const footingMembers = incident
      .map((entry) =>
        freezeMemberEvidence(entry, memberIdMultiplicity, checksByMemberId, pathsByMemberId),
      )
      .sort((left, right) =>
        compareText(
          `${left.memberId || ''}:${left.sectionId || ''}:${left.endpoints.join(',')}`,
          `${right.memberId || ''}:${right.sectionId || ''}:${right.endpoints.join(',')}`,
        ),
      );
    const sortedColumns = columns
      .map((column) => ({
        ...column,
        sortKey: `${column.columnId || ''}:${column.columnName || ''}`,
      }))
      .sort((left, right) => compareText(left.sortKey, right.sortKey));
    traces.push(
      createUnresolvedTrace(
        nodeId,
        modelSource,
        footingMembers,
        sortedColumns,
        declaredNodeIds.has(nodeId),
      ),
    );
  }

  traces.sort((left, right) => compareText(left.subjectKey, right.subjectKey));
  return Object.freeze(traces);
}
