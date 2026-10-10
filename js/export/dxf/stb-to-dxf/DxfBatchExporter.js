/**
 * @fileoverview DXFバッチエクスポートモジュール
 *
 * 全階エクスポート、通り芯沿いエクスポートなど、
 * 複数ファイルの一括エクスポート機能を提供します。
 */

import { createLogger } from '../../../utils/logger.js';
import {
  getCurrentStoriesInternal,
  getCurrentAxesDataInternal,
  getCurrentClippingStateInternal,
  applyStoryClipInternal,
  applyAxisClipInternal,
  clearAllClippingPlanesInternal,
  getLoadedFilenameInternal,
  getPlanDrawingSourceInternal,
  compileStoryDrawingRenderPlanInternal,
} from './DxfProviders.js';
import { canExportStbToDxf, exportStbToDxf } from './StbToDxfExporter.js';
import { canCompileStoryBatchSelection } from '../../../data/drawing/storyBatchContract.js';
import { downloadDrawingRenderPlanDxf } from '../DrawingRenderPlanDxfWriter.js';
import { sha256 } from '../../../utils/sha256.js';
import { eventBus, ToastEvents } from '../../../data/events/index.js';
import { parseStories } from '../../../common-stb/import/parser/stbParserCore.js';

const log = createLogger('DxfBatchExporter');

/** X軸→Y軸切り替え待機時間（ms） */
const AXIS_DIRECTION_SWITCH_DELAY_MS = 1000;

/**
 * File System Access APIでフォルダを選択する
 * @returns {Promise<{handle: FileSystemDirectoryHandle|null, cancelled: boolean}>}
 */
async function pickDirectoryHandle() {
  if (!('showDirectoryPicker' in window)) {
    log.info('File System Access API未対応ブラウザ、通常のダウンロード方式を使用');
    return { handle: null, cancelled: false };
  }
  try {
    const handle = await window.showDirectoryPicker({
      mode: 'readwrite',
      startIn: 'downloads',
    });
    log.info('保存先フォルダが選択されました:', handle.name);
    return { handle, cancelled: false };
  } catch (error) {
    if (error.name === 'AbortError') {
      log.info('フォルダ選択がキャンセルされました');
      return { handle: null, cancelled: true };
    }
    log.warn('File System Access API使用不可、通常のダウンロード方式を使用:', error);
    return { handle: null, cancelled: false };
  }
}

/**
 * クリッピング状態を復元する
 * @param {Object|null} state - 保存済みクリッピング状態
 */
async function restoreClippingState(state) {
  if (!state || !state.type) {
    clearAllClippingPlanesInternal();
    return;
  }
  if (state.type === 'xAxis') {
    await applyAxisClipInternal('X', state.id, state.range);
  } else if (state.type === 'yAxis') {
    await applyAxisClipInternal('Y', state.id, state.range);
  } else if (state.type === 'story') {
    await applyStoryClipInternal(state.id, state.range);
  } else {
    clearAllClippingPlanesInternal();
  }
}

/*
 * 全階をDXFエクスポート（階連続出力）
 * 各階ごとにDXFファイルを生成し、選択したフォルダに一括保存します。
 * @param {Array<string>} selectedElementTypes - 選択された要素タイプ
 * @param {Object} options - オプション
 * @param {number} [options.downloadDelay=100] - ダウンロード間隔（ミリ秒）
 * @returns {Promise<boolean>} 成功/失敗
 */
function serializeStbDocument(document) {
  if (typeof XMLSerializer !== 'function') {
    throw new Error('XMLSerializerが利用できないため全階DXFを生成できません。');
  }
  return new XMLSerializer().serializeToString(document);
}

function resolveStoryDrawingSource() {
  const source = getPlanDrawingSourceInternal();
  if (!source?.document) {
    return {
      canExport: false,
      reason: source?.reason || 'STB原本Documentが読み込まれていません。',
      source: null,
      // provider未初期化時は従来のscene-based batchを壊さない。
      // providerが明示したhard blockはallowLegacyFallback=falseのまま維持する。
      allowLegacyFallback: source == null || source?.allowLegacyFallback === true,
    };
  }
  if (!['A', 'B'].includes(source.modelKey)) {
    return { canExport: false, reason: '全階DXFのモデル識別子が不正です。', source: null };
  }
  if (
    source.document?.nodeType !== 9 ||
    source.document.documentElement?.localName !== 'ST_BRIDGE'
  ) {
    return { canExport: false, reason: 'STB原本Documentが不正です。', source: null };
  }
  return { canExport: true, reason: '', source };
}

