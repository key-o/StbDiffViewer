/**
 * @fileoverview R12-AH 図9-4片持ち梁・先端小梁factsを既存配筋チェック行へ投影する。
 */

const CATEGORY = '梁定着';
const SPECIAL_DETAILING_TYPE = 'SMALL_BEAM_CANTILEVER_TIP_BEAM';

function base(fact, overrides = {}) {
  return {
    category: CATEGORY,
    kind: '片持ち小梁・先端小梁（図9-4）',
    elementId: fact.elementId || null,
    elementName: fact.elementName || null,
    sectionName: fact.cantileverSectionId || null,
    position: '-',
    role: null,
    diaMm: null,
    grade: null,
    fc: null,
    count: 0,
    requiredMm: null,
    availableMm: null,
    exact: false,
    ok: null,
    generationStatus: 'UNRESOLVED',
    requirementOnly: true,
    partialCheck: false,
    specialDetailingRequired: true,
    specialDetailingType: SPECIAL_DETAILING_TYPE,
    specialDetailingStatus: 'UNRESOLVED',
    productionGateStatus: 'UNRESOLVED',
    productionGateReady: false,
    productionGateEvaluated: false,
    productionGateBlockers: [],
    ...overrides,
  };
}

function figureLabel(fact) {
  return fact.figureCase === 'FIGURE_9_4_1' ? '図9-4-1' : '図9-4-2';
}

function detailingState(fact) {
  const detailing = fact?.tipBeamDetailing || null;
  if (detailing?.resolved === true) {
    return {
      resolved: true,
      status: 'RESOLVED',
      source: detailing.source || null,
      grade: detailing.assignment?.cBarGrade || null,
      blockers: detailing.blockers || ['cantilever-tip-beam-production-path-not-yet-connected'],
      reason: null,
    };
  }

  const reason = detailing?.reason || 'cantilever-tip-beam-explicit-detail-required';
  const requiredReasons = new Set([
    'cantilever-tip-beam-explicit-detail-required',
    'cantilever-tip-beam-production-not-enabled',
    'cantilever-tip-beam-assignment-missing',
  ]);
  return {
    resolved: false,
    status: requiredReasons.has(reason) ? 'REQUIRED' : 'UNRESOLVED',
    source: detailing?.source || null,
    grade: null,
    blockers: [reason],
    reason,
  };
}

function mainIdentityState(fact) {
  if (fact?.figureCase !== 'FIGURE_9_4_2') {
    return {
      resolved: true,
      status: 'RESOLVED',
      blockers: [],
      reason: null,
    };
  }

  const identity = fact?.tipBeamMainBarIdentity || null;
  if (identity?.resolved === true && identity.identityReady === true) {
    return {
      resolved: true,
      status: 'RESOLVED',
      blockers: identity.blockers || ['cantilever-tip-beam-main-bar-geometry-not-yet-resolved'],
      reason: null,
    };
  }
  const reason = identity?.reason || 'cantilever-tip-beam-main-bar-identity-not-ready';
  return {
    resolved: false,
    status: 'UNRESOLVED',
    blockers: [reason],
    reason,
  };
}

