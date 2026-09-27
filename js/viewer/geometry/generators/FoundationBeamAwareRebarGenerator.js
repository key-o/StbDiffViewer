/**
 * @fileoverview 既存BeamIdentity rendererへR13基礎大梁定着を追加するpublic adapter。
 *
 * BeamIdentityRebarGeneratorの既存R5/R7/R8/R10/R12経路は変更せず、
 * StbGirder batchだけR13 production planを評価してworld定着pathを追加する。
 * identity/continuityが未解決なら定着のみfail-closedし、既存主筋meshは維持する。
 */

import { getState } from '../../../data/state/globalState.js';
import { calculateBeamPlacement } from '../core/GeometryCalculator.js';
import { buildBeamMemberRebarPaths } from '../../../data/extractors/rebar3d/beamRebarPathBuilder.js';
import {
  buildFoundationBeamAnchorageRenderPlan2023,
  isFoundationGirderElementBatch,
} from '../../../data/extractors/rebar3d/foundationBeamAnchorageRenderPlan2023.js';
import { createBeamRebarMeshes as createBaseBeamRebarMeshes } from './BeamIdentityRebarGenerator.js';
import { createColumnJointRebarMeshes } from './ColumnJointRebarGenerator.js';
import { resolveFoundationBeamAnchorageWorldPaths } from './FoundationBeamAnchorageWorldResolver.js';

function resolveModelDocument(options) {
  if (options?.xmlDoc) return options.xmlDoc;
  if (options?.modelSource === 'A') return getState('models.documentA');
  if (options?.modelSource === 'B') return getState('models.documentB');
  return null;
}

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

function resolveFoundationPlan(beamElements, layoutMap, options) {
  if (options?.foundationBeamAnchorageRenderPlan) return options.foundationBeamAnchorageRenderPlan;
  const xmlDoc = resolveModelDocument(options);
  if (!xmlDoc || !isFoundationGirderElementBatch(xmlDoc, beamElements)) return null;
  try {
    return buildFoundationBeamAnchorageRenderPlan2023(xmlDoc, layoutMap, options);
  } catch (_error) {
    return null;
  }
}

function buildFinalGirderMemberPaths(layout, placement, memberId, options) {
  const endpointTrims = options?.jointTransitionPlan?.memberEndTrims?.get?.(memberId) || [];
  const haunchTransitions = options?.haunchTransitionPlan?.memberTransitions?.get?.(memberId) || [];
  return buildBeamMemberRebarPaths(layout, placement.length, {
    memberId,
    endpointTrims,
    haunchTransitions,
  });
}

/**
 * 既存梁鉄筋meshに、R13でCENTERLINE_READYな基礎大梁定着だけを追加する。
 * public signatureは従来createBeamRebarMeshesと同一。
 */
export function createBeamRebarMeshes(beamElements, nodes, layoutMap, options = {}) {
  const meshes = createBaseBeamRebarMeshes(beamElements, nodes, layoutMap, options);
  if (!beamElements?.length || !nodes?.size || !layoutMap?.size) return meshes;

  const plan = resolveFoundationPlan(beamElements, layoutMap, options);
  if (!plan?.members?.size) return meshes;

  const worldPaths = [];
  for (const beam of beamElements) {
    const memberId = String(beam.id);
    const memberPlan = plan.members.get(memberId);
    if (!memberPlan) continue;
    const layout = layoutMap.get(String(beam.id_section));
    if (!layout) continue;
    const placement = beamPlacement(beam, nodes, layout);
    if (!placement || !(placement.length > 0)) continue;
    const built = buildFinalGirderMemberPaths(layout, placement, memberId, options);
    if (built.semanticMainBarCount === 0) continue;

    const resolved = resolveFoundationBeamAnchorageWorldPaths({
      memberPlan,
      memberPaths: built.paths,
      placement,
      memberLengthMm: placement.length,
      memberId,
      sectionId: beam.id_section,
    });
    if (!resolved.resolved) continue;
    worldPaths.push(...resolved.paths);
  }

  if (!worldPaths.length) return meshes;
  return [
    ...meshes,
    ...createColumnJointRebarMeshes(worldPaths, {
      modelSource: options.modelSource,
      rebarKind: 'foundationBeamAnchorage',
    }),
  ];
}

export const _foundationBeamAwareRebarGeneratorInternals = Object.freeze({
  resolveModelDocument,
  beamPlacement,
  resolveFoundationPlan,
  buildFinalGirderMemberPaths,
});