function resolveStoryDrawingStories(source) {
  try {
    const stories = parseStories(source?.document);
    if (!Array.isArray(stories) || stories.length === 0) {
      return { canExport: false, reason: 'STB原本に階データがありません', stories: [] };
    }
    return { canExport: true, reason: '', stories };
  } catch (error) {
    return {
      canExport: false,
      reason: `STB原本の階情報を取得できません: ${error.message}`,
      stories: [],
    };
  }
}

function legacyStoryBatchPreflight(fallbackReason = '') {
  const stories = getCurrentStoriesInternal();
  if (!Array.isArray(stories) || stories.length === 0) {
    return {
      canExport: false,
      reason: fallbackReason
        ? `${fallbackReason} / legacy互換経路にも階データがありません`
        : '階データがありません',
      route: 'legacy',
    };
  }

  const legacy = canExportStbToDxf();
  let reason = fallbackReason;
  if (!legacy.canExport) {
    reason = fallbackReason
      ? `${fallbackReason} / legacy互換経路: ${legacy.reason}`
      : legacy.reason;
  }
  return {
    canExport: legacy.canExport,
    reason,
    route: 'legacy',
  };
}

/**
 * 全階DXFの新しいDrawingRenderPlan経路が利用可能か判定する。
 * scene / camera / clipping stateはrender-plan経路の判定条件に含めない。
 * sourceが一意に定まらない場合は、既存動作を壊さない範囲でlegacyへfallbackする。
 */
export function canExportAllStoriesToDxf(selectedElementTypes = null) {
  if (Array.isArray(selectedElementTypes) && selectedElementTypes.length === 0) {
    return { canExport: false, reason: 'エクスポートする部材を選択してください', route: 'none' };
  }

  // source側のhard block（例: 編集セッション中）は、未移行type(Node等)など
  // legacy-only selectionより先に評価する。これによりlegacy fallbackでblockを迂回しない。
  const resolved = resolveStoryDrawingSource();
  if (!resolved.canExport && !resolved.allowLegacyFallback) {
    return { canExport: false, reason: resolved.reason, route: 'none' };
  }
  const sourceFallbackReason = resolved.canExport ? '' : resolved.reason;

  if (Array.isArray(selectedElementTypes)) {
    const selection = canCompileStoryBatchSelection(selectedElementTypes);
    if (!selection.canCompile) {
      const reason = [sourceFallbackReason, selection.reason].filter(Boolean).join(' / ');
      return legacyStoryBatchPreflight(reason);
    }
  }

  if (!resolved.canExport) {
    return legacyStoryBatchPreflight(sourceFallbackReason);
  }

  const storyResult = resolveStoryDrawingStories(resolved.source);
  if (!storyResult.canExport) {
    return { canExport: false, reason: storyResult.reason, route: 'none' };
  }
  return {
    canExport: true,
    reason: '',
    route: 'render-plan',
  };
}

