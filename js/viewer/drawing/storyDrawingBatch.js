/**
 * @fileoverview 全階DXF用のDrawingRenderPlan compile境界。
 *
 * Three.js scene / camera / clipping stateを参照せず、STB原本Documentから
 * 各階のDrawingModel -> DrawingRenderPlanを生成する。
 */
import { buildStbPlanDrawing } from './stbPlanDrawing.js';
import { createDrawingSheetLayout, createDrawingSheetRenderPlan } from './drawingSheetLayout.js';
import { createStoryPlanView } from '../../data/drawing/storyPlanView.js';
import {
  canCompileStoryBatchSelection,
  createStoryBatchDisplaySettings,
  isOpenOnlyStoryBatchSelection,
} from '../../data/drawing/storyBatchContract.js';

export const STORY_BATCH_RENDER_PROFILE_ID = 'sdv-story-batch-v1';
export const DEFAULT_STORY_BATCH_SCALE_DENOMINATOR = 200;
export const DEFAULT_STORY_BATCH_LABEL_HEIGHT_MODEL_MM = 200;

function assertSelectedDrawingCoverage(drawing, selectedElementTypes, storyId) {
  // Open単独は親Wallが開口の抽出元。Wall抽出失敗で開口をsilent dropしない。
  const selectedPrimaryTypes = new Set(
    selectedElementTypes.map((type) => (type === 'Open' ? 'Wall' : type)),
  );
  const failed = (drawing?.elements || []).filter(
    (element) => element?.state === 'failed' && selectedPrimaryTypes.has(element?.ref?.elementType),
  );
  if (failed.length === 0) return;

  const sample = failed
    .slice(0, 5)
    .map((element) => element.key || `${element.ref?.elementType}:${element.ref?.elementId}`)
    .join(', ');
  const remainder = failed.length > 5 ? ` 他${failed.length - 5}件` : '';
  throw new Error(
    `階 ${storyId} の選択部材抽出に失敗しました（${failed.length}件）: ${sample}${remainder}`,
  );
}

/**
 * 1階分のDrawingRenderPlanをpureに生成する。
 * DXF等の形式変換・download・現在のviewer状態変更は呼出し側の責務。
 */
export async function compileStoryDrawingRenderPlan({
  document,
  source,
  stories,
  storyId,
  selectedElementTypes,
  includeLabels = true,
  includeAxes = true,
  labelHeight = DEFAULT_STORY_BATCH_LABEL_HEIGHT_MODEL_MM,
  scaleDenominator = DEFAULT_STORY_BATCH_SCALE_DENOMINATOR,
  buildDrawing = buildStbPlanDrawing,
  createLayout = createDrawingSheetLayout,
  createRenderPlan = createDrawingSheetRenderPlan,
} = {}) {
  if (document?.nodeType !== 9 || document.documentElement?.localName !== 'ST_BRIDGE') {
    throw new TypeError('ST_BRIDGE Documentが必要です。');
  }
  if (
    !source ||
    !['A', 'B'].includes(source.modelKey) ||
    typeof source.modelRevision !== 'string' ||
    !source.modelRevision
  ) {
    throw new TypeError('モデルA/BとmodelRevisionを含むsourceが必要です。');
  }
  const selection = canCompileStoryBatchSelection(selectedElementTypes);
  if (!selection.canCompile) throw new TypeError(selection.reason);

  const scale = Number(scaleDenominator);
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('縮尺分母が不正です。');
  const modelTextHeight = Number(labelHeight);
  if (!Number.isFinite(modelTextHeight) || modelTextHeight <= 0)
    throw new RangeError('符号文字高さが不正です。');

  const view = createStoryPlanView(stories, storyId);
  const openOnly = isOpenOnlyStoryBatchSelection(selectedElementTypes);
  const drawing = await buildDrawing({
    document,
    source,
    view,
    ...(openOnly ? { openingVisibilitySource: 'Open' } : {}),
  });
  assertSelectedDrawingCoverage(drawing, selectedElementTypes, view.storyId);
  if (!drawing?.bounds) {
    throw new Error(`階 ${view.storyId} にDXF出力可能な図形がありません。`);
  }

  const layout = createLayout({
    drawing,
    scaleDenominator: scale,
  });
  const displaySettings = createStoryBatchDisplaySettings(selectedElementTypes, { includeAxes });
  const renderPlan = createRenderPlan({
    drawing,
    layout,
    displaySettings,
    showLabels: includeLabels !== false,
    profileId: STORY_BATCH_RENDER_PROFILE_ID,
    genericTextHeightPaperMm: modelTextHeight / scale,
  });
  return Object.freeze({
    storyId: view.storyId,
    view,
    drawing,
    layout,
    renderPlan,
  });
}
