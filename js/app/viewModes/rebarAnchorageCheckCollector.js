/**
 * @fileoverview 既存の定着チェックにR12小梁requirement / R12-N投影判定行を加えるcollector。
 *
 * 既存の3D生成・判定経路は変更せず、小梁factsだけを表示用に追加する。
 */

import {
  collectRebarAnchorageChecks as collectBaseRebarAnchorageChecks,
  resolveRebarFactsGenerationKey,
} from './rebarDisplay.js';
import { getModelContext } from './modelContext.js';
import editingSession from '../editing/editingSession.js';
import { buildBeamRebarLayoutMaps } from '../../data/extractors/rebar3d/beamRebarPlacement.js';
import { getOrBuildRebarFact } from '../../data/extractors/rebar3d/rebarFactsCache.js';
import { buildSmallBeamSupportFacts } from '../../data/extractors/rebar3d/smallBeamSupportFacts.js';
import { buildSmallBeamAnchorageRequirementFacts } from '../../data/extractors/rebar3d/smallBeamAnchorageRequirementFacts.js';
import { buildSmallBeamAnchorageCheckRows } from '../../data/extractors/rebar3d/smallBeamAnchorageCheckRows.js';
import { attachSmallBeamVertical90CandidateFacts } from '../../data/extractors/rebar3d/smallBeamVerticalAnchorageCandidateFacts.js';
import { attachSmallBeamTopAnchorageModeFacts } from '../../data/extractors/rebar3d/smallBeamAnchorageModeFacts.js';
import { attachSmallBeamVertical90PathPlanFacts } from '../../data/extractors/rebar3d/smallBeamVerticalAnchoragePathPlanFacts.js';
import { attachSmallBeamVertical90ActualPathFacts } from '../../data/extractors/rebar3d/smallBeamVerticalAnchorageActualPathFacts.js';
import { attachSmallBeamVertical90ContinuityFacts } from '../../data/extractors/rebar3d/smallBeamVerticalAnchorageContinuity.js';
import { attachSmallBeamVertical90IdentityFacts } from '../../data/extractors/rebar3d/smallBeamVerticalAnchorageIdentity.js';
import { attachSmallBeamVertical90ProductionGateFacts } from '../../data/extractors/rebar3d/smallBeamVerticalAnchorageProductionGate.js';
import { createTagScanner } from '../../data/extractors/columnSupportUtils.js';
import {
  buildRebarModelIndex,
  withRebarModelIndexScopes,
} from '../../data/extractors/rebar3d/rebarModelIndex.js';

function collectSmallBeamRequirementChecks(xmlDoc, options = {}) {
  if (!xmlDoc) return [];
  const generationKey = resolveRebarFactsGenerationKey(xmlDoc, options);
  return getOrBuildRebarFact(xmlDoc, generationKey, 'smallBeam.requirementChecks', () => {
    const scanTag = getOrBuildRebarFact(xmlDoc, generationKey, 'scanTag', () =>
      createTagScanner(xmlDoc),
    );
    const modelIndex = buildRebarModelIndex(xmlDoc, { scanTag });
    const beamLayouts = getOrBuildRebarFact(xmlDoc, generationKey, 'beam.main.layouts', () =>
      buildBeamRebarLayoutMaps(xmlDoc, options),
    );
    const supportFacts = buildSmallBeamSupportFacts(xmlDoc, scanTag, modelIndex);
    let requirementFacts = buildSmallBeamAnchorageRequirementFacts(
      xmlDoc,
      beamLayouts,
      supportFacts,
      scanTag,
      { ...options, modelIndex },
    );
    requirementFacts = attachSmallBeamVertical90CandidateFacts(requirementFacts);
    requirementFacts = attachSmallBeamTopAnchorageModeFacts(requirementFacts);
    requirementFacts = attachSmallBeamVertical90PathPlanFacts(requirementFacts);
    requirementFacts = attachSmallBeamVertical90ActualPathFacts(requirementFacts);
    requirementFacts = attachSmallBeamVertical90ContinuityFacts(
      requirementFacts,
      beamLayouts,
      scanTag,
      modelIndex,
    );
    requirementFacts = attachSmallBeamVertical90IdentityFacts(requirementFacts);
    requirementFacts = attachSmallBeamVertical90ProductionGateFacts(requirementFacts);
    return buildSmallBeamAnchorageCheckRows(requirementFacts, supportFacts);
  });
}

function effectiveModelDocuments() {
  const { modelADocument, modelBDocument } = getModelContext();
  const editing = editingSession.getState();
  return {
    modelADocument:
      editing?.active && editing.workingDocument ? editing.workingDocument : modelADocument,
    modelBDocument,
  };
}

/**
 * 既存チェック＋R12小梁要件を返す。
 * R12-Nは上端Lb/B/2投影だけavailableMm / okを部分判定し、定着全体のOKとは扱わない。
 */
export function collectRebarAnchorageChecks(options = {}) {
  const { modelADocument, modelBDocument } = effectiveModelDocuments();
  return withRebarModelIndexScopes([modelADocument, modelBDocument], () => {
    // base collectorも同じ同期scope内に入り、その内部builderが作るModelIndexを共有する。
    const checks = collectBaseRebarAnchorageChecks(options);

    for (const [modelSource, xmlDoc] of [
      ['A', modelADocument],
      ['B', modelBDocument],
    ]) {
      if (!xmlDoc) continue;
      checks.push(
        ...collectSmallBeamRequirementChecks(xmlDoc, options).map((row) => ({
          modelSource,
          ...row,
        })),
      );
    }

    return checks;
  });
}
