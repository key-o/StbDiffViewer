/**
 * @fileoverview Issue #292 RC column/beam conflict candidate orchestration.
 *
 * Candidate extraction delegates project/automatic activation, actual facts,
 * and geometry gates to focused modules. Geometry-conditioned adopted rules may
 * activate automatically; experimental/project rules remain explicit opt-in.
 */

import { getRebarProjectDetailing } from '../../../config/rebarProjectDetailing.js';
import { createTagScanner } from '../columnSupportUtils.js';
import { buildBeamRebarLayoutMaps } from './beamRebarPlacement.js';
import { buildColumnRebarLayoutMap } from './columnRebarPlacement.js';
import { collectRebarAppendixA2JointAssemblyChecks } from './rebarAppendixA2JointAssemblyChecks.js';
import { RebarPlacementCandidateEffect } from './rebarPlacementGeometryGate.js';
import {
  DEFAULT_REBAR_PLACEMENT_RULE_SET,
  resolveRebarPairConflict,
} from './rebarPlacementRuleSet.js';
import { buildRebarConflictDecisionTrace } from './rebarDecisionTrace.js';
import {
  resolveRebarPlacementConflictActivation,
  resolveRebarPlacementConflictOverride,
  resolveRebarPlacementConflictOverrideActivation,
  resolveRebarPlacementConflictRuleActivation,
} from './rebarPlacementConflictActivation.js';
import {
  beamFactsAtNode,
  columnFactsAtNode,
  finite,
  isRc,
  measureColumnBeamPlanConflict,
  pairSortKey,
  scopedGeometryContext,
} from './rebarPlacementConflictFacts.js';

const EPS = 1e-6;
const DEFAULT_COLLISION_TOLERANCE_MM = 0.5;
const COLUMN_CORNER_RULE = 'ISSUE292-COLUMN-CORNER-VS-GIRDER-INTERMEDIATE';
const A2_SIDE_CORNER_RULE = 'ISSUE292-A2-SIDE-COLUMN-CORNER-VS-BEAM-CORNER';

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim().toUpperCase();
}

function stableId(parts) {
  return parts.map((value) => String(value ?? '')).join(':');
}

function authoringBarFact(bar) {
  const localU = finite(bar?.localPosition?.u);
  const localV = finite(bar?.localPosition?.v);
  const layer = finite(bar?.layer);
  return Object.freeze({
    semanticIdentity: bar?.semanticIdentity ? String(bar.semanticIdentity) : null,
    memberType: text(bar?.memberType) || null,
    sourceMemberId: bar?.sourceMemberId ? String(bar.sourceMemberId) : null,
    sourceEndpoint: bar?.sourceEndpoint ? String(bar.sourceEndpoint) : null,
    role: bar?.role ? String(bar.role) : null,
    layer: layer !== null && Number.isInteger(layer) && layer >= 0 ? layer : null,
    diaName: bar?.diaName || bar?.dia || null,
    grade: bar?.grade || null,
    topologyRole: bar?.topologyRole || null,
    topologyPosition: bar?.topologyPosition || null,
    localPosition:
      localU !== null && localV !== null ? Object.freeze({ u: localU, v: localV }) : null,
  });
}

function placementConflictAuthoringContext(pair, explicitOverride, modelSource, nodeId) {
  const column = authoringBarFact(pair.column);
  const beam = authoringBarFact(pair.beam);
  return Object.freeze({
    kind: 'REBAR_PLACEMENT_CONFLICT_PAIR',
    modelSource: modelSource ? String(modelSource) : null,
    nodeId: String(nodeId ?? ''),
    column,
    beam,
    scope: Object.freeze({
      modelSource: modelSource ? String(modelSource) : null,
      nodeId: String(nodeId ?? ''),
      columnRef: column.semanticIdentity,
      beamRef: beam.semanticIdentity,
    }),
    override: Object.freeze({
      active: explicitOverride?.active === true,
      resolved: explicitOverride?.resolved !== false,
      status: explicitOverride?.status || 'NOT_CONFIGURED',
      action: explicitOverride?.action || null,
      reason: explicitOverride?.reason || null,
    }),
  });
}

function activationProvenanceSources(projectActivation, pairEnabledRuleIds) {
  if (!projectActivation?.active) return [];
  const autoRuleIds = new Set(projectActivation.autoRuleIds || []);
  const sources = [];
  if (pairEnabledRuleIds.some((ruleId) => autoRuleIds.has(ruleId))) {
    sources.push('RULE_REGISTRY:GEOMETRY_CONDITIONED_REBAR_PLACEMENT');
  }
  const projectRuleIds = (projectActivation.enabledRuleIds || []).filter(
    (ruleId) => !autoRuleIds.has(ruleId),
  );
  if (
    projectActivation.source === 'project-detailing' &&
    pairEnabledRuleIds.some((ruleId) => projectRuleIds.includes(ruleId))
  ) {
    sources.push('PROJECT_DETAILING:REBAR_PLACEMENT_CONFLICT_RULES');
  }
  return sources;
}