async function exportAllStoriesWithRenderPlan(selectedElementTypes, options = {}) {
  const batchOptions = /** @type {any} */ (options);
  const resolved = resolveStoryDrawingSource();
  if (!resolved.canExport) {
    eventBus.emit(ToastEvents.SHOW_WARNING, {
      message: `エクスポートできません: ${resolved.reason}`,
    });
    return false;
  }
  const storyResult = resolveStoryDrawingStories(resolved.source);
  if (!storyResult.canExport) {
    eventBus.emit(ToastEvents.SHOW_WARNING, {
      message: `エクスポートできません: ${storyResult.reason}`,
    });
    return false;
  }
  const stories = storyResult.stories;
  if (!Array.isArray(selectedElementTypes) || selectedElementTypes.length === 0) {
    eventBus.emit(ToastEvents.SHOW_WARNING, {
      message: 'エクスポートする部材が選択されていません',
    });
    return false;
  }

  const downloadDelay = batchOptions.downloadDelay || 100;
  const includeLabels =
    batchOptions.includeLabels !== undefined ? batchOptions.includeLabels : true;
  const includeAxes = batchOptions.includeAxes !== undefined ? batchOptions.includeAxes : true;
  const labelHeight = batchOptions.labelHeight || 200;
  const scaleDenominator = batchOptions.scaleDenominator || 200;
  const baseFilename = getLoadedFilenameInternal();
  const { source } = resolved;

  const sourceXml = serializeStbDocument(source.document);
  const modelRevision = await sha256(new TextEncoder().encode(sourceXml));
  if (typeof modelRevision !== 'string' || !/^[0-9a-f]{64}$/.test(modelRevision)) {
    throw new Error('全階DXFのモデル改訂SHA-256が不正です。');
  }
  const snapshot = source.document.cloneNode(true);
  const assertSourceUnchanged = () => {
    const current = resolveStoryDrawingSource();
    if (
      !current.canExport ||
      current.source.modelKey !== source.modelKey ||
      serializeStbDocument(current.source.document) !== sourceXml
    ) {
      throw new Error('全階DXF生成中にSTB原本が変更されました。再実行してください。');
    }
  };

  log.info('全階DXFエクスポート開始（DrawingRenderPlan）:', {
    storyCount: stories.length,
    selectedElementTypes,
    modelKey: source.modelKey,
    modelRevision,
    baseFilename,
  });

  const { handle: directoryHandle, cancelled } = await pickDirectoryHandle();
  if (cancelled) return false;

  try {
    let exportedCount = 0;
    for (let i = 0; i < stories.length; i++) {
      const story = stories[i];
      const storyName = story.name || `Floor_${i + 1}`;
      const filename = `${baseFilename}_${storyName}`;

      assertSourceUnchanged();
      log.info(`階エクスポート中: ${storyName} (${i + 1}/${stories.length})`);

      const result = await compileStoryDrawingRenderPlanInternal({
        document: snapshot,
        source: { modelKey: source.modelKey, modelRevision },
        stories,
        storyId: story.id,
        selectedElementTypes,
        includeLabels,
        includeAxes,
        labelHeight,
        scaleDenominator,
      });
      await downloadDrawingRenderPlanDxf(result.renderPlan, filename, directoryHandle);
      exportedCount++;

      if (i < stories.length - 1 && !directoryHandle) {
        await new Promise((resolve) => setTimeout(resolve, downloadDelay));
      }
    }
    assertSourceUnchanged();

    log.info(`全階DXFエクスポート完了（DrawingRenderPlan）: ${exportedCount}/${stories.length}階`);
    eventBus.emit(ToastEvents.SHOW_SUCCESS, {
      message: `${exportedCount}階のDXFファイルをエクスポートしました`,
    });
    return true;
  } catch (error) {
    log.error('全階DXFエクスポートエラー（DrawingRenderPlan）:', error);
    eventBus.emit(ToastEvents.SHOW_ERROR, {
      message: `エクスポート中にエラーが発生しました: ${error.message}`,
    });
    return false;
  }
}

/**
 * 全階をDXFエクスポートする。
 * 通常はSTB原本 -> DrawingModel -> DrawingRenderPlanのscene非依存経路を使用する。
 * Level出力はまだDrawingRenderPlanへ移行していないため、明示指定時だけlegacy経路へ戻す。
 */
export async function exportAllStoriesToDxf(selectedElementTypes, options = {}) {
  if (options.includeLevels === true) {
    // Levelは未移行なのでlegacyを維持する。ただし編集セッション等のhard blockだけは
    // route選択より先に評価し、legacy経路で迂回できないようにする。
    const resolved = resolveStoryDrawingSource();
    if (!resolved.canExport && !resolved.allowLegacyFallback) {
      eventBus.emit(ToastEvents.SHOW_WARNING, {
        message: `エクスポートできません: ${resolved.reason}`,
      });
      return false;
    }
    log.info('Level出力指定のため全階DXFはlegacy scene経路を使用します。');
    return exportAllStoriesLegacyToDxf(selectedElementTypes, options);
  }

  const preflight = canExportAllStoriesToDxf(selectedElementTypes);
  if (!preflight.canExport) {
    eventBus.emit(ToastEvents.SHOW_WARNING, {
      message: `エクスポートできません: ${preflight.reason}`,
    });
    return false;
  }

  if (preflight.route === 'legacy') {
    log.info(
      `全階DXFは既存動作を維持するためlegacy scene経路を使用します: ${preflight.reason || 'render-plan source unavailable'}`,
    );
    return exportAllStoriesLegacyToDxf(selectedElementTypes, options);
  }
  return exportAllStoriesWithRenderPlan(selectedElementTypes, options);
}

