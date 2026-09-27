/**
 * @fileoverview R13 基礎梁端の主筋bar-level factsをsupport geometryへ接続する。
 *
 * foundationBeamTopologyFacts で一意化された基礎梁端を入力とし、既存 beamRebarPlacement の
 * 端部主筋facts（u/v/D/grade/layer）と foundation-column FD support geometry を同じfactへ束ねる。
 * 標準図type、普通/軽量区分、浮上り条件は project detailing の common < section < member < member-end
 * 階層で解決し、定着先コンクリート強度は ST-Bridge の FD断面 > 階 > 共通の順で解決する。
 * 日建連2023標準図 §3-2 の L2/L2h/La/8d は候補値として保持し、§6 の基礎形式・浮上り条件は
 * explicit typeとの整合確認だけに使う。type別の最終必要長・折曲げ方向・RebarPathは後段resolverの責務とする。
 *
 * @module data/extractors/rebar3d/foundationBeamEndBarFacts
 */

import { getRebarProjectDetailing } from '../../../config/rebarProjectDetailing.js';
import { createTagScanner, findElementById } from '../columnSupportUtils.js';
import { buildBeamRebarLayoutMaps } from './beamRebarPlacement.js';
import { resolveFoundationBeamAnchorageStandardCandidates } from './foundationBeamAnchorageStandardCandidates.js';
import { validateFoundationBeamAnchorageType2023 } from './foundationBeamAnchorageTypeConstraint2023.js';
import { resolveFoundationBeamAnchorageType } from './foundationBeamAnchorageTypeResolver.js';
import { resolveFoundationBeamConcreteKind } from './foundationBeamConcreteKindResolver.js';
import { resolveFoundationBeamContinuity } from './foundationBeamContinuityResolver.js';
import { resolveFoundationBeamFoundationColumnGeometry } from './foundationBeamFoundationColumnGeometry.js';
import { resolveFoundationBeamFoundationSystem } from './foundationBeamFoundationSystem.js';
import { resolveFoundationBeamSupportConcreteStrength } from './foundationBeamSupportConcreteStrength.js';
import { resolveFoundationBeamUplift } from './foundationBeamUpliftResolver.js';

function unresolvedEnd(endFact, reason, extra = {}) {
  return {
    side: endFact?.side || null,
    nodeId: endFact?.nodeId || null,
    resolved: false,
    reason,
    source: 'R13-foundation-beam-end-bar-facts',
    bars: [],
    geometry: null,
    anchorageRequirementResolved: false,
    ...extra,
  };
}

function resolveLayout(layoutMaps, sectionId) {
  const girderLayout = layoutMaps?.girder?.get?.(String(sectionId)) || null;
  const beamLayout = layoutMaps?.beam?.get?.(String(sectionId)) || null;
  if (girderLayout && beamLayout) {
    return {
      status: 'UNRESOLVED',
      reason: 'foundation-beam-section-layout-ambiguous',
      layout: null,
    };
  }
  const layout = girderLayout || beamLayout;
  return layout
    ? { status: 'READY', reason: null, layout }
    : { status: 'UNRESOLVED', reason: 'foundation-beam-section-layout-missing', layout: null };
}

function resolveEndSegment(layout, side) {
  const segments = [...(layout?.segments || [])].filter(
    (segment) => Number.isFinite(segment.startRatio) && Number.isFinite(segment.endRatio),
  );
  if (!segments.length) return null;
  segments.sort((a, b) => a.startRatio - b.startRatio || a.endRatio - b.endRatio);
  return side === 'end' ? segments[segments.length - 1] : segments[0];
}

function anchorageRequirementReason(typeResolution) {
  if (typeResolution?.resolved) return 'foundation-anchorage-requirement-resolver-not-connected';
  const blocker = typeResolution?.blockers?.[0] || null;
  if (blocker === 'foundation-anchorage-project-setting-missing') {
    return 'foundation-anchorage-type-requires-explicit-project-setting';
  }
  return blocker || 'foundation-anchorage-type-requires-explicit-project-setting';
}

