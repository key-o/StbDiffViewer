/**
 * @fileoverview Issue #273 Phase 4a: 配筋Decision Traceをproduction UI向けに収集する。
 *
 * Resolver / RebarPathの判断は変更せず、current model / Working Documentから既存factsを再利用して
 * read-only traceへ変換する。caller-supplied projectDetailingはephemeralなL0 overrideを含み得るため
 * rebarDisplayと同様にfacts cacheをbypassする。
 */

import { getRebarProjectDetailing } from '../../config/rebarProjectDetailing.js';
import editingSession from '../editing/editingSession.js';
import { getModelContext } from './modelContext.js';
import { resolveRebarFactsGenerationKey } from './rebarDisplay.js';
import { buildColumnRebarLayoutMap } from '../../data/extractors/rebar3d/columnRebarPlacement.js';
import { buildBeamRebarLayoutMaps } from '../../data/extractors/rebar3d/beamRebarPlacement.js';
import { buildColumnJointRenderPlan } from '../../data/extractors/rebar3d/columnJointRenderPlan.js';
import { buildColumnJointHoopRequirementDecisionTraces } from '../../data/extractors/rebar3d/columnJointHoopRequirementDecisionTrace.js';
import {
  applyGirderJointAnchorageSuppression,
  buildGirderJointRenderPlan,
} from '../../data/extractors/rebar3d/girderJointTransitionRenderPlan.js';
import { buildGirderHaunchRenderPlan } from '../../data/extractors/rebar3d/girderHaunchRenderPlan.js';
import { buildBeamAnchorageMaps } from '../../data/extractors/rebar3d/beamAnchoragePlacement.js';
import { buildBeamCutoffMaps } from '../../data/extractors/rebar3d/beamCutoffPlacement.js';
import { buildFoundationBeamAnchorageRenderPlan2023 } from '../../data/extractors/rebar3d/foundationBeamAnchorageRenderPlan2023.js';
import { buildFoundationBeamCountDifferenceSnapshot } from '../../data/extractors/rebar3d/foundationBeamCountDifferenceResolver.js';
import { buildStripFootingRebarRenderPlan } from '../../data/extractors/rebar3d/stripFootingRebarPlacement.js';
import { buildStripFootingContinuityDecisionTraces } from '../../data/extractors/rebar3d/stripFootingContinuityDecisionTrace.js';
import { parseStripFootingMembers } from '../../data/extractors/rebar3d/stripFootingRebarSectionFacts.js';
import { buildWallRebarRenderPlan } from '../../data/extractors/rebar3d/wallRebarPlacement.js';
import { buildWallRebarTopologySnapshot } from '../../data/extractors/rebar3d/wallRebarTopology.js';
import { buildWallWallJunctionResolverInput } from '../../data/extractors/rebar3d/wallRebarWallJunctionAdapter.js';
import { resolveWallWallJunctionContinuity } from '../../data/extractors/rebar3d/wallRebarWallJunctionResolver.js';
import { buildWallWallJunctionBarDecisionTraces } from '../../data/extractors/rebar3d/wallRebarWallJunctionDecisionTrace.js';
import { buildSlabRebarRenderPlan } from '../../data/extractors/rebar3d/slabRebarPlacement.js';
import { buildSmallOpeningRebarDeflectionEvaluations } from '../../data/extractors/rebar3d/smallOpeningRebarSourceFacts.js';
import {
  buildFoundationBeamCountDifferenceDecisionTraces,
  buildRebarDecisionTraceSnapshot,
  buildRebarPlacementActivationTrace,
  buildRebarPlacementProductionTrace,
  buildGirderHaunchDecisionTraces,
  buildSlabThroughDecisionTraces,
  buildSmallOpeningDeflectionDecisionTraces,
} from '../../data/extractors/rebar3d/rebarDecisionTrace.js';
import {
  collectRcColumnBeamPlacementConflictCandidates,
  resolveRebarPlacementConflictActivation,
} from '../../data/extractors/rebar3d/rebarPlacementConflictCandidates.js';
import { buildRebarPlacementConflictProductionPlan } from '../../data/extractors/rebar3d/rebarPlacementConflictProduction.js';
import { getOrBuildRebarFact } from '../../data/extractors/rebar3d/rebarFactsCache.js';
import { withRebarModelIndexScopes } from '../../data/extractors/rebar3d/rebarModelIndex.js';

function effectiveModelDocuments() {
  const { modelADocument, modelBDocument } = getModelContext();
  const editing = editingSession.getState();
  return {
    modelADocument:
      editing?.active && editing.workingDocument ? editing.workingDocument : modelADocument,
    modelBDocument,
  };
}

