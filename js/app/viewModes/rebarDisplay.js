/**
 * @fileoverview 3D配筋表示のオーケストレーション
 *
 * STB文書からRC柱・RC梁・RC場所打ち杭の断面内配置を求め（data層）、
 * 部材要素・節点に載せて3Dメッシュを生成し（viewer層）、
 * 鉄筋表示グループへ差し込む。
 *
 * 表示単位は「柱・大梁・小梁・杭」を上位とし、その内部で主筋（main）と
 * 帯筋・あばら筋（hoop）を別グループとして保持する。
 *
 * ST-Bridgeには鉄筋の3次元位置が含まれないため、表示されるのは
 * かぶり・dt から構成した想定配置である。
 *
 * @module app/viewModes/rebarDisplay
 */

import { createLogger } from '../../utils/logger.js';
import { eventBus } from '../../data/events/eventBus.js';
import { EditEvents, FinalizationEvents } from '../../constants/eventTypes.js';
import { applyColorModeToAllObjects } from '../../colorModes/applyColorMode.js';
import { setRebarGhostActive } from '../../colorModes/modelSourceMapping.js';
import { getRebarProjectDetailing } from '../../config/rebarProjectDetailing.js';
import editingSession from '../editing/editingSession.js';
import { getModelContext } from './modelContext.js';
import { createBeamStirrupMemberMeshes } from './beamStirrupDisplayAdapter.js';
import { createRebarModelMeshes } from './rebarModelMeshBuilder.js';
import { createColumnHoopMemberMeshes } from './columnHoopDisplayAdapter.js';
import { buildColumnJointRenderPlan } from '../../data/extractors/rebar3d/columnJointRenderPlan.js';
import {
  applyGirderJointAnchorageSuppression,
  buildGirderJointRenderPlan,
} from '../../data/extractors/rebar3d/girderJointTransitionRenderPlan.js';
import { buildColumnRebarLayoutMap } from '../../data/extractors/rebar3d/columnRebarPlacement.js';
import { buildBeamRebarLayoutMaps } from '../../data/extractors/rebar3d/beamRebarPlacement.js';
import { buildBeamAnchorageMaps } from '../../data/extractors/rebar3d/beamAnchoragePlacement.js';
import { buildBeamCutoffMaps } from '../../data/extractors/rebar3d/beamCutoffPlacement.js';
import { buildGirderHangerRenderPlan } from '../../data/extractors/rebar3d/girderHangerRenderPlan.js';
import { buildGirderHaunchRenderPlan } from '../../data/extractors/rebar3d/girderHaunchRenderPlan.js';
import { buildTopStoryColumnHeadRenderPlan } from '../../data/extractors/rebar3d/topStoryColumnHeadRenderPlan.js';
import { attachSpecialDetailingProductionGate } from '../../data/extractors/rebar3d/specialDetailingProductionGate.js';
import { buildColumnAnchorageMaps } from '../../data/extractors/rebar3d/columnAnchoragePlacement.js';
import { buildBeamStirrupMemberLayoutMaps } from '../../data/extractors/rebar3d/beamStirrupMemberPlacement.js';
import { buildColumnHoopMemberLayoutMap } from '../../data/extractors/rebar3d/columnHoopMemberPlacement.js';
import { withRebarModelIndexScopes } from '../../data/extractors/rebar3d/rebarModelIndex.js';
import {
  createRebarFactsGenerationKey,
  getOrBuildRebarFact,
  invalidateAllRebarFactsCaches,
  invalidateRebarFactsCache,
} from '../../data/extractors/rebar3d/rebarFactsCache.js';
import { createTagScanner } from '../../data/extractors/columnSupportUtils.js';
import {
  createBeamRebarMeshes,
  createColumnMainMemberMeshes,
  createPileBandMeshes,
  createPileMainRebarMeshes,
  getRebarDisplayManager,
  requestRender,
  scene,
} from '../../viewer/index.js';

const log = createLogger('rebarDisplay');

const REBAR_MEMBERS = {
  column: { label: 'RC柱' },
  girder: { label: 'RC大梁' },
  beam: { label: 'RC小梁' },
  pile: { label: 'RC場所打ち杭' },
  slab: { label: 'RCスラブ', kinds: ['main'] },
  wall: { label: 'RC壁', kinds: ['main'] },
  footing: { label: 'RC基礎', kinds: ['main'] },
  stripFooting: { label: 'RC布基礎', kinds: ['main'] },
};