function unresolvedTypeConstraint(reason, extra = {}) {
  return {
    status: 'UNRESOLVED',
    resolved: false,
    valid: null,
    blockers: [reason],
    source: 'NIKKENREN-JSCA-RC-REBAR-STANDARD-2023-SECTION-6',
    ...extra,
  };
}

function copyMainBar(
  bar,
  barIndex,
  availableProjectionMm,
  anchorageTypeResolution,
  supportConcreteStrengthResolution,
  concreteKindResolution,
  standardCandidatesResolution,
) {
  return {
    barIndex,
    role: bar.role,
    layer: bar.layer ?? null,
    u: Number.isFinite(bar.u) ? bar.u : null,
    v: Number.isFinite(bar.v) ? bar.v : null,
    diaMm: Number.isFinite(bar.dia) ? bar.dia : null,
    designation: bar.diaName || null,
    grade: bar.grade || null,
    diaEstimated: bar.diaEstimated === true,
    positionZone: bar.positionZone || null,
    positionSource: bar.positionSource || null,
    centerFromTopMm: Number.isFinite(bar.centerFromTopMm) ? bar.centerFromTopMm : null,
    sectionDepthMm: Number.isFinite(bar.sectionDepthMm) ? bar.sectionDepthMm : null,
    availableProjectionMm,
    supportConcreteStrength: supportConcreteStrengthResolution?.value || null,
    supportConcreteStrengthSource: supportConcreteStrengthResolution?.source || null,
    supportConcreteStrengthResolved: supportConcreteStrengthResolution?.resolved === true,
    supportConcreteStrengthBlockers: [...(supportConcreteStrengthResolution?.blockers || [])],
    concreteKind: concreteKindResolution?.concreteKind || null,
    concreteKindResolved: concreteKindResolution?.resolved === true,
    concreteKindBasis: concreteKindResolution?.basis || null,
    concreteKindBlockers: [...(concreteKindResolution?.blockers || [])],
    standardAnchorageCandidatesResolved: standardCandidatesResolution?.resolved === true,
    standardAnchorageCandidates: standardCandidatesResolution?.resolved
      ? standardCandidatesResolution.candidates
      : null,
    standardAnchorageCandidateBlockers: [...(standardCandidatesResolution?.blockers || [])],
    anchorageType: anchorageTypeResolution?.resolved ? anchorageTypeResolution.type : null,
    anchorageTypeResolved: anchorageTypeResolution?.resolved === true,
    anchorageTypeStatus: anchorageTypeResolution?.status || 'UNRESOLVED',
    anchorageTypeSource: anchorageTypeResolution?.source || null,
    anchorageTypeBasis: anchorageTypeResolution?.basis || null,
    anchorageTypeBlockers: [...(anchorageTypeResolution?.blockers || [])],
    requiredAnchorageMm: null,
    anchorageRequirementResolved: false,
    anchorageRequirementReason: anchorageRequirementReason(anchorageTypeResolution),
  };
}

