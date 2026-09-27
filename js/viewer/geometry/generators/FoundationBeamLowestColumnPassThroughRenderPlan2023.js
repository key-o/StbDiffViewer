/**
 * @fileoverview R13 §6-4 case1のinteraction facts + member stirrup layoutを
 * phase解決・world path化まで束ねるviewer-side render plan。
 */

import { resolveFoundationBeamLowestColumnPassThroughPlacement2023 } from '../../../data/extractors/rebar3d/foundationBeamLowestColumnPassThroughPlacement2023.js';
import { calculateBeamPlacement } from '../core/GeometryCalculator.js';
import { resolveFoundationBeamLowestColumnPassThroughWorldPaths2023 } from './FoundationBeamLowestColumnPassThroughWorldResolver.js';

function beamPlacement(beam, nodes, layout) {
  const start = nodes?.get?.(String(beam?.id_node_start));
  const end = nodes?.get?.(String(beam?.id_node_end));
  if (!start || !end) return null;
  const placement = calculateBeamPlacement(
    { x: start.x, y: start.y, z: start.z },
    { x: end.x, y: end.y, z: end.z },
    {
      startOffset: {
        x: Number(beam.offset_start_X || 0),
        y: Number(beam.offset_start_Y || 0),
        z: Number(beam.offset_start_Z || 0),
      },
      endOffset: {
        x: Number(beam.offset_end_X || 0),
        y: Number(beam.offset_end_Y || 0),
        z: Number(beam.offset_end_Z || 0),
      },
      placementMode: 'top-aligned',
      sectionHeight: layout?.depth || 0,
    },
  );
  const rollAngleDegrees = Number(beam.rotate ?? beam.angle ?? 0) || 0;
  return { ...placement, localRollRad: (rollAngleDegrees * Math.PI) / 180 };
}

function check(elementId, end, phase, world) {
  if (!end) return null;
  if (end.passThroughRequired !== true) {
    return {
      elementId,
      side: end.side || null,
      status: end.status || 'NOT_REQUIRED',
      ready: false,
      reason:
        end.productionBlockers?.[0] ||
        end.reason ||
        'foundation-lowest-column-pass-through-not-required-for-case',
      pathCount: 0,
    };
  }
  if (phase?.status !== 'READY') {
    return {
      elementId,
      side: end.side || null,
      status: phase?.status || 'UNRESOLVED',
      ready: false,
      reason: phase?.reason || 'foundation-lowest-column-pass-through-phase-unresolved',
      pathCount: 0,
    };
  }
  if (world?.resolved !== true) {
    return {
      elementId,
      side: end.side || null,
      status: 'UNRESOLVED',
      ready: false,
      reason: world?.reason || 'foundation-lowest-column-pass-through-world-unresolved',
      pathCount: 0,
    };
  }
  return {
    elementId,
    side: end.side || null,
    status: 'READY',
    ready: true,
    reason: null,
    pathCount: world.paths.length,
  };
}

export function buildFoundationBeamLowestColumnPassThroughRenderPlan2023({
  beamElements,
  nodes,
  actualLayouts,
  interactionFacts,
  tessellation = undefined,
} = {}) {
  const paths = [];
  const checks = [];
  if (
    !beamElements?.length ||
    !nodes?.size ||
    !actualLayouts?.size ||
    !(interactionFacts?.beam instanceof Map)
  ) {
    return { paths, checks, readyCount: 0, unresolvedCount: 0 };
  }

  for (const beam of beamElements) {
    const memberId = String(beam?.id || '');
    if (!memberId) continue;
    const memberFacts = interactionFacts.beam.get(memberId);
    if (!memberFacts) continue;
    const layout = actualLayouts.get(memberId);
    if (!layout) continue;
    const placement = beamPlacement(beam, nodes, layout);
    if (!placement || !(placement.length > 0)) continue;

    for (const end of memberFacts.ends || []) {
      if (!end) continue;
      if (end.passThroughRequired !== true) {
        const resultCheck = check(memberId, end, null, null);
        if (resultCheck) checks.push(resultCheck);
        continue;
      }
      const phase = resolveFoundationBeamLowestColumnPassThroughPlacement2023({
        interactionFact: end,
        memberStirrupLayout: layout,
      });
      const world =
        phase.status === 'READY'
          ? resolveFoundationBeamLowestColumnPassThroughWorldPaths2023({
              interactionFact: end,
              phasePlacement: phase,
              memberStirrupLayout: layout,
              placement,
              memberId,
              memberTag: 'StbGirder',
              tessellation,
            })
          : null;
      const resultCheck = check(memberId, end, phase, world);
      if (resultCheck) checks.push(resultCheck);
      if (world?.resolved) paths.push(...world.paths);
    }
  }

  return {
    paths,
    checks,
    readyCount: checks.filter((entry) => entry.ready).length,
    unresolvedCount: checks.filter((entry) => !entry.ready && entry.status !== 'NOT_REQUIRED')
      .length,
  };
}

export const _foundationBeamLowestColumnPassThroughRenderPlanInternals = Object.freeze({
  beamPlacement,
  check,
});