const REBAR_KINDS = {
  main: {
    label: '主筋',
    buildColumnLayouts: buildColumnRebarLayoutMap,
    buildBeamLayouts: buildBeamRebarLayoutMaps,
    createColumnMeshes: createColumnMainMemberMeshes,
    createBeamMeshes: createBeamRebarMeshes,
    createPileMeshes: createPileMainRebarMeshes,
    withAnchorage: true,
  },
  hoop: {
    label: '帯筋・あばら筋',
    buildColumnLayouts: buildColumnHoopMemberLayoutMap,
    buildBeamLayouts: buildBeamStirrupMemberLayoutMaps,
    createColumnMeshes: createColumnHoopMemberMeshes,
    createBeamMeshes: createBeamStirrupMemberMeshes,
    createPileMeshes: createPileBandMeshes,
  },
};

const REBAR_MEMBER_KEYS = Object.keys(REBAR_MEMBERS);
const REBAR_KIND_KEYS = Object.keys(REBAR_KINDS);
const lastOptions = new Map();
const requestedGroups = new Set();
const activeGroups = new Set();
let syncInitialized = false;
let onRebarHidden = null;

function groupKey(memberKey, kindKey) {
  return `${memberKey}.${kindKey}`;
}

function splitGroupKey(key) {
  const [memberKey, kindKey] = String(key).split('.');
  return { memberKey, kindKey };
}

function isKnownMember(memberKey) {
  return Boolean(REBAR_MEMBERS[memberKey]);
}

function isKnownKind(kindKey) {
  return Boolean(REBAR_KINDS[kindKey]);
}

function supportedKindKeys(memberKey) {
  const configured = REBAR_MEMBERS[memberKey]?.kinds;
  return Array.isArray(configured) ? configured.filter(isKnownKind) : REBAR_KIND_KEYS;
}

function syncRebarGhostMaterial(manager) {
  const active = manager.isAnyVisible();
  if (!setRebarGhostActive(active)) return;
  applyColorModeToAllObjects(active ? 'RebarGhostOn' : 'RebarGhostOff');
  requestRender();
}

function selectedLayoutSize(memberKey, columnLayouts, beamLayouts) {
  if (memberKey === 'column') return columnLayouts.size;
  return beamLayouts[memberKey]?.size || 0;
}

function buildAnchorageColumnLayouts(xmlDoc, options = {}) {
  const columnCoverMm = Number(options.columnCoverMm);
  return buildColumnRebarLayoutMap(
    xmlDoc,
    Number.isFinite(columnCoverMm) ? { coverMm: columnCoverMm } : {},
  );
}

function resolveProjectDetailing(options = {}) {
  return options.projectDetailing === undefined
    ? getRebarProjectDetailing()
    : options.projectDetailing;
}

function resolveRebarModelContext() {
  const context = getModelContext();
  const editing = editingSession.getState();
  if (!editing?.active || !editing.workingDocument) return context;
  return {
    ...context,
    modelADocument: editing.workingDocument,
    workingDocument: true,
  };
}

export function resolveRebarFactsGenerationKey(xmlDoc, options = {}) {
  const editing = editingSession.getState();
  const isWorkingDocument =
    editing?.active && editing.workingDocument && editing.workingDocument === xmlDoc;
  const documentRevision = isWorkingDocument
    ? `working:${editing.sessionId}:${editing.workingRevision}`
    : 'source:0';
  return createRebarFactsGenerationKey(xmlDoc, options, { documentRevision });
}

function cachedRebarFact(xmlDoc, options, factName, builder) {
  // Caller-supplied projectDetailing is an ephemeral explicit override object and is
  // intentionally excluded from the stable generation key. Reusing cached facts
  // across two different explicit objects could silently apply a stale L0 pairing.
  // The mesh-retention layer already treats this option as non-retainable, so bypass
  // the facts cache as well. Runtime project detailing still uses its revision key.
  if (options?.projectDetailing !== undefined) return builder();
  return getOrBuildRebarFact(
    xmlDoc,
    resolveRebarFactsGenerationKey(xmlDoc, options),
    factName,
    builder,
  );
}

function cachedScanTag(xmlDoc, options) {
  return cachedRebarFact(xmlDoc, options, 'scanTag', () => createTagScanner(xmlDoc));
}

function withContextIndexScopes(context, callback) {
  return withRebarModelIndexScopes([context?.modelADocument, context?.modelBDocument], callback);
}

function createMeshesForModel(
  xmlDoc,
  modelSource,
  options,
  memberKey,
  kindKey,
  parseOptions = { modelKey: modelSource },
) {
  return createRebarModelMeshes(xmlDoc, modelSource, options, memberKey, kindKey, parseOptions, {
    REBAR_MEMBERS,
    REBAR_KINDS,
    cachedRebarFact,
    cachedScanTag,
    buildAnchorageColumnLayouts,
    selectedLayoutSize,
    resolveProjectDetailing,
  });
}

