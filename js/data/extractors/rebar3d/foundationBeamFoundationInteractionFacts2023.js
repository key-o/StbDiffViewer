/**
 * @fileoverview §6-3のSTB geometryと2023標準図requirementを1端単位で接続する。
 */

import { resolveFoundationBeamFoundationStepGeometry2023 } from './foundationBeamFoundationStepGeometry2023.js';
import { resolveFoundationBeamFoundationPlanInteraction2023 } from './foundationBeamFoundationPlanInteraction2023.js';
import { resolveFoundationBeamFoundationInteractionRequirement2023 } from './foundationBeamInteractionStandard2023.js';
import { resolveFoundationBeamFoundationInteractionMaterialFacts2023 } from './foundationBeamFoundationInteractionMaterialFacts2023.js';
import { resolveFoundationBeamFoundationInteractionLengthPlan2023 } from './foundationBeamFoundationInteractionLengthPlan2023.js';
import { resolveFoundationBeamFoundationInteractionBarPlan2023 } from './foundationBeamFoundationInteractionBarPlan2023.js';
import { resolveFoundationBeamConcreteKind } from './foundationBeamConcreteKindResolver.js';
import { resolveFoundationBeamFoundationDetailSource2023 } from './foundationBeamInteractionDetailSource2023.js';

const SOURCE = 'R13-foundation-beam-foundation-interaction-facts-2023';

function stop(stage, resolution, extra = {}) {
  return {
    status: resolution?.status || 'UNRESOLVED',
    resolved: false,
    interactionRequirementResolved: false,
    geometryResolved: false,
    productionReady: false,
    reason: resolution?.reason || `foundation-interaction-${stage}-unresolved`,
    blockers: [...(resolution?.blockers || [])],
    source: SOURCE,
    stage,
    stepGeometry: stage === 'step' ? resolution || null : null,
    planInteraction: stage === 'plan' ? resolution || null : null,
    requirement: stage === 'requirement' ? resolution || null : null,
    materialFacts: null,
    lengthPlan: null,
    barPlan: null,
    ...extra,
  };
}

export function resolveFoundationBeamFoundationInteractionFacts2023({
  scanTag,
  beamEl,
  endFact,
  detailSource,
  beamStirrup = null,
  concreteKind = null,
  projectDetailing = undefined,
  index = null,
} = {}) {
  const stepGeometry = resolveFoundationBeamFoundationStepGeometry2023({
    scanTag,
    beamEl,
    endFact,
    index,
  });
  if (stepGeometry.status !== 'READY') return stop('step', stepGeometry);

  const planInteraction = resolveFoundationBeamFoundationPlanInteraction2023({
    scanTag,
    beamEl,
    endFact,
    stepGeometry,
    index,
  });
  if (planInteraction.status !== 'READY') {
    return stop('plan', planInteraction, { stepGeometry });
  }

  const target = {
    elementId: beamEl?.getAttribute?.('id'),
    sectionId: beamEl?.getAttribute?.('id_section'),
    side: endFact?.side,
  };
  const detailSourceResolution =
    detailSource || projectDetailing === undefined
      ? null
      : resolveFoundationBeamFoundationDetailSource2023(projectDetailing, target);
  const effectiveDetailSource =
    detailSource || (detailSourceResolution?.resolved ? detailSourceResolution.value : null);

  const requirement = resolveFoundationBeamFoundationInteractionRequirement2023({
    detailSource: effectiveDetailSource,
    stepHeightMm: stepGeometry.stepHeightMm,
    beamWidthMm: stepGeometry.beamWidthMm,
    beamStirrup,
  });
  if (requirement.status !== 'READY') {
    return stop('requirement', requirement, {
      stepGeometry,
      planInteraction,
      detailSourceResolution,
      effectiveDetailSource,
    });
  }

  const materialFacts = resolveFoundationBeamFoundationInteractionMaterialFacts2023({
    scanTag,
    beamEl,
    endFact,
    stepGeometry,
    index,
  });
  const concreteKindResolution =
    concreteKind || projectDetailing === undefined
      ? null
      : resolveFoundationBeamConcreteKind(projectDetailing, target);
  const effectiveConcreteKind =
    concreteKind || (concreteKindResolution?.resolved ? concreteKindResolution.concreteKind : null);
  const lengthPlan =
    materialFacts.status === 'READY'
      ? resolveFoundationBeamFoundationInteractionLengthPlan2023({
          materialFacts,
          concreteKind: effectiveConcreteKind,
        })
      : null;
  const lengthPlanResolved = lengthPlan?.status === 'READY';
  const barPlan = lengthPlanResolved
    ? resolveFoundationBeamFoundationInteractionBarPlan2023({
        stepGeometry,
        planInteraction,
        requirement,
        lengthPlan,
      })
    : null;
  const barPlanResolved = barPlan?.status === 'READY';
  const nextBlocker =
    materialFacts.status !== 'READY'
      ? materialFacts.reason || 'foundation-interaction-material-facts-unresolved'
      : !lengthPlanResolved
        ? lengthPlan?.reason || 'foundation-interaction-length-plan-unresolved'
        : !barPlanResolved
          ? barPlan?.reason || 'foundation-interaction-bar-plan-unresolved'
          : barPlan.productionBlockers?.[0] || 'foundation-interaction-world-path-unresolved';

  return {
    status: 'READY',
    resolved: true,
    interactionRequirementResolved: true,
    geometryResolved: true,
    materialFactsResolved: materialFacts.status === 'READY',
    lengthPlanResolved,
    barPlanResolved,
    productionReady: false,
    reason: null,
    blockers: [],
    productionBlockers: [nextBlocker],
    source: SOURCE,
    stage: 'READY',
    side: endFact?.side || null,
    nodeId: endFact?.nodeId || null,
    stepGeometry,
    planInteraction,
    requirement,
    detailSourceResolution,
    effectiveDetailSource,
    materialFacts,
    concreteKindResolution,
    effectiveConcreteKind,
    lengthPlan,
    barPlan,
  };
}