async function exportAllStoriesLegacyToDxf(selectedElementTypes, options = {}) {
  const batchOptions = /** @type {any} */ (options);
  const stories = getCurrentStoriesInternal();
  if (!stories || stories.length === 0) {
    eventBus.emit(ToastEvents.SHOW_WARNING, { message: '階データがありません' });
    return false;
  }

  const downloadDelay = batchOptions.downloadDelay || 100;
  const includeLabels =
    batchOptions.includeLabels !== undefined ? batchOptions.includeLabels : true;
  const includeAxes = batchOptions.includeAxes !== undefined ? batchOptions.includeAxes : true;
  const includeLevels =
    batchOptions.includeLevels !== undefined ? batchOptions.includeLevels : false;
  const labelHeight = batchOptions.labelHeight || 200;

  const baseFilename = getLoadedFilenameInternal();

  log.info('全階DXFエクスポート開始:', {
    storyCount: stories.length,
    selectedElementTypes,
    baseFilename,
  });

  const { canExport, reason } = canExportStbToDxf();
  if (!canExport) {
    eventBus.emit(ToastEvents.SHOW_WARNING, { message: `エクスポートできません: ${reason}` });
    return false;
  }

  const { handle: directoryHandle, cancelled } = await pickDirectoryHandle();
  if (cancelled) return false;

  const originalClippingState = getCurrentClippingStateInternal();

  try {
    let exportedCount = 0;

    for (let i = 0; i < stories.length; i++) {
      const story = stories[i];
      const storyName = story.name || `Floor_${i + 1}`;
      const filename = `${baseFilename}_${storyName}`;

      log.info(`階エクスポート中: ${storyName} (${i + 1}/${stories.length})`);

      await applyStoryClipInternal(story.id);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const success = await exportStbToDxf(selectedElementTypes, filename, {
        includeLabels,
        includeAxes,
        includeLevels,
        labelHeight,
        directoryHandle,
        forceViewDirection: 'top',
      });

      if (success) {
        exportedCount++;
      }

      if (i < stories.length - 1 && !directoryHandle) {
        await new Promise((resolve) => setTimeout(resolve, downloadDelay));
      }
    }

    await restoreClippingState(originalClippingState);

    log.info(`全階DXFエクスポート完了: ${exportedCount}/${stories.length}階`);
    eventBus.emit(ToastEvents.SHOW_SUCCESS, {
      message: `${exportedCount}階のDXFファイルをエクスポートしました`,
    });
    return true;
  } catch (error) {
    log.error('全階DXFエクスポートエラー:', error);
    clearAllClippingPlanesInternal();
    eventBus.emit(ToastEvents.SHOW_ERROR, {
      message: `エクスポート中にエラーが発生しました: ${error.message}`,
    });
    return false;
  }
}

/*
 * 全通り芯に沿ってDXFエクスポート（断面連続出力）
 * 各通り芯ごとにDXFファイルを生成し、選択したフォルダに一括保存します。
 * @param {Array<string>} selectedElementTypes - 選択された要素タイプ
 * @param {string} axisDirection - 軸方向 ('X' または 'Y')
 * @param {Object} options - オプション
 * @param {number} [options.downloadDelay=100] - ダウンロード間隔（ミリ秒）
 * @param {FileSystemDirectoryHandle|null} [options.directoryHandle] - 保存先フォルダ（指定時はフォルダ選択ダイアログをスキップ）
 * @returns {Promise<boolean>} 成功/失敗
 */