export function collectRebarAnchorageChecks(options = {}) {
  const projectDetailing = resolveProjectDetailing(options);
  const context = resolveRebarModelContext();
  const { modelADocument, modelBDocument } = context;
  const checks = [];

  return withContextIndexScopes(context, () => {
    for (const [modelSource, xmlDoc] of [
      ['A', modelADocument],
      ['B', modelBDocument],
    ]) {
      if (!xmlDoc) continue;

      const beamLayouts = cachedRebarFact(xmlDoc, options, 'beam.main.layouts', () =>
        buildBeamRebarLayoutMaps(xmlDoc, options),
      );
      const columnLayouts = cachedRebarFact(xmlDoc, options, 'column.main.anchorageLayouts', () =>
        buildAnchorageColumnLayouts(xmlDoc, options),
      );
      const modelChecks = [];
      const scanTag = cachedScanTag(xmlDoc, options);
      const girderJointRenderPlan = beamLayouts.girder.size
        ? cachedRebarFact(xmlDoc, options, `girder.jointRenderPlan.${modelSource}`, () =>
            buildGirderJointRenderPlan(xmlDoc, beamLayouts.girder, columnLayouts, {
              scanTag,
              projectDetailing,
              modelSource,
            }),
          )
        : null;
      const girderHaunchRenderPlan = buildGirderHaunchRenderPlan(xmlDoc, beamLayouts.girder, {
        scanTag,
        projectDetailing,
        jointTransitionPlan: girderJointRenderPlan,
      });
      const topStoryColumnHeadRenderPlan = buildTopStoryColumnHeadRenderPlan(
        xmlDoc,
        beamLayouts.girder,
        { scanTag, projectDetailing, modelSource },
      );
      if (beamLayouts.girder.size > 0 || beamLayouts.beam.size > 0) {
        const rawAnchorages = cachedRebarFact(xmlDoc, options, 'beam.anchorages', () =>
          buildBeamAnchorageMaps(
            xmlDoc,
            beamLayouts,
            { ...options, projectDetailing },
            scanTag,
            columnLayouts,
          ),
        );
        const anchorages = girderJointRenderPlan
          ? applyGirderJointAnchorageSuppression(rawAnchorages, girderJointRenderPlan)
          : rawAnchorages;
        const girderHangerRenderPlan = buildGirderHangerRenderPlan(anchorages.checks, {
          projectDetailing,
          modelSource,
        });
        modelChecks.push(
          ...girderHangerRenderPlan.checks,
          ...cachedRebarFact(xmlDoc, options, 'beam.cutoffs', () =>
            buildBeamCutoffMaps(xmlDoc, beamLayouts, scanTag),
          ).checks,
        );
      }
      modelChecks.push(...girderHaunchRenderPlan.checks);
      modelChecks.push(...topStoryColumnHeadRenderPlan.checks);
      if (girderJointRenderPlan) modelChecks.push(...girderJointRenderPlan.checks);
      if (columnLayouts.size > 0) {
        const columnAnchorages = cachedRebarFact(xmlDoc, options, 'column.anchorages.checks', () =>
          buildColumnAnchorageMaps(xmlDoc, columnLayouts, options, scanTag),
        );
        const columnJointRenderPlan = cachedRebarFact(
          xmlDoc,
          options,
          'column.jointRenderPlan.checks',
          () =>
            buildColumnJointRenderPlan(xmlDoc, columnLayouts, beamLayouts, {
              scanTag,
              projectDetailing,
              modelSource,
            }),
        );
        modelChecks.push(...columnAnchorages.checks, ...columnJointRenderPlan.checks);
      }
      checks.push(
        ...modelChecks.map((check) => ({
          modelSource,
          ...attachSpecialDetailingProductionGate(check, { projectDetailing }),
        })),
      );
    }
    return checks;
  });
}

function rebuildRebarGroup(options, memberKey, kindKey, contextOverride = null) {
  const manager = getRebarDisplayManager(scene);
  if (!manager || !isKnownMember(memberKey) || !isKnownKind(kindKey)) {
    log.warn('RebarDisplayManagerまたは配筋表示キーが不正です');
    return 0;
  }

  const key = groupKey(memberKey, kindKey);
  lastOptions.set(key, options);
  const context = contextOverride || resolveRebarModelContext();
  const { modelADocument, modelBDocument } = context;
  const modelAParseOptions = context.workingDocument ? {} : { modelKey: 'A' };

  return withContextIndexScopes(context, () => {
    const meshes = [
      ...createMeshesForModel(modelADocument, 'A', options, memberKey, kindKey, modelAParseOptions),
      ...createMeshesForModel(modelBDocument, 'B', options, memberKey, kindKey, { modelKey: 'B' }),
    ];

    manager.setMeshes(meshes, key);
    return meshes.length;
  });
}