function pathPlanState(fact, role) {
  const plan = fact?.tipBeamPathPlan || null;
  if (plan?.resolved === true && plan.preProductionPlanReady === true) {
    if (role === 'C_BAR') {
      const cBarPaths = fact?.tipBeamCBarPaths || null;
      if (cBarPaths?.resolved === true && cBarPaths.pathReady === true) {
        return {
          resolved: true,
          stationingReady: true,
          pathReady: true,
          status: 'RESOLVED',
          blockers: ['cantilever-tip-beam-c-bar-world-path-not-yet-connected'],
          reason: null,
        };
      }

      const stationing = fact?.tipBeamCBarStationing || null;
      if (stationing?.resolved === true && stationing.stationingReady === true) {
        return {
          resolved: true,
          stationingReady: true,
          pathReady: false,
          status: 'RESOLVED',
          blockers: [
            cBarPaths?.reason || 'cantilever-tip-beam-c-bar-cross-section-path-not-yet-resolved',
          ],
          reason: cBarPaths?.reason || null,
        };
      }
      return {
        resolved: true,
        stationingReady: false,
        pathReady: false,
        status: 'RESOLVED',
        blockers: [stationing?.reason || 'cantilever-tip-beam-c-bar-stationing-not-yet-resolved'],
        reason: stationing?.reason || null,
      };
    }

    return {
      resolved: true,
      stationingReady: null,
      pathReady: false,
      status: 'RESOLVED',
      blockers: ['cantilever-tip-beam-main-bar-geometry-not-yet-resolved'],
      reason: null,
    };
  }

  if (role === 'C_BAR') {
    const detailing = detailingState(fact);
    return {
      resolved: false,
      stationingReady: false,
      pathReady: false,
      status: detailing.status,
      blockers: [plan?.reason || detailing.reason].filter(Boolean),
      reason: plan?.reason || detailing.reason,
    };
  }

  const identity = mainIdentityState(fact);
  return {
    resolved: false,
    stationingReady: null,
    pathReady: false,
    status: identity.status,
    blockers: [plan?.reason || identity.reason].filter(Boolean),
    reason: plan?.reason || identity.reason,
  };
}

function cBarRow(fact) {
  const cBar = fact.cBar || {};
  const detailing = detailingState(fact);
  const pathPlan = pathPlanState(fact, 'C_BAR');
  return base(fact, {
    position: `${figureLabel(fact)} C形筋`,
    role: 'C_BAR',
    diaMm: cBar.barDiaMm ?? null,
    grade: detailing.grade || cBar.grade || null,
    requiredMm: cBar.legLengthMm ?? null,
    exact: Number.isFinite(cBar.legLengthMm),
    generationStatus: 'REQUIREMENT_READY',
    requirementKind: 'TIP_BEAM_C_BAR_25D',
    specialDetailingStatus: pathPlan.status,
    specialDetailingSource: detailing.source,
    detailingReady: detailing.resolved,
    preProductionPlanReady: pathPlan.resolved,
    cBarStationingReady: pathPlan.stationingReady === true,
    cBarStationCount: fact?.tipBeamCBarStationing?.stationCount ?? null,
    cBarPathReady: pathPlan.pathReady === true,
    cBarPathCount: fact?.tipBeamCBarPaths?.paths?.length ?? null,
    productionGateBlockers: pathPlan.blockers,
    note:
      `先端小梁あばら筋と同径・同間隔、C形筋脚長25d。先端小梁あばら筋=${cBar.designation || '-'}@${cBar.pitchMm ?? '-'}。 ` +
      (detailing.resolved
        ? 'C形筋grade/標準配置はproject explicit detailで確認済み。'
        : '図9-4はC形筋gradeを明示しないため、productionでは別途確定が必要。'),
  });
}