function movementFromEffects(effects, beam) {
  const inset = effects.find(
    (effect) => effect.type === RebarPlacementCandidateEffect.SIDE_OUTER_BAR_INSET,
  );
  const transverse = beam?.transverseDirection;
  if (!inset || !transverse || !Number.isFinite(inset.distanceMm)) return null;
  const side = text(inset.side);
  const sign = side === 'POSITIVE' ? -1 : side === 'NEGATIVE' ? 1 : 0;
  if (sign === 0) return null;
  const canonicalZero = (value) => (value === 0 ? 0 : value);
  return Object.freeze({
    kind: 'TRANSLATE_PLAN',
    vector: Object.freeze({
      x: canonicalZero(transverse.x * sign),
      y: canonicalZero(transverse.y * sign),
      z: 0,
    }),
    distanceMm: inset.distanceMm,
    effectType: inset.type,
    source: 'APPENDIX_A2_GEOMETRY_FEASIBILITY',
  });
}

export function buildRebarPlacementConflictCandidatesFromFacts({
  nodeId,
  columnBars = [],
  beamBars = [],
  jointCheck = null,
  enabledRuleIds = [],
  ruleSet = DEFAULT_REBAR_PLACEMENT_RULE_SET,
  collisionToleranceMm = DEFAULT_COLLISION_TOLERANCE_MM,
  projectActivation = null,
  projectDetailing = {},
  modelSource = null,
} = {}) {
  const pairs = [];
  for (const beam of beamBars) {
    const collisions = [];
    for (const column of columnBars) {
      const geometry = measureColumnBeamPlanConflict(column, beam, {
        collisionToleranceMm,
      });
      if (!geometry.collision) continue;
      collisions.push({ nodeId, column, beam, geometry });
    }
    if (!collisions.length) continue;

    // Beam endpoint facts are anchored at the joint. Multiple column bars can
    // share the same transverse line, but the member enters the column from the
    // joint-outward side. Keep only the front-most colliding bar(s) along that
    // outward axis so far-face/edge bars are not treated as the same physical
    // endpoint clash. Exact axial ties remain explicit rather than array-ordered.
    const frontAxialMm = Math.max(...collisions.map((item) => item.geometry.axialDistanceMm));
    pairs.push(
      ...collisions.filter((item) => Math.abs(item.geometry.axialDistanceMm - frontAxialMm) <= EPS),
    );
  }
  pairs.sort((a, b) => pairSortKey(a).localeCompare(pairSortKey(b), undefined, { numeric: true }));

  return Object.freeze(
    pairs.map((pair) => {
      const geometryContext = scopedGeometryContext(jointCheck, pair);
      const movement = movementFromEffects(geometryContext.candidateEffects, pair.beam);
      const pairEnabledRuleIds = enabledRuleIds.filter(
        (ruleId) =>
          ruleId !== A2_SIDE_CORNER_RULE ||
          geometryContext.candidateEffects.some(
            (effect) => effect.type === RebarPlacementCandidateEffect.SIDE_OUTER_BAR_INSET,
          ),
      );
      const explicitOverride = resolveRebarPlacementConflictOverride(projectDetailing, {
        modelSource,
        nodeId,
        column: pair.column,
        beam: pair.beam,
      });
      const sourceViolations = pair.column.conflictSourceAmbiguity
        ? [
            Object.freeze({
              code: pair.column.conflictSourceAmbiguity,
              requirementType: 'SOURCE_TOPOLOGY_RESOLUTION',
              sourceRuleIds: Object.freeze(['REBAR-FAIL-CLOSED-UNRESOLVED']),
            }),
          ]
        : [];
      const overrideViolations =
        explicitOverride.active && !explicitOverride.resolved
          ? [
              Object.freeze({
                code: explicitOverride.reason,
                requirementType: 'EXPLICIT_OVERRIDE_RESOLUTION',
                sourceRuleIds: Object.freeze(['REBAR-PLACEMENT-EXPLICIT-MOBILITY-OVERRIDE']),
              }),
            ]
          : [];
      const keepColumn =
        explicitOverride.resolved && explicitOverride.action === 'KEEP_COLUMN_MOVE_BEAM';
      const keepBeam =
        explicitOverride.resolved && explicitOverride.action === 'KEEP_BEAM_MOVE_COLUMN';
      const context = {
        enabledRuleIds: pairEnabledRuleIds,
        hardConstraintViolations: [
          ...geometryContext.hardConstraintViolations,
          ...sourceViolations,
          ...overrideViolations,
        ],
        movement,
        a: {
          matchBasis: pair.column.continuity === 'STRAIGHT' ? 'world-straight-first' : null,
          ...(keepColumn ? { override: { action: 'KEEP' } } : {}),
        },
        b: {
          matchBasis: pair.beam.continuity === 'STRAIGHT' ? 'world-straight-first' : null,
          ...(keepBeam ? { override: { action: 'KEEP' } } : {}),
        },
      };
      const decision = resolveRebarPairConflict(pair.column, pair.beam, context, ruleSet);
      const trace = buildRebarConflictDecisionTrace(decision, {
        decisionId: stableId([
          'RC_JOINT_CONFLICT',
          nodeId,
          pair.column.semanticIdentity,
          pair.beam.semanticIdentity,
        ]),
        subjectKey: stableId([nodeId, pair.column.semanticIdentity, pair.beam.semanticIdentity]),
        sources: [
          ...(pair.column.sourceMemberIds || [pair.column.sourceMemberId])
            .filter(Boolean)
            .map((id) => `StbColumn:${id}`),
          `${pair.beam.memberType === 'BEAM' ? 'StbBeam' : 'StbGirder'}:${pair.beam.sourceMemberId}`,
          ...activationProvenanceSources(projectActivation, pairEnabledRuleIds),
          ...(explicitOverride?.active
            ? ['PROJECT_DETAILING:REBAR_PLACEMENT_CONFLICT_OVERRIDE']
            : []),
        ],
        modelSource,
        authoring: placementConflictAuthoringContext(pair, explicitOverride, modelSource, nodeId),
      });
      return Object.freeze({
        nodeId: String(nodeId),
        key: pairSortKey(pair),
        column: pair.column,
        beam: pair.beam,
        geometry: pair.geometry,
        geometryRequirements: geometryContext.geometryRequirements,
        candidateEffects: geometryContext.candidateEffects,
        movement,
        projectOptIn:
          pairEnabledRuleIds.includes(COLUMN_CORNER_RULE) ||
          pairEnabledRuleIds.includes(A2_SIDE_CORNER_RULE) ||
          pairEnabledRuleIds.includes('ISSUE292-MAIN-VS-TRANSVERSE-FOLLOW'),
        enabledRuleIds: Object.freeze(pairEnabledRuleIds.slice()),
        projectActivation,
        explicitOverride,
        decision,
        trace,
      });
    }),
  );
}