export async function exportAlongAllAxesToDxf(
  selectedElementTypes,
  axisDirection = 'X',
  options = {},
) {
  const batchOptions = /** @type {any} */ (options);
  const axesData = getCurrentAxesDataInternal();
  if (!axesData) {
    eventBus.emit(ToastEvents.SHOW_WARNING, { message: '通り芯データがありません' });
    return false;
  }

  const axes = axisDirection === 'X' ? axesData.xAxes : axesData.yAxes;
  if (!axes || axes.length === 0) {
    eventBus.emit(ToastEvents.SHOW_WARNING, {
      message: `${axisDirection}方向の通り芯データがありません`,
    });
    return false;
  }

  const downloadDelay = batchOptions.downloadDelay || 100;
  const includeLabels =
    batchOptions.includeLabels !== undefined ? batchOptions.includeLabels : true;
  const includeAxes = batchOptions.includeAxes !== undefined ? batchOptions.includeAxes : true;
  const includeLevels =
    batchOptions.includeLevels !== undefined ? batchOptions.includeLevels : true;
  const labelHeight = batchOptions.labelHeight || 200;

  const baseFilename = getLoadedFilenameInternal();

  log.info(`通り芯DXFエクスポート開始 (${axisDirection}軸):`, {
    axisCount: axes.length,
    selectedElementTypes,
    baseFilename,
  });

  const { canExport, reason } = canExportStbToDxf();
  if (!canExport) {
    eventBus.emit(ToastEvents.SHOW_WARNING, { message: `エクスポートできません: ${reason}` });
    return false;
  }

  // options.directoryHandle が指定済みの場合はフォルダ選択をスキップ
  let directoryHandle;
  if ('directoryHandle' in batchOptions) {
    directoryHandle = batchOptions.directoryHandle;
  } else {
    const { handle, cancelled } = await pickDirectoryHandle();
    if (cancelled) return false;
    directoryHandle = handle;
  }

  const originalClippingState = getCurrentClippingStateInternal();

  try {
    let exportedCount = 0;

    for (let i = 0; i < axes.length; i++) {
      const axis = axes[i];
      const axisName = axis.name || `${axisDirection}_${i + 1}`;
      const filename = `${baseFilename}_${axisDirection}${axisName}`;

      log.info(`通り芯エクスポート中: ${axisName} (${i + 1}/${axes.length})`);

      await applyAxisClipInternal(axisDirection, axis.id);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const viewDir = axisDirection === 'X' ? 'front' : 'side';

      const success = await exportStbToDxf(selectedElementTypes, filename, {
        includeLabels,
        includeAxes,
        includeLevels,
        labelHeight,
        directoryHandle,
        forceViewDirection: viewDir,
      });

      if (success) {
        exportedCount++;
      }

      if (i < axes.length - 1 && !directoryHandle) {
        await new Promise((resolve) => setTimeout(resolve, downloadDelay));
      }
    }

    await restoreClippingState(originalClippingState);

    log.info(`通り芯DXFエクスポート完了: ${exportedCount}/${axes.length}軸`);
    eventBus.emit(ToastEvents.SHOW_SUCCESS, {
      message: `${exportedCount}通り芯のDXFファイルをエクスポートしました`,
    });
    return true;
  } catch (error) {
    log.error('通り芯DXFエクスポートエラー:', error);
    clearAllClippingPlanesInternal();
    eventBus.emit(ToastEvents.SHOW_ERROR, {
      message: `エクスポート中にエラーが発生しました: ${error.message}`,
    });
    return false;
  }
}

/*
 * 両方向の通り芯に沿ってDXFエクスポート
 * X軸とY軸両方の通り芯についてエクスポートします。
 * フォルダ選択ダイアログは一度だけ表示され、X・Y両方向で共有されます。
 * @param {Array<string>} selectedElementTypes - 選択された要素タイプ
 * @param {Object} options - オプション
 * @returns {Promise<boolean>} 少なくとも一方向が成功した場合 true
 */
export async function exportAlongAllAxesBothDirections(selectedElementTypes, options = {}) {
  log.info('両方向通り芯DXFエクスポート開始');

  // フォルダを一度だけ選択してX・Y両方向で共有する
  const { handle: directoryHandle, cancelled } = await pickDirectoryHandle();
  if (cancelled) return false;

  const mergedOptions = /** @type {any} */ ({ ...options, directoryHandle });

  const xSuccess = await exportAlongAllAxesToDxf(selectedElementTypes, 'X', mergedOptions);

  await new Promise((resolve) => setTimeout(resolve, AXIS_DIRECTION_SWITCH_DELAY_MS));

  const ySuccess = await exportAlongAllAxesToDxf(selectedElementTypes, 'Y', mergedOptions);

  log.info('両方向通り芯DXFエクスポート完了');
  return xSuccess || ySuccess;
}

/**
 * エクスポート可能な階一覧を取得
 * @returns {Array<{id: string, name: string, height: number}>} 階一覧
 */
export function getAvailableStories() {
  const resolved = resolveStoryDrawingSource();
  if (resolved.canExport) {
    const storyResult = resolveStoryDrawingStories(resolved.source);
    if (storyResult.canExport) return storyResult.stories;
  }
  const stories = getCurrentStoriesInternal();
  return stories || [];
}

/**
 * エクスポート可能な通り芯一覧を取得
 * @returns {{xAxes: Array, yAxes: Array}} 通り芯一覧
 */
export function getAvailableAxes() {
  const axesData = getCurrentAxesDataInternal();
  return axesData || { xAxes: [], yAxes: [] };
}