function topRows(fact) {
  const detailing = detailingState(fact);
  const identity = mainIdentityState(fact);
  const pathPlan = pathPlanState(fact, 'top');
  return (fact.tipBeamMainAnchorage?.top || []).flatMap((bar) => [
    base(fact, {
      position: '図9-4-2 先端小梁上端筋 L2',
      role: 'top',
      diaMm: bar.diaMm,
      grade: bar.grade || null,
      fc: fact.tipBeamMainAnchorage?.anchorageConcreteFc ?? null,
      count: bar.count || 0,
      requiredMm: bar.l2RequiredMm ?? null,
      exact: Number.isFinite(bar.l2RequiredMm),
      generationStatus: 'REQUIREMENT_READY',
      requirementKind: 'TIP_BEAM_TOP_L2',
      specialDetailingStatus: pathPlan.status,
      specialDetailingSource: detailing.source,
      detailingReady: detailing.resolved,
      tipBeamMainIdentityReady: identity.resolved,
      preProductionPlanReady: pathPlan.resolved,
      productionGateBlockers: pathPlan.blockers,
      note:
        `先端小梁上端筋を片持ち梁へL2=${bar.l2Factor ?? '-'}dで定着。` +
        (identity.resolved ? ' endpoint identity確認済み。' : ' endpoint identity未解決。'),
    }),
    base(fact, {
      position: '図9-4-2 先端小梁上端筋 8d/150/B2',
      role: 'top',
      diaMm: bar.diaMm,
      grade: bar.grade || null,
      fc: fact.tipBeamMainAnchorage?.anchorageConcreteFc ?? null,
      count: bar.count || 0,
      requiredMm: bar.additionalStraight?.requiredMm ?? null,
      exact: Number.isFinite(bar.additionalStraight?.requiredMm),
      generationStatus: 'REQUIREMENT_READY',
      requirementKind: 'TIP_BEAM_TOP_MAX_8D_150_B2',
      specialDetailingStatus: pathPlan.status,
      specialDetailingSource: detailing.source,
      detailingReady: detailing.resolved,
      tipBeamMainIdentityReady: identity.resolved,
      preProductionPlanReady: pathPlan.resolved,
      productionGateBlockers: pathPlan.blockers,
      note: `B=片持ち梁幅。必要長さ=max(8d=${bar.additionalStraight?.byDiaMm ?? '-'}mm, 150mm, B/2=${bar.additionalStraight?.byWidthMm ?? '-'}mm)。`,
    }),
  ]);
}

function bottomRows(fact) {
  const detailing = detailingState(fact);
  const identity = mainIdentityState(fact);
  const pathPlan = pathPlanState(fact, 'bottom');
  return (fact.tipBeamMainAnchorage?.bottom || []).map((bar) =>
    base(fact, {
      position: '図9-4-2 先端小梁下端筋 L3',
      role: 'bottom',
      diaMm: bar.diaMm,
      grade: bar.grade || null,
      fc: fact.tipBeamMainAnchorage?.anchorageConcreteFc ?? null,
      count: bar.count || 0,
      requiredMm: bar.l3RequiredMm ?? null,
      exact: Number.isFinite(bar.l3RequiredMm),
      generationStatus: 'REQUIREMENT_READY',
      requirementKind: 'TIP_BEAM_BOTTOM_L3',
      specialDetailingStatus: pathPlan.status,
      specialDetailingSource: detailing.source,
      detailingReady: detailing.resolved,
      tipBeamMainIdentityReady: identity.resolved,
      preProductionPlanReady: pathPlan.resolved,
      productionGateBlockers: pathPlan.blockers,
      note:
        `先端小梁下端筋を片持ち梁へL3=${bar.l3Factor ?? '-'}dで定着。` +
        (identity.resolved ? ' endpoint identity確認済み。' : ' endpoint identity未解決。'),
    }),
  );
}

function unresolvedRow(elementId, fact) {
  return base(
    {
      elementId,
      elementName: fact?.elementName || null,
      cantileverSectionId: fact?.cantileverSectionId || null,
    },
    {
      position: '図9-4 要件未解決',
      unresolvedReason: fact?.reason || 'cantilever-tip-beam-facts-unresolved',
      note: `図9-4要件を解決できないためproductionへ進めない（${fact?.reason || 'unknown'}）。`,
      productionGateBlockers: [fact?.reason || 'cantilever-tip-beam-facts-unresolved'],
    },
  );
}

export function buildSmallBeamCantileverTipBeamCheckRows(facts) {
  const rows = [];
  for (const [elementId, fact] of facts?.beam || []) {
    if (!fact?.resolved) {
      rows.push(unresolvedRow(String(elementId), fact));
      continue;
    }
    rows.push(cBarRow(fact));
    if (fact.figureCase === 'FIGURE_9_4_2') {
      rows.push(...topRows(fact), ...bottomRows(fact));
    }
  }
  return rows;
}