function resolveBeamEnd(scanTag, member, beamFact, endFact, layout, options, projectDetailing) {
  if (!endFact?.resolved) {
    return unresolvedEnd(endFact, 'foundation-beam-end-topology-unresolved', {
      topologyReasons: [...(endFact?.reasons || [])],
    });
  }
  if (endFact.primaryContext !== 'FOUNDATION_COLUMN' || !endFact.foundationColumn) {
    return unresolvedEnd(
      endFact,
      `foundation-beam-end-context-not-foundation-column:${endFact.primaryContext || 'UNRESOLVED'}`,
    );
  }

  const geometry = resolveFoundationBeamFoundationColumnGeometry(scanTag, member, endFact, {
    index: options.index || null,
  });
  if (!geometry.resolved) {
    return unresolvedEnd(endFact, geometry.reason, { geometry });
  }

  const segment = resolveEndSegment(layout, endFact.side);
  if (!segment) {
    return unresolvedEnd(endFact, 'foundation-beam-end-segment-unresolved', { geometry });
  }
  const mainBars = (segment.bars || []).filter(
    (bar) => bar?.role === 'top' || bar?.role === 'bottom',
  );
  if (!mainBars.length) {
    return unresolvedEnd(endFact, 'foundation-beam-end-main-bars-missing', {
      geometry,
      positionZone: segment.positionZone || null,
    });
  }

  const target = {
    elementId: beamFact.elementId,
    sectionId: beamFact.sectionId,
    memberTag: beamFact.memberTag,
    side: endFact.side,
  };
  const anchorageTypeResolution = resolveFoundationBeamAnchorageType(projectDetailing, target);
  const concreteKindResolution = resolveFoundationBeamConcreteKind(projectDetailing, target);
  const upliftResolution = resolveFoundationBeamUplift(projectDetailing, target);
  const continuityResolution =
    beamFact.memberTag === 'StbBeam'
      ? resolveFoundationBeamContinuity(projectDetailing, target)
      : null;
  const foundationSystemResolution = resolveFoundationBeamFoundationSystem(endFact);
  const anchorageTypeConstraintResolution = anchorageTypeResolution.resolved
    ? validateFoundationBeamAnchorageType2023({
        memberTag: beamFact.memberTag,
        type: anchorageTypeResolution.type,
        uplift: upliftResolution.resolved ? upliftResolution.uplift : null,
        foundationSystem: foundationSystemResolution.resolved
          ? foundationSystemResolution.foundationSystem
          : null,
        continuous: continuityResolution?.resolved ? continuityResolution.continuous : null,
      })
    : unresolvedTypeConstraint('foundation-type-constraint-type-unresolved', {
        typeBlockers: [...(anchorageTypeResolution.blockers || [])],
      });

  const supportConcreteStrengthResolution = resolveFoundationBeamSupportConcreteStrength(
    member.ownerDocument || null,
    endFact,
    {
      scanTag,
      index: options.index || null,
    },
  );
  const standardCandidateResolutions = mainBars.map((bar) =>
    resolveFoundationBeamAnchorageStandardCandidates(
      {
        diaMm: Number.isFinite(bar.dia) ? bar.dia : null,
        designation: bar.diaName || null,
        grade: bar.grade || null,
        diaEstimated: bar.diaEstimated === true,
      },
      {
        supportConcreteStrength: supportConcreteStrengthResolution.value,
        concreteKind: concreteKindResolution.concreteKind,
        columnDepthMm: geometry.projectionMm,
      },
    ),
  );
  const bars = mainBars.map((bar, index) =>
    copyMainBar(
      bar,
      index,
      geometry.projectionMm,
      anchorageTypeResolution,
      supportConcreteStrengthResolution,
      concreteKindResolution,
      standardCandidateResolutions[index],
    ),
  );
  const standardAnchorageCandidatesResolved = standardCandidateResolutions.every(
    (resolution) => resolution.resolved,
  );
  return {
    side: endFact.side,
    nodeId: endFact.nodeId,
    resolved: true,
    reason: null,
    source: 'R13-foundation-beam-end-bar-facts',
    primaryContext: endFact.primaryContext,
    foundationColumnId: endFact.foundationColumn.id,
    foundationColumnName: endFact.foundationColumn.name || null,
    positionZone: segment.positionZone || null,
    layoutEstimated: layout.estimated === true,
    layoutUnresolved: [...(layout.unresolved || [])],
    geometry,
    availableProjectionMm: geometry.projectionMm,
    supportConcreteStrengthResolution,
    supportConcreteStrength: supportConcreteStrengthResolution.value,
    supportConcreteStrengthSource: supportConcreteStrengthResolution.source,
    supportConcreteStrengthResolved: supportConcreteStrengthResolution.resolved,
    concreteKindResolution,
    concreteKind: concreteKindResolution.concreteKind,
    concreteKindResolved: concreteKindResolution.resolved,
    upliftResolution,
    uplift: upliftResolution.uplift,
    continuityResolution,
    continuous: continuityResolution?.resolved ? continuityResolution.continuous : null,
    foundationSystemResolution,
    foundationSystem: foundationSystemResolution.foundationSystem,
    anchorageTypeConstraintResolution,
    anchorageTypeConstraintResolved: anchorageTypeConstraintResolution.resolved,
    anchorageTypeConstraintValid: anchorageTypeConstraintResolution.valid,
    standardAnchorageCandidatesResolved,
    standardAnchorageCandidateResolutions: standardCandidateResolutions,
    bars,
    anchorageTypeResolution,
    anchorageTypeResolved: anchorageTypeResolution.resolved,
    anchorageType: anchorageTypeResolution.type,
    anchorageRequirementResolved: false,
    anchorageRequirementReason: anchorageRequirementReason(anchorageTypeResolution),
    beamElementId: beamFact.elementId,
    beamSectionId: beamFact.sectionId,
  };
}