export function collectRcColumnBeamPlacementConflictCandidates(xmlDoc, options = {}) {
  if (!xmlDoc) return Object.freeze([]);
  const scanTag = options.scanTag || createTagScanner(xmlDoc);
  const projectDetailing =
    options.projectDetailing === undefined ? getRebarProjectDetailing() : options.projectDetailing;
  const projectActivation =
    options.projectActivation ||
    (Array.isArray(options.enabledRuleIds)
      ? Object.freeze({
          active: options.enabledRuleIds.length > 0,
          resolved: true,
          status: 'CALLER_RULE_ALLOWLIST',
          reason: null,
          source: 'caller',
          enabledRuleIds: Object.freeze(options.enabledRuleIds.map(String)),
          autoRuleIds: Object.freeze([]),
        })
      : resolveRebarPlacementConflictRuleActivation(projectDetailing));
  const overrideActivation = resolveRebarPlacementConflictOverrideActivation(projectDetailing);
  const enabledRuleIds = projectActivation.resolved ? [...projectActivation.enabledRuleIds] : [];
  const columnLayouts = options.columnLayouts || buildColumnRebarLayoutMap(xmlDoc);
  const beamLayoutMaps = options.beamLayoutMaps || buildBeamRebarLayoutMaps(xmlDoc);
  const jointChecks =
    options.jointChecks ||
    collectRebarAppendixA2JointAssemblyChecks(xmlDoc, {
      choice: options.choice,
      beamLayoutMaps,
      columnLayoutMap: columnLayouts,
      projectDetailing,
    });
  const checksByNode = new Map((jointChecks || []).map((check) => [String(check.nodeId), check]));

  const nodeIds = new Set();
  for (const column of scanTag('StbColumn')) {
    if (!isRc(column)) continue;
    const bottom = column.getAttribute('id_node_bottom');
    const top = column.getAttribute('id_node_top');
    if (bottom) nodeIds.add(String(bottom));
    if (top) nodeIds.add(String(top));
  }

  const result = [];
  for (const nodeId of [...nodeIds].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  )) {
    const columnBars = columnFactsAtNode(scanTag, nodeId, columnLayouts);
    if (!columnBars.length) continue;
    const beamBars = beamFactsAtNode(scanTag, nodeId, beamLayoutMaps);
    if (!beamBars.length) continue;
    result.push(
      ...buildRebarPlacementConflictCandidatesFromFacts({
        nodeId,
        columnBars,
        beamBars,
        jointCheck: checksByNode.get(String(nodeId)) || null,
        enabledRuleIds,
        ruleSet: options.ruleSet || DEFAULT_REBAR_PLACEMENT_RULE_SET,
        collisionToleranceMm:
          finite(options.collisionToleranceMm) ?? DEFAULT_COLLISION_TOLERANCE_MM,
        projectActivation,
        projectDetailing,
        modelSource: options.modelSource || null,
      }),
    );
  }

  const sorted = result.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  Object.defineProperties(sorted, {
    projectActivation: {
      value: projectActivation,
      enumerable: false,
    },
    overrideActivation: {
      value: overrideActivation,
      enumerable: false,
    },
  });
  return Object.freeze(sorted);
}

export {
  resolveRebarPlacementConflictActivation,
  resolveRebarPlacementConflictOverride,
  resolveRebarPlacementConflictOverrideActivation,
  resolveRebarPlacementConflictRuleActivation,
  measureColumnBeamPlanConflict,
};
