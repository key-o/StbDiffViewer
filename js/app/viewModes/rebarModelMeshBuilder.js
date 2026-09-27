/**
 * @fileoverview Construct rebar meshes for one source STB model.
 * Model mesh generation is kept separate from display-group lifecycle orchestration.
 */
import { createLogger } from '../../utils/logger.js';
import {
  applyGirderJointAnchorageSuppression,
  buildGirderJointRenderPlan,
} from '../../data/extractors/rebar3d/girderJointTransitionRenderPlan.js';
import { buildColumnJointRenderPlan } from '../../data/extractors/rebar3d/columnJointRenderPlan.js';
import {
  applyAppendixA2VerticalPlacementToAnchorageMaps,
  buildAppendixA2BeamVerticalPlacementPlan,
} from '../../data/extractors/rebar3d/rebarAppendixA2BeamVerticalPlacement.js';
import { resolveRebarPlacementConflictActivation } from '../../data/extractors/rebar3d/rebarPlacementConflictCandidates.js';
import {
  applyRebarPlacementConflictPlanToAnchorageMaps,
  buildRebarPlacementConflictProductionPlan,
} from '../../data/extractors/rebar3d/rebarPlacementConflictProduction.js';
import { buildPileRebarSectionMap } from '../../data/extractors/rebar3d/pileRebarPlacement.js';
import { buildSlabRebarProductionRenderPlan } from '../../data/extractors/rebar3d/smallOpeningSlabProductionRenderPlan.js';
import { buildWallRebarProductionRenderPlan } from '../../data/extractors/rebar3d/smallOpeningWallProductionRenderPlan.js';
import { buildFoundationRebarRenderPlan } from '../../data/extractors/rebar3d/foundationRebarPlacement.js';
import { buildStripFootingRebarRenderPlan } from '../../data/extractors/rebar3d/stripFootingRebarPlacement.js';
import { buildBeamAnchorageMaps } from '../../data/extractors/rebar3d/beamAnchoragePlacement.js';
import { buildBeamCutoffMaps } from '../../data/extractors/rebar3d/beamCutoffPlacement.js';
import { buildFoundationBeamAnchorageRenderPlan2023 } from '../../data/extractors/rebar3d/foundationBeamAnchorageRenderPlan2023.js';
import { buildFoundationBeamCountDifferenceSnapshot } from '../../data/extractors/rebar3d/foundationBeamCountDifferenceResolver.js';
import { applyFoundationBeamCountDifferenceAnchorageProductionGate } from '../../data/extractors/rebar3d/foundationBeamCountDifferenceAnchorageProduction.js';
import { buildGirderHangerRenderPlan } from '../../data/extractors/rebar3d/girderHangerRenderPlan.js';
import { buildGirderHaunchRenderPlan } from '../../data/extractors/rebar3d/girderHaunchRenderPlan.js';
import { buildTopStoryColumnHeadRenderPlan } from '../../data/extractors/rebar3d/topStoryColumnHeadRenderPlan.js';
import { buildColumnAnchorageMaps } from '../../data/extractors/rebar3d/columnAnchoragePlacement.js';
import { createModelScopedRebarFactName } from '../../data/extractors/rebar3d/rebarFactsCache.js';
import {
  createColumnJointRebarMeshes,
  createRebarPieceMeshes,
  parseStbFile,
} from '../../viewer/index.js';

const log = createLogger('rebarDisplay');