/**
 * 基礎梁 topology facts を端部主筋 + support geometry factsへ変換する。
 *
 * @param {Document} xmlDoc STB XML document
 * @param {{beam:Map<string,Object>,unresolved?:Array<Object>}} topologyFacts
 * @param {Object} [options]
 * @param {function(string): Element[]} [options.scanTag]
 * @param {Object|null} [options.index=null]
 * @param {Object|null} [options.layoutMaps=null]
 * @param {Object} [options.layoutOptions]
 * @returns {{beam:Map<string,Object>,unresolved:Array<Object>}}
 */
export function buildFoundationBeamEndBarFacts(xmlDoc, topologyFacts, options = {}) {
  const beam = new Map();
  const unresolved = [];
  if (!xmlDoc || !(topologyFacts?.beam instanceof Map)) return { beam, unresolved };

  const scanTag = options.scanTag || createTagScanner(xmlDoc);
  const layoutMaps =
    options.layoutMaps || buildBeamRebarLayoutMaps(xmlDoc, options.layoutOptions || {});
  const projectDetailing =
    options.projectDetailing === undefined ? getRebarProjectDetailing() : options.projectDetailing;

  for (const [elementId, topology] of topologyFacts.beam) {
    const member = findElementById(scanTag, topology.memberTag, elementId, options.index || null);
    const layoutResolution = resolveLayout(layoutMaps, topology.sectionId);
    const ends = [];

    if (!member) {
      for (const endFact of topology.ends || []) {
        ends.push(unresolvedEnd(endFact, 'foundation-beam-element-not-found'));
      }
    } else if (layoutResolution.status !== 'READY') {
      for (const endFact of topology.ends || []) {
        ends.push(unresolvedEnd(endFact, layoutResolution.reason));
      }
    } else {
      for (const endFact of topology.ends || []) {
        ends.push(
          resolveBeamEnd(
            scanTag,
            member,
            topology,
            endFact,
            layoutResolution.layout,
            options,
            projectDetailing,
          ),
        );
      }
    }

    const fact = {
      elementId: String(elementId),
      elementName: topology.elementName || null,
      memberTag: topology.memberTag,
      sectionId: topology.sectionId,
      source: 'R13-foundation-beam-end-bar-facts',
      ends,
      resolved: ends.every((end) => end.resolved),
      anchorageRequirementResolved: false,
    };
    beam.set(String(elementId), fact);

    for (const end of ends) {
      if (end.resolved) continue;
      unresolved.push({
        elementId: String(elementId),
        elementName: fact.elementName,
        memberTag: fact.memberTag,
        side: end.side,
        nodeId: end.nodeId,
        reason: end.reason,
        source: fact.source,
      });
    }
  }

  return { beam, unresolved };
}

export const _foundationBeamEndBarFactsInternals = Object.freeze({
  resolveLayout,
  resolveEndSegment,
  copyMainBar,
  anchorageRequirementReason,
});
