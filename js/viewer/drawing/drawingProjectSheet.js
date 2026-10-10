/**
 * @fileoverview DrawingProjectの永続DrawingDocumentから現行DrawingModelをRenderPlanへcompileする。
 * DrawingProjectは保存正本、DrawingRenderPlanは毎回生成する派生物として分離する。
 */
import { normalizeDrawingProject } from '../../data/drawing/drawingProjectSchema.js';
import {
  compileDrawingProjectDimensions,
  createDrawingProjectTagPlacementResolver,
} from '../../data/drawing/drawingProjectRenderAdapter.js';
import { createDrawingSheetLayout, createDrawingSheetRenderPlan } from './drawingSheetLayout.js';

function requiredString(value, name) {
  if (value == null || !String(value).trim()) throw new TypeError(name + 'が必要です。');
  return String(value).trim();
}

function samePlanView(projectView, drawingView) {
  return (
    drawingView?.type === 'plan' &&
    projectView?.type === 'plan' &&
    String(drawingView.storyId) === String(projectView.storyId)
  );
}

function sourceRevision(project, document) {
  const slot = project.modelSlots.find((item) => item.id === document.modelSlotId);
  if (!slot) throw new Error('DrawingDocumentのmodelSlotがありません: ' + document.modelSlotId);
  const revision = slot.revisions.find((item) => item.id === document.sourceRevisionId);
  if (!revision)
    throw new Error('DrawingDocumentのsource revisionがありません: ' + document.sourceRevisionId);
  return revision;
}

/**
 * @returns {{project:Object,drawingDocument:Object,layout:Object,renderPlan:Object}}
 */
export function compileDrawingProjectSheet({
  project,
  drawingId,
  drawing,
  resolveTagFacts = null,
  showLabels = true,
  profileId = 'sdv-drawing-project-v1',
} = {}) {
  const normalized = normalizeDrawingProject(project);
  const id = requiredString(drawingId, 'drawingId');
  const document = normalized.drawingDocuments.find((item) => item.id === id);
  if (!document) throw new Error('DrawingDocumentがありません: ' + id);
  if (drawing?.schemaVersion !== 1 || drawing.units !== 'mm')
    throw new TypeError('DrawingProject compileにはDrawingModel v1(mm)が必要です。');

  const revision = sourceRevision(normalized, document);
  if (String(drawing.source?.modelRevision || '').toLowerCase() !== revision.sha256)
    throw new Error('DrawingModelのsource revisionがDrawingProjectと一致しません。');
  if (!samePlanView(document.view, drawing.view))
    throw new Error('DrawingModelのviewがDrawingDocumentと一致しません。');

  const layout = createDrawingSheetLayout({
    drawing,
    paper: document.sheet.paper,
    orientation: document.sheet.orientation,
    scaleDenominator: document.sheet.scaleDenominator,
    drawingRotationDeg: document.sheet.rotationDeg,
  });
  const resolveTagPlacement = createDrawingProjectTagPlacementResolver({
    project: normalized,
    drawingId: document.id,
    modelToPaper: layout.modelToPaper,
  });
  const projectDimensions = compileDrawingProjectDimensions({
    project: normalized,
    drawingId: document.id,
    drawing,
    modelToPaper: layout.modelToPaper,
    displaySettings: document.display,
  });
  // persistent dimensionがあるDrawingDocumentでは、STBから自動生成したtransient寸法と二重描画しない。
  const drawingForRender =
    projectDimensions.length === 0 ? drawing : { ...drawing, dimensionIntents: Object.freeze([]) };
  const renderPlan = createDrawingSheetRenderPlan({
    drawing: drawingForRender,
    layout,
    additionalDimensions: projectDimensions,
    displaySettings: document.display,
    showLabels,
    tagFamilyState: normalized.definitions.tagFamilyState,
    resolveTagFacts,
    resolveTagPlacement,
    tagOrientationMode: document.sheet.tagOrientationMode,
    profileId,
  });
  return Object.freeze({
    project: normalized,
    drawingDocument: document,
    layout,
    renderPlan,
  });
}