export function createRebarModelMeshes(
  xmlDoc,
  modelSource,
  options,
  memberKey,
  kindKey,
  parseOptions = { modelKey: modelSource },
  dependencies = {},
) {
  const {
    REBAR_MEMBERS,
    REBAR_KINDS,
    cachedRebarFact,
    cachedScanTag,
    buildAnchorageColumnLayouts,
    selectedLayoutSize,
    resolveProjectDetailing,
  } = dependencies;
  if (!xmlDoc || !REBAR_MEMBERS?.[memberKey] || !REBAR_KINDS?.[kindKey]) return [];

  const projectDetailing = resolveProjectDetailing(options);
  const kind = REBAR_KINDS[kindKey];
  const placementConflictActivation = resolveRebarPlacementConflictActivation(projectDetailing);
  const placementConflictReady =
    placementConflictActivation.active && placementConflictActivation.resolved;
  const placementConflictProductionRequested =
    kind.withAnchorage && placementConflictReady && memberKey === 'girder';

  if (
    memberKey === 'slab' ||
    memberKey === 'wall' ||
    memberKey === 'footing' ||
    memberKey === 'stripFooting'
  ) {
    if (kindKey !== 'main') return [];
    const renderPlanKey =
      memberKey === 'slab'
        ? createModelScopedRebarFactName('slab.renderPlan', modelSource)
        : memberKey === 'wall'
          ? createModelScopedRebarFactName('wall.renderPlan', modelSource)
          : memberKey === 'footing'
            ? 'footing.renderPlan'
            : 'stripFooting.renderPlan';
    const renderPlan = cachedRebarFact(xmlDoc, options, renderPlanKey, () => {
      if (memberKey === 'slab') {
        return buildSlabRebarProductionRenderPlan(xmlDoc, {
          ...options,
          modelSource,
          projectDetailing,
        });
      }
      if (memberKey === 'wall') {
        return buildWallRebarProductionRenderPlan(xmlDoc, {
          ...options,
          modelSource,
          projectDetailing,
        });
      }
      if (memberKey === 'footing') return buildFoundationRebarRenderPlan(xmlDoc, options);
      return buildStripFootingRebarRenderPlan(xmlDoc, options);
    });
    if (
      memberKey === 'wall' &&
      renderPlan.production?.smallOpening &&
      !['READY', 'NOT_CONFIGURED'].includes(renderPlan.production.smallOpening.status)
    ) {
      log.warn(
        `[Render] モデル${modelSource}: RC壁小開口deflection production ${renderPlan.production.smallOpening.status}（${renderPlan.production.smallOpening.reason || 'reason-unavailable'}）`,
      );
    }
    if (
      memberKey === 'slab' &&
      renderPlan.production?.smallOpening &&
      !['READY', 'NOT_CONFIGURED'].includes(renderPlan.production.smallOpening.status)
    ) {
      log.warn(
        `[Render] モデル${modelSource}: RCスラブ小開口deflection production ${renderPlan.production.smallOpening.status}（${renderPlan.production.smallOpening.reason || 'reason-unavailable'}）`,
      );
    }
    if (renderPlan.specialCount > 0) {
      const specialUnit = memberKey === 'slab' || memberKey === 'wall' ? '枚' : '基';
      const codes = [
        ...new Set(
          renderPlan.checks.filter((check) => check.specialRequired).map((check) => check.code),
        ),
      ];
      log.warn(
        `[Render] モデル${modelSource}: ${REBAR_MEMBERS[memberKey].label}配筋 ${renderPlan.specialCount}${specialUnit}をSPECIAL_REQUIREDとして除外（${codes.join(', ')}）`,
      );
    }
    if (renderPlan.paths.length === 0) {
      log.info(
        `[Render] モデル${modelSource}: ${REBAR_MEMBERS[memberKey].label}${kind.label}の3D配置可能な配筋情報が見つかりません`,
      );
      return [];
    }
    const rebarKind =
      memberKey === 'slab'
        ? 'slabMain'
        : memberKey === 'wall'
          ? 'wallMain'
          : memberKey === 'footing'
            ? 'foundationMain'
            : 'stripFootingMain';
    return createColumnJointRebarMeshes(renderPlan.paths, {
      ...(options || {}),
      modelSource,
      rebarKind,
    });
  }

  if (memberKey === 'pile') {
    const pileLayouts = cachedRebarFact(xmlDoc, options, 'pile.sectionLayouts', () =>
      buildPileRebarSectionMap(xmlDoc, options),
    );
    if (pileLayouts.size === 0) {
      log.info(
        `[Render] モデル${modelSource}: ${REBAR_MEMBERS[memberKey].label}${kind.label}の配筋情報が見つかりません`,
      );
      return [];
    }

    const stbData = parseStbFile(xmlDoc, parseOptions);
    const nodes = stbData?.nodes;
    const pileElements = stbData?.pileElements || [];
    return kind.createPileMeshes(pileElements, nodes, pileLayouts, {
      ...(options || {}),
      modelSource,
      xmlDoc,
    });
  }

  const columnLayouts =
    memberKey === 'column'
      ? cachedRebarFact(
          xmlDoc,
          options,
          kindKey === 'main' ? 'column.main.layouts' : 'column.hoop.memberLayouts',
          () =>
            kind.buildColumnLayouts(xmlDoc, {
              ...options,
              projectDetailing,
              modelSource,
            }),
        )
      : kind.withAnchorage
        ? cachedRebarFact(xmlDoc, options, 'column.main.anchorageLayouts', () =>
            buildAnchorageColumnLayouts(xmlDoc, options),
          )
        : new Map();
  const beamLayouts = cachedRebarFact(
    xmlDoc,
    options,
    kindKey === 'main' ? 'beam.main.layouts' : 'beam.hoop.memberLayouts',
    () => kind.buildBeamLayouts(xmlDoc, options),
  );
  const scanTag = kind.withAnchorage ? cachedScanTag(xmlDoc, options) : null;

  const topStoryColumnHeadRenderPlan =
    kind.withAnchorage && memberKey === 'column'
      ? buildTopStoryColumnHeadRenderPlan(xmlDoc, beamLayouts.girder, {
          scanTag,
          projectDetailing,
          modelSource,
        })
      : null;
  const hasStandaloneSpecialPaths = Boolean(topStoryColumnHeadRenderPlan?.paths?.length);

  if (
    selectedLayoutSize(memberKey, columnLayouts, beamLayouts) === 0 &&
    !hasStandaloneSpecialPaths
  ) {
    log.info(
      `[Render] モデル${modelSource}: ${REBAR_MEMBERS[memberKey].label}${kind.label}の配筋情報が見つかりません`,
    );
    return [];
  }

  const stbData = parseStbFile(xmlDoc, parseOptions);
  const nodes = stbData?.nodes;
  const columnElements = stbData?.columnElements || [];
  const girderElements = stbData?.girderElements || [];
  const beamElements = stbData?.beamElements || [];
  const meshes = [];
  const placementGirderJointRenderPlan =
    kind.withAnchorage &&
    beamLayouts.girder.size > 0 &&
    (memberKey === 'girder' || placementConflictProductionRequested)
      ? cachedRebarFact(xmlDoc, options, `girder.jointRenderPlan.${modelSource}`, () =>
          buildGirderJointRenderPlan(xmlDoc, beamLayouts.girder, columnLayouts, {
            scanTag,
            projectDetailing,
            modelSource,
          }),
        )
      : null;
  const girderJointRenderPlan = memberKey === 'girder' ? placementGirderJointRenderPlan : null;
  const placementGirderHaunchRenderPlan =
    kind.withAnchorage &&
    beamLayouts.girder.size > 0 &&
    (memberKey === 'girder' || placementConflictProductionRequested)
      ? buildGirderHaunchRenderPlan(xmlDoc, beamLayouts.girder, {
          scanTag,
          projectDetailing,
          jointTransitionPlan: placementGirderJointRenderPlan,
        })
      : null;
  const girderHaunchRenderPlan = memberKey === 'girder' ? placementGirderHaunchRenderPlan : null;
  const appendixA2VerticalPlacementPlan =
    kind.withAnchorage && memberKey === 'girder'
      ? buildAppendixA2BeamVerticalPlacementPlan(xmlDoc, {
          beamLayoutMaps: beamLayouts,
          columnLayoutMap: columnLayouts,
        })
      : null;
  const beamAnchoragesForRender =
    kind.withAnchorage && memberKey !== 'column'
      ? cachedRebarFact(xmlDoc, options, 'beam.anchorages', () =>
          buildBeamAnchorageMaps(
            xmlDoc,
            beamLayouts,
            { ...options, projectDetailing },
            scanTag,
            columnLayouts,
          ),
        )
      : null;
  const anchoragesForPlacementGate =
    placementGirderJointRenderPlan && beamAnchoragesForRender
      ? applyGirderJointAnchorageSuppression(
          beamAnchoragesForRender,
          placementGirderJointRenderPlan,
        )
      : beamAnchoragesForRender;
  const anchoragesAfterVerticalPlacement =
    appendixA2VerticalPlacementPlan && anchoragesForPlacementGate
      ? applyAppendixA2VerticalPlacementToAnchorageMaps(
          anchoragesForPlacementGate,
          appendixA2VerticalPlacementPlan,
        )
      : anchoragesForPlacementGate;
  const beamCutoffsForRender =
    kind.withAnchorage && memberKey !== 'column'
      ? cachedRebarFact(xmlDoc, options, 'beam.cutoffs', () =>
          buildBeamCutoffMaps(xmlDoc, beamLayouts, scanTag),
        )
      : null;
  const foundationBeamAnchorageRenderPlanBase =
    kind.withAnchorage && (memberKey === 'girder' || placementConflictProductionRequested)
      ? cachedRebarFact(xmlDoc, options, 'foundationBeam.anchorageRenderPlan2023', () =>
          buildFoundationBeamAnchorageRenderPlan2023(
            xmlDoc,
            beamLayouts.girder,
            { ...options, scanTag },
            scanTag,
          ),
        )
      : null;
  const foundationBeamCountDifferenceSnapshot =
    foundationBeamAnchorageRenderPlanBase &&
    (beamLayouts.girder.size > 0 || beamLayouts.beam.size > 0)
      ? cachedRebarFact(
          xmlDoc,
          options,
          `foundationBeam.countDifference.production.${modelSource}`,
          () =>
            buildFoundationBeamCountDifferenceSnapshot(xmlDoc, beamLayouts, {
              ...options,
              scanTag,
              projectDetailing,
              modelSource,
            }),
        )
      : null;
  const foundationBeamAnchorageRenderPlan =
    foundationBeamAnchorageRenderPlanBase && foundationBeamCountDifferenceSnapshot
      ? applyFoundationBeamCountDifferenceAnchorageProductionGate(
          foundationBeamAnchorageRenderPlanBase,
          foundationBeamCountDifferenceSnapshot,
        )
      : foundationBeamAnchorageRenderPlanBase;
  const rebarPlacementConflictPlan = placementConflictProductionRequested
    ? cachedRebarFact(xmlDoc, options, 'rebar.placementConflictProductionPlan', () =>
        buildRebarPlacementConflictProductionPlan(xmlDoc, {
          ...options,
          scanTag,
          beamLayoutMaps: beamLayouts,
          columnLayouts,
          projectDetailing,
          modelSource,
          jointTransitionPlan: placementGirderJointRenderPlan,
          haunchTransitionPlan: placementGirderHaunchRenderPlan,
          anchoragePieceMaps: anchoragesAfterVerticalPlacement,
          cutoffPieceMaps: beamCutoffsForRender,
          foundationBeamAnchorageRenderPlan,
        }),
      )
    : null;
  const anchoragesAfterPlacementConflict =
    rebarPlacementConflictPlan && anchoragesAfterVerticalPlacement
      ? applyRebarPlacementConflictPlanToAnchorageMaps(
          anchoragesAfterVerticalPlacement,
          rebarPlacementConflictPlan,
        )
      : anchoragesAfterVerticalPlacement;

  if (memberKey === 'column') {
    const hasColumnLayouts = columnLayouts.size > 0;
    const jointRenderPlan =
      kind.withAnchorage && hasColumnLayouts
        ? cachedRebarFact(xmlDoc, options, 'column.jointRenderPlan.display', () =>
            buildColumnJointRenderPlan(xmlDoc, columnLayouts, beamLayouts, {
              scanTag,
              projectDetailing,
              modelSource,
            }),
          )
        : null;
    const columnMeshOptions = kind.withAnchorage
      ? { modelSource, xmlDoc, scanTag, jointRenderPlan }
      : { modelSource };
    if (hasColumnLayouts) {
      meshes.push(
        ...kind.createColumnMeshes(columnElements, nodes, columnLayouts, columnMeshOptions),
      );
    }
    if (jointRenderPlan) {
      meshes.push(...createColumnJointRebarMeshes(jointRenderPlan.paths, { modelSource }));
    }
    if (topStoryColumnHeadRenderPlan?.paths?.length) {
      meshes.push(
        ...createColumnJointRebarMeshes(topStoryColumnHeadRenderPlan.paths, {
          modelSource,
          rebarKind: 'columnHeadInternalRestraint',
        }),
      );
    }
  } else {
    const elements = memberKey === 'girder' ? girderElements : beamElements;
    meshes.push(
      ...kind.createBeamMeshes(elements, nodes, beamLayouts[memberKey], {
        ...(options || {}),
        modelSource,
        xmlDoc,
        scanTag,
        jointTransitionPlan: girderJointRenderPlan,
        haunchTransitionPlan: girderHaunchRenderPlan,
        appendixA2VerticalPlacementPlan,
        rebarPlacementConflictPlan,
        foundationBeamAnchorageRenderPlan,
        appendixA2CornerAnchorageMap:
          memberKey === 'girder' ? anchoragesAfterPlacementConflict?.girder || null : null,
        appendixA2MemberTag: memberKey === 'girder' ? 'StbGirder' : 'StbBeam',
        projectDetailing,
      }),
    );
    if (girderJointRenderPlan?.paths?.length) {
      meshes.push(
        ...createColumnJointRebarMeshes(girderJointRenderPlan.paths, {
          modelSource,
          rebarKind: 'girderTransition',
        }),
      );
    }
  }

  if (!kind.withAnchorage) return meshes;

  if (memberKey === 'column') {
    if (columnLayouts.size > 0) {
      const columnAnchorages = cachedRebarFact(xmlDoc, options, 'column.anchorages.display', () =>
        buildColumnAnchorageMaps(xmlDoc, columnLayouts, options, scanTag),
      );
      meshes.push(
        ...createRebarPieceMeshes(columnElements, nodes, columnLayouts, columnAnchorages.columns, {
          modelSource,
          rebarKind: 'columnAnchorage',
          memberType: 'column',
        }),
      );
    }
    return meshes;
  }

  const anchorages = anchoragesAfterPlacementConflict;
  const girderHangerRenderPlan =
    memberKey === 'girder'
      ? buildGirderHangerRenderPlan(anchorages.checks, { projectDetailing, modelSource })
      : null;
  if (girderHangerRenderPlan?.paths?.length) {
    meshes.push(
      ...createColumnJointRebarMeshes(girderHangerRenderPlan.paths, {
        modelSource,
        rebarKind: 'girderHangerRebar',
      }),
    );
  }

  const cutoffs = beamCutoffsForRender;
  const elements = memberKey === 'girder' ? girderElements : beamElements;
  const layouts = beamLayouts[memberKey];

  for (const pieces of [anchorages[memberKey], cutoffs[memberKey]]) {
    meshes.push(
      ...createRebarPieceMeshes(elements, nodes, layouts, pieces, {
        modelSource,
        rebarKind: 'beamAnchorage',
        memberType: memberKey,
      }),
    );
  }

  return meshes;
}