function setGroupVisible(visible, options, memberKey, kindKey) {
  const manager = getRebarDisplayManager(scene);
  if (!manager) return false;

  const key = groupKey(memberKey, kindKey);
  if (!visible) {
    requestedGroups.delete(key);
    manager.setVisible(false, key);
    activeGroups.delete(key);
    return false;
  }

  requestedGroups.add(key);
  const meshCount = rebuildRebarGroup(options, memberKey, kindKey);
  const shown = meshCount > 0;
  manager.setVisible(shown, key);
  if (shown) activeGroups.add(key);
  else activeGroups.delete(key);
  return shown;
}

export function setRebarMemberVisible(visible, options = {}, memberKey = 'column') {
  const manager = getRebarDisplayManager(scene);
  if (!manager || !isKnownMember(memberKey)) {
    log.warn('RebarDisplayManagerまたは部材カテゴリが不正です');
    return false;
  }

  const run = () => {
    let shown = false;
    for (const kindKey of supportedKindKeys(memberKey)) {
      shown = setGroupVisible(visible, options, memberKey, kindKey) || shown;
    }

    syncRebarGhostMaterial(manager);
    requestRender();
    return visible ? shown : false;
  };

  if (!visible) return run();
  return withContextIndexScopes(resolveRebarModelContext(), run);
}

export function setRebarDisplayVisible(visible, options = {}, kindKey = 'main') {
  const manager = getRebarDisplayManager(scene);
  if (!manager || !isKnownKind(kindKey)) {
    log.warn('RebarDisplayManagerまたは鉄筋種別が不正です');
    return false;
  }

  const run = () => {
    let shown = false;
    for (const memberKey of REBAR_MEMBER_KEYS) {
      if (!supportedKindKeys(memberKey).includes(kindKey)) continue;
      shown = setGroupVisible(visible, options, memberKey, kindKey) || shown;
    }

    syncRebarGhostMaterial(manager);
    requestRender();
    return visible ? shown : false;
  };

  if (!visible) return run();
  return withContextIndexScopes(resolveRebarModelContext(), run);
}

function clearRebarGroup(memberKey, kindKey) {
  const manager = getRebarDisplayManager(scene);
  if (manager) manager.clear(groupKey(memberKey, kindKey));
}

export function refreshVisibleRebarGroups(contextOverride = null) {
  const manager = getRebarDisplayManager(scene);
  if (!manager) return 0;

  const context = contextOverride || resolveRebarModelContext();
  return withContextIndexScopes(context, () => {
    let meshCount = 0;
    for (const memberKey of REBAR_MEMBER_KEYS) {
      for (const kindKey of supportedKindKeys(memberKey)) {
        const key = groupKey(memberKey, kindKey);
        if (!requestedGroups.has(key)) continue;

        const count = rebuildRebarGroup(lastOptions.get(key) || {}, memberKey, kindKey, context);
        meshCount += count;
        const shown = count > 0;
        manager.setVisible(shown, key);
        if (shown) activeGroups.add(key);
        else activeGroups.delete(key);
      }
    }

    syncRebarGhostMaterial(manager);
    requestRender();
    return meshCount;
  });
}

export function initializeRebarDisplaySync(onHidden = null) {
  if (syncInitialized) return;
  syncInitialized = true;
  onRebarHidden = onHidden;

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('rebar-detailing-choice-changed', () => {
      if (requestedGroups.size === 0) return;
      refreshVisibleRebarGroups();
    });
  }

  eventBus.on(FinalizationEvents.COMPLETED, () => {
    invalidateAllRebarFactsCaches();
    const manager = getRebarDisplayManager(scene);
    if (!manager) return;

    const activeBefore = [...activeGroups];
    const membersBefore = new Set(activeBefore.map((key) => splitGroupKey(key).memberKey));

    for (const memberKey of REBAR_MEMBER_KEYS) {
      for (const kindKey of supportedKindKeys(memberKey)) {
        const key = groupKey(memberKey, kindKey);
        if (!requestedGroups.has(key)) {
          manager.setVisible(false, key);
          clearRebarGroup(memberKey, kindKey);
        }
      }
    }

    refreshVisibleRebarGroups();

    for (const memberKey of membersBefore) {
      const stillVisible = supportedKindKeys(memberKey).some((kindKey) =>
        activeGroups.has(groupKey(memberKey, kindKey)),
      );
      if (!stillVisible && onRebarHidden) onRebarHidden(memberKey);
    }
  });

  eventBus.on(EditEvents.WORKING_DOCUMENT_CHANGED, ({ targetDocument } = {}) => {
    if (targetDocument) invalidateRebarFactsCache(targetDocument);
    if (!targetDocument || requestedGroups.size === 0) return;
    const context = getModelContext();
    refreshVisibleRebarGroups({
      ...context,
      modelADocument: targetDocument,
      workingDocument: true,
    });
  });
}