function resolveProjectDetailing(options = {}) {
  return options.projectDetailing === undefined
    ? getRebarProjectDetailing()
    : options.projectDetailing;
}

function cachedTraceFact(xmlDoc, options, factName, builder) {
  if (options?.projectDetailing !== undefined) return builder();
  return getOrBuildRebarFact(
    xmlDoc,
    resolveRebarFactsGenerationKey(xmlDoc, options),
    factName,
    builder,
  );
}

function normalizeWallMemberId(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function explicitWallPairIdentity(pair) {
  const record = pair && typeof pair === 'object' && !Array.isArray(pair) ? pair : {};
  const sourceMemberId = normalizeWallMemberId(record.sourceMemberId);
  const targetMemberId = normalizeWallMemberId(record.targetMemberId);
  const hasBothMemberIds = Boolean(sourceMemberId && targetMemberId);
  const memberIds = hasBothMemberIds
    ? [sourceMemberId, targetMemberId].sort()
    : [sourceMemberId, targetMemberId];

  return {
    key: JSON.stringify([hasBothMemberIds ? 'PAIR' : 'INCOMPLETE_PAIR', ...memberIds]),
    canonicalPair: {
      sourceMemberId: memberIds[0],
      targetMemberId: memberIds[1],
    },
  };
}

function unresolvedWallPair(pair, modelSource, reason) {
  return {
    status: 'UNRESOLVED',
    reason,
    modelSource,
    sourceMemberId: normalizeWallMemberId(pair?.sourceMemberId),
    targetMemberId: normalizeWallMemberId(pair?.targetMemberId),
    productionReady: false,
  };
}

/**
 * Collects only caller-supplied wall pairs. Pair discovery, adjacency inference,
 * and production RebarPath generation remain outside this read-only trace path.
 */
function collectWallJunctionDecisionTraces(xmlDoc, modelSource, options = {}) {
  const pairs = options.wallWallJunctionPairsByModel?.[modelSource];
  if (!xmlDoc || !Array.isArray(pairs) || pairs.length === 0) return [];

  const pairCounts = new Map();
  for (const pair of pairs) {
    const { key } = explicitWallPairIdentity(pair);
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  }

  const wallPlan = cachedTraceFact(
    xmlDoc,
    options,
    `wall.renderPlan.decisionTrace.${modelSource}`,
    () => buildWallRebarRenderPlan(xmlDoc, { ...options, modelSource }),
  );
  const topology = buildWallRebarTopologySnapshot(wallPlan, { modelSource });
  const traces = [];
  const emittedAmbiguousPairs = new Set();

  for (const pair of pairs) {
    const pairRecord = pair && typeof pair === 'object' && !Array.isArray(pair) ? pair : {};
    const { key: groupKey, canonicalPair } = explicitWallPairIdentity(pairRecord);
    if (pairCounts.get(groupKey) > 1) {
      if (emittedAmbiguousPairs.has(groupKey)) continue;
      emittedAmbiguousPairs.add(groupKey);
      traces.push(
        ...buildWallWallJunctionBarDecisionTraces(
          unresolvedWallPair(
            canonicalPair,
            modelSource,
            'wall-wall-junction-explicit-pair-ambiguous',
          ),
        ),
      );
      continue;
    }

    let resolution;
    try {
      const adapterInput = buildWallWallJunctionResolverInput(xmlDoc, wallPlan, {
        sourceMemberId: pairRecord.sourceMemberId,
        targetMemberId: pairRecord.targetMemberId,
        toleranceMm: pairRecord.toleranceMm,
        modelSource,
        topology,
      });
      const resolverOptions =
        pairRecord.resolverOptions &&
        typeof pairRecord.resolverOptions === 'object' &&
        !Array.isArray(pairRecord.resolverOptions)
          ? pairRecord.resolverOptions
          : {};
      resolution = resolveWallWallJunctionContinuity(adapterInput, resolverOptions);
    } catch {
      resolution = unresolvedWallPair(
        pairRecord,
        modelSource,
        'wall-wall-junction-explicit-pair-evaluation-unresolved',
      );
    }
    traces.push(...buildWallWallJunctionBarDecisionTraces(resolution));
  }

  return traces;
}

function collectModelDecisionTraces(xmlDoc, modelSource, options = {}) {
  if (!xmlDoc) return [];

  const projectDetailing = resolveProjectDetailing(options);
  const columnLayouts = cachedTraceFact(xmlDoc, options, 'column.main.layouts', () =>
    buildColumnRebarLayoutMap(xmlDoc, options),
  );
  const beamLayouts = cachedTraceFact(xmlDoc, options, 'beam.main.layouts', () =>
    buildBeamRebarLayoutMaps(xmlDoc, options),
  );

  const columnPlan =
    columnLayouts.size > 0
      ? cachedTraceFact(
          xmlDoc,
          options,
          `column.jointRenderPlan.decisionTrace.${modelSource}`,
          () =>
            buildColumnJointRenderPlan(xmlDoc, columnLayouts, beamLayouts, {
              projectDetailing,
              modelSource,
            }),
        )
      : null;
  const columnHoopRequirementTraces = buildColumnJointHoopRequirementDecisionTraces(
    columnPlan?.firstHoopRequirements || [],
    { modelSource },
  );

  const girderPlan =
    beamLayouts.girder.size > 0
      ? cachedTraceFact(
          xmlDoc,
          options,
          `girder.jointRenderPlan.decisionTrace.${modelSource}`,
          () =>
            buildGirderJointRenderPlan(xmlDoc, beamLayouts.girder, columnLayouts, {
              projectDetailing,
              modelSource,
            }),
        )
      : null;

  // B-005 trace is independent of placement activation. Build the existing plan once here and
  // pass the same instance to production placement below when that feature is active.
  const haunchPlan = cachedTraceFact(
    xmlDoc,
    options,
    `girder.haunchRenderPlan.decisionTrace.${modelSource}`,
    () =>
      buildGirderHaunchRenderPlan(xmlDoc, beamLayouts.girder, {
        projectDetailing,
        jointTransitionPlan: girderPlan,
      }),
  );
  const girderHaunchTraces = buildGirderHaunchDecisionTraces(haunchPlan, { modelSource });

  const snapshot = buildRebarDecisionTraceSnapshot({
    columnFacts: columnPlan?.facts || null,
    girderFacts: girderPlan || null,
  });

  const slabPlan = cachedTraceFact(xmlDoc, options, 'slab.renderPlan', () =>
    buildSlabRebarRenderPlan(xmlDoc, options),
  );
  const slabThroughTraces = buildSlabThroughDecisionTraces(slabPlan?.paths || [], {
    modelSource,
  });
  const smallOpeningEvaluations = buildSmallOpeningRebarDeflectionEvaluations(xmlDoc, {
    ...options,
    modelSource,
  });
  const smallOpeningTraces = buildSmallOpeningDeflectionDecisionTraces(smallOpeningEvaluations, {
    modelSource,
  });

  const buildFoundationCountDifferenceSnapshot = () =>
    buildFoundationBeamCountDifferenceSnapshot(xmlDoc, beamLayouts, {
      ...options,
      projectDetailing,
      modelSource,
    });
  const foundationCountDifferenceSnapshot =
    beamLayouts.girder.size > 0 || beamLayouts.beam.size > 0
      ? options.positionToleranceMm !== undefined
        ? buildFoundationCountDifferenceSnapshot()
        : cachedTraceFact(
            xmlDoc,
            options,
            `foundationBeam.countDifference.decisionTrace.${modelSource}`,
            buildFoundationCountDifferenceSnapshot,
          )
      : null;
  const foundationCountDifferenceTraces = buildFoundationBeamCountDifferenceDecisionTraces(
    foundationCountDifferenceSnapshot,
    { modelSource },
  );
  const stripFootingMembers = cachedTraceFact(xmlDoc, options, 'stripFooting.members', () =>
    parseStripFootingMembers(xmlDoc),
  );
  const stripFootingContinuityTraces =
    stripFootingMembers.length >= 2
      ? buildStripFootingContinuityDecisionTraces(
          xmlDoc,
          cachedTraceFact(xmlDoc, options, 'stripFooting.renderPlan', () =>
            buildStripFootingRebarRenderPlan(xmlDoc),
          ),
          { modelSource, members: stripFootingMembers },
        )
      : [];
  const wallJunctionTraces = collectWallJunctionDecisionTraces(xmlDoc, modelSource, options);

  const placementActivation = resolveRebarPlacementConflictActivation(projectDetailing);
  const { ruleActivation, overrideActivation } = placementActivation;
  let placementTraces = [];

  const activationBlockers = [];
  if (ruleActivation.active && !ruleActivation.resolved) {
    const trace = buildRebarPlacementActivationTrace(ruleActivation, { modelSource });
    if (trace) activationBlockers.push(trace);
  }
  if (overrideActivation.active && !overrideActivation.resolved) {
    const trace = buildRebarPlacementActivationTrace(overrideActivation, {
      modelSource,
      source: 'PROJECT_DETAILING:REBAR_PLACEMENT_CONFLICT_OVERRIDE',
      subjectType: 'REBAR_PLACEMENT_OVERRIDE',
      decisionPrefix: 'REBAR_PLACEMENT_OVERRIDE',
    });
    if (trace) activationBlockers.push(trace);
  }

  const anyPlacementFeatureActive = placementActivation.active;
  const includePlacementAuthoringCandidates = options.includePlacementAuthoringCandidates === true;
  if (activationBlockers.length) {
    placementTraces = activationBlockers;
  } else if (anyPlacementFeatureActive || includePlacementAuthoringCandidates) {
    const placementCandidates = collectRcColumnBeamPlacementConflictCandidates(xmlDoc, {
      ...options,
      columnLayouts,
      beamLayoutMaps: beamLayouts,
      projectDetailing,
      projectActivation: ruleActivation,
      enabledRuleIds: ruleActivation.resolved ? [...ruleActivation.enabledRuleIds] : [],
      modelSource,
    });

    if (!anyPlacementFeatureActive) {
      placementTraces = (placementCandidates || []).map((candidate) => candidate.trace);
    } else {
      const rawAnchorages = cachedTraceFact(xmlDoc, options, 'beam.anchorages', () =>
        buildBeamAnchorageMaps(
          xmlDoc,
          beamLayouts,
          { ...options, projectDetailing },
          undefined,
          columnLayouts,
        ),
      );
      const anchoragesForPlacementGate =
        girderPlan && rawAnchorages
          ? applyGirderJointAnchorageSuppression(rawAnchorages, girderPlan)
          : rawAnchorages;
      const cutoffs = cachedTraceFact(xmlDoc, options, 'beam.cutoffs', () =>
        buildBeamCutoffMaps(xmlDoc, beamLayouts),
      );
      const foundationBeamAnchorageRenderPlan =
        beamLayouts.girder.size > 0
          ? cachedTraceFact(xmlDoc, options, 'foundationBeam.anchorageRenderPlan2023', () =>
              buildFoundationBeamAnchorageRenderPlan2023(xmlDoc, beamLayouts.girder, {
                ...options,
                projectDetailing,
              }),
            )
          : null;
      const productionPlan = buildRebarPlacementConflictProductionPlan(xmlDoc, {
        ...options,
        columnLayouts,
        beamLayoutMaps: beamLayouts,
        projectDetailing,
        candidates: placementCandidates,
        modelSource,
        jointTransitionPlan: girderPlan,
        haunchTransitionPlan: haunchPlan,
        anchoragePieceMaps: anchoragesForPlacementGate,
        cutoffPieceMaps: cutoffs,
        foundationBeamAnchorageRenderPlan,
      });
      const productionCandidateTraces = (productionPlan.candidates || []).map(
        (candidate) => candidate.trace,
      );
      const productionDecisionIds = new Set(
        productionCandidateTraces.map((trace) => trace?.decisionId).filter(Boolean),
      );
      const previewOnlyTraces = includePlacementAuthoringCandidates
        ? (placementCandidates || [])
            .map((candidate) => candidate.trace)
            .filter((trace) => !trace?.decisionId || !productionDecisionIds.has(trace.decisionId))
        : [];
      placementTraces = [
        ...productionCandidateTraces,
        ...previewOnlyTraces,
        ...[...productionPlan.members.entries()]
          .map(([memberKey, memberPlan]) =>
            buildRebarPlacementProductionTrace(memberKey, memberPlan, {
              modelSource,
              activation: productionPlan.activation,
            }),
          )
          .filter(Boolean),
      ];
    }
  }

  return [
    ...snapshot.all,
    ...girderHaunchTraces,
    ...columnHoopRequirementTraces,
    ...foundationCountDifferenceTraces,
    ...stripFootingContinuityTraces,
    ...wallJunctionTraces,
    ...slabThroughTraces,
    ...smallOpeningTraces,
    ...placementTraces,
  ].map((trace) =>
    Object.freeze({
      ...trace,
      modelSource: trace.modelSource || modelSource,
    }),
  );
}

/**
 * Model A/B（編集中はModel A Working Document）のDecision Traceを返す。
 *
 * `wallWallJunctionPairsByModel` may provide explicit A/B wall pairs as
 * `{ A: [{ sourceMemberId, targetMemberId, resolverOptions }], B: [...] }`.
 * Missing pairs are not inferred from geometry or adjacency.
 *
 * @param {Object} [options]
 * @returns {ReadonlyArray<Object>}
 */
export function collectRebarDecisionTraces(options = {}) {
  const { modelADocument, modelBDocument } = effectiveModelDocuments();
  return withRebarModelIndexScopes([modelADocument, modelBDocument], () =>
    Object.freeze([
      ...collectModelDecisionTraces(modelADocument, 'A', options),
      ...collectModelDecisionTraces(modelBDocument, 'B', options),
    ]),
  );
}
