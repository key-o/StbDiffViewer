/**
 * @fileoverview マテリアル管理モジュール
 *
 * このファイルは、3Dビューワーのマテリアル関連ユーティリティを提供します:
 * - 要素タイプ別の片面/両面レンダリング最適化
 * - 重要度別視覚スタイル定義
 * - 色付けモード対応のマテリアル取得
 * - 重要度マテリアルの適用・キャッシュ
 *
 * 全てのマテリアル生成はColorManagerに委譲しています。
 */

import * as THREE from 'three';
import { clippingStateManager } from '../clipping/ClippingStateManager.js';
import { getCurrentColorMode, COLOR_MODES } from '../../colorModes/colorModeState.js';
import { getSchemaError } from '../../common-stb/validation/schemaErrorStore.js';
import {
  getSectionValidation,
  getElementValidation,
} from '../../common-stb/validation/validationManager.js';
import { IMPORTANCE_LEVELS } from '../../constants/importanceLevels.js';
import { RenderableLifecycleEvents } from '../../constants/renderableLifecycleEvents.js';
import { SRC_COMPONENT_COLORS } from '../../config/colorConfig.js';
import { eventBus } from '../../data/events/eventBus.js';
import { colorManager } from './colorManager.js';
import { scheduleRender } from '../../utils/renderScheduler.js';
import { createLogger } from '../../utils/logger.js';
import { processObjectsInBatches } from '../../utils/elementGroupBatchRunner.js';

const log = createLogger('viewer:rendering:materials');

// --- パフォーマンス最適化: 片面/両面マテリアル設定 ---
// 閉じたジオメトリ（柱、梁、ブレース等）は片面レンダリングで描画ポリゴン数を削減
// 薄いジオメトリ（壁、スラブ、パラペット等）は両面レンダリングが必要

/**
 * 要素タイプに応じたマテリアルのside設定
 * @type {Object<string, number>}
 */
export const ELEMENT_MATERIAL_SIDE = {
  // 閉じたジオメトリ - 片面レンダリング（約50%の描画削減）
  Column: THREE.FrontSide,
  Post: THREE.FrontSide,
  Girder: THREE.FrontSide,
  Beam: THREE.FrontSide,
  Brace: THREE.FrontSide,
  IsolatingDevice: THREE.FrontSide,
  DampingDevice: THREE.FrontSide,
  FrameDampingDevice: THREE.DoubleSide,
  Pile: THREE.FrontSide,
  Footing: THREE.FrontSide,
  FoundationColumn: THREE.FrontSide,
  StripFooting: THREE.FrontSide,
  Joint: THREE.FrontSide,

  // 薄いジオメトリ - 両面レンダリング（裏面が見える可能性がある）
  Slab: THREE.DoubleSide,
  ShearWall: THREE.DoubleSide,
  Wall: THREE.DoubleSide,
  Parapet: THREE.DoubleSide,

  // その他/デフォルト - 両面レンダリング（安全側）
  Node: THREE.DoubleSide,
  Axis: THREE.DoubleSide,
  Story: THREE.DoubleSide,
};

/**
 * 要素タイプに応じたマテリアルのsideを取得
 * @param {string} elementType - 要素タイプ
 * @returns {number} THREE.FrontSide または THREE.DoubleSide
 */
export function getMaterialSideForElement(elementType) {
  return ELEMENT_MATERIAL_SIDE[elementType] ?? THREE.DoubleSide;
}

/**
 * 片面マテリアル最適化が有効かどうか
 */
let singleSidedOptimizationEnabled = true;

/**
 * 片面マテリアル最適化の有効/無効を設定
 * @param {boolean} enabled
 */
export function setSingleSidedOptimizationEnabled(enabled) {
  singleSidedOptimizationEnabled = enabled;
}

/**
 * 片面マテリアル最適化が有効かどうかを取得
 * @returns {boolean}
 */
export function isSingleSidedOptimizationEnabled() {
  return singleSidedOptimizationEnabled;
}

/**
 * 要素タイプに応じた最適なマテリアルを作成
 * @param {Object} baseOptions - 基本マテリアルオプション
 * @param {string} elementType - 要素タイプ
 * @returns {THREE.Material}
 */
export function createOptimizedMaterial(baseOptions, elementType) {
  const side = singleSidedOptimizationEnabled
    ? getMaterialSideForElement(elementType)
    : THREE.DoubleSide;

  return new THREE.MeshStandardMaterial({
    ...baseOptions,
    side,
  });
}

// --- 重要度別視覚的スタイル定義（違反/対象外の2値） ---
export const IMPORTANCE_VISUAL_STYLES = {
  [IMPORTANCE_LEVELS.REQUIRED]: {
    opacity: 1.0,
    outlineWidth: 2.0,
    saturation: 1.0,
    highlightColor: '#FF0000',
  },
  [IMPORTANCE_LEVELS.OPTIONAL]: {
    opacity: 1.0,
    outlineWidth: 2.0,
    saturation: 1.0,
    highlightColor: '#FF0000',
  },
  [IMPORTANCE_LEVELS.UNNECESSARY]: {
    opacity: 1.0,
    outlineWidth: 2.0,
    saturation: 1.0,
    highlightColor: '#FF0000',
  },
  [IMPORTANCE_LEVELS.NOT_APPLICABLE]: {
    opacity: 0.1,
    outlineWidth: 0.0,
    saturation: 0.1,
    highlightColor: '#404040',
  },
};

/**
 * 要素に適用するマテリアルを取得する関数
 * 色付けモードに応じて適切なマテリアルを返す
 * @param {string} elementType 要素タイプ (Column, Girder, Beam, etc.)
 * @param {string} comparisonState 比較状態 ('matched', 'onlyA', 'onlyB')
 * @param {boolean} isLine 線要素かどうか
 * @param {boolean} isPoly ポリゴン要素かどうか
 * @param {Object} [extraOptions] 追加オプション
 * @param {boolean} [extraOptions.isTransparent] 半透明マテリアルを強制するか
 * @returns {THREE.Material} 適用するマテリアル
 */
export function getMaterialForElementWithMode(
  elementType,
  comparisonState,
  isLine = false,
  isPoly = false,
  _elementId = null,
  toleranceState = null,
  extraOptions = {},
) {
  const colorMode = getCurrentColorMode();
  const forceTransparent = Boolean(extraOptions?.isTransparent);
  const srcComponentOverrideColor = resolveSrcComponentOverrideColor(elementType, extraOptions);

  // ColorManagerを使用してマテリアルを取得
  let materialMode;
  const materialParams = {
    elementType,
    comparisonState,
    isLine,
    isPoly,
    toleranceState,
    diffStatus: extraOptions?.diffStatus || null,
    positionState: extraOptions?.positionState || null,
    attributeState: extraOptions?.attributeState || null,
    isTransparent: forceTransparent,
    overrideColor: srcComponentOverrideColor,
  };

  // 色付けモードに応じてマテリアルモードを決定
  switch (colorMode) {
    case COLOR_MODES.IMPORTANCE:
      materialMode = 'importance';
      // 暫定的に対象外を設定（実際の違反判定は applyImportanceColorMode で行う）
      materialParams.importanceLevel = IMPORTANCE_LEVELS.NOT_APPLICABLE;
      break;

    case COLOR_MODES.ELEMENT:
      materialMode = 'element';
      break;

    case COLOR_MODES.SCHEMA: {
      materialMode = 'schema';
      const modelSource = extraOptions?.modelSource || null;
      const errorInfo = _elementId
        ? getSchemaError(_elementId, modelSource, elementType)
        : { status: 'valid' };
      materialParams.status = errorInfo.status;
      break;
    }

    case COLOR_MODES.DIFF:
    default:
      materialMode = 'diff';
      break;
  }

  // ColorManagerからマテリアルを取得
  return colorManager.getMaterial(materialMode, materialParams);
}

/**
 * SRC柱の構成要素タイプに応じて上書き色を決定
 * @param {string} elementType
 * @param {Object} extraOptions
 * @returns {string|null}
 */
function resolveSrcComponentOverrideColor(elementType, extraOptions = {}) {
  if (elementType !== 'Column') return null;

  const srcComponentType = String(extraOptions.srcComponentType || '').toUpperCase();
  if (srcComponentType === 'S') {
    return SRC_COMPONENT_COLORS.Column.steel;
  }
  if (srcComponentType === 'RC') {
    return SRC_COMPONENT_COLORS.Column.concrete;
  }
  return null;
}

/**
 * 重要度対応のアウトライン用マテリアル作成
 * @param {string} importance - 重要度レベル
 * @returns {THREE.Material|null} アウトライン用マテリアル、またはnull
 */
export function createImportanceOutlineMaterial(importance) {
  if (!importance || !IMPORTANCE_VISUAL_STYLES[importance]) {
    return null;
  }
  const style = IMPORTANCE_VISUAL_STYLES[importance];

  // 幅が0の場合はアウトラインを作成しない
  if (style.outlineWidth <= 0) {
    return null;
  }

  const outlineMaterial = new THREE.MeshBasicMaterial({
    color: style.highlightColor,
    side: THREE.BackSide,
    transparent: true,
    opacity: Math.min(style.opacity, 0.8), // アウトラインは少し薄く
    // SectionBox中に生成されても復元先は常にSectionBox外のlocal空状態。
    clippingPlanes: clippingStateManager.getMaterialPlanes({ clippingExempt: true }),
  });

  // active SectionBox 6面の適用と復元baselineの追跡をSSOTへ委譲する。
  clippingStateManager.applyToMaterial(outlineMaterial);

  return outlineMaterial;
}

// --- 重要度別色分け機能 ---

/**
 * 高速ハッシュキー生成
 * @param {string} prefix - プレフィックス
 * @param {...any} values - 値
 * @returns {string} ハッシュキー
 */
function generateMaterialCacheKey(prefix, ...values) {
  // FNV-1aハッシュアルゴリズム（高速でキャッシュキー生成に適している）
  let hash = 2166136261;
  for (const val of values) {
    const str = val === undefined || val === null ? '_' : String(val);
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${prefix}:${(hash >>> 0).toString(36)}`;
}

/**
 * 重要度マテリアルキャッシュ
 */
class ImportanceMaterialCache {
  constructor() {
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  getMaterial(importanceLevel, options = {}) {
    // ハッシュベースの高速キー生成（JSON.stringifyより約10倍高速）
    const key = generateMaterialCacheKey(
      'imp',
      importanceLevel,
      options.elementType || 'default',
      options.wireframe ? 'w' : '',
      options.transparent ? 't' : '',
      options.opacity,
    );

    if (this.cache.has(key)) {
      this.hits++;
      return this.cache.get(key);
    }

    this.misses++;
    const material = createImportanceMaterial(importanceLevel, options);
    this.cache.set(key, material);
    return material;
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * キャッシュ統計情報を取得
   * @returns {Object} 統計情報
   */
  getStats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? ((this.hits / total) * 100).toFixed(1) + '%' : '0%',
    };
  }
}

// グローバルキャッシュインスタンス
const importanceMaterialCache = new ImportanceMaterialCache();
let importanceBatchApplyDepth = 0;
let importanceMaterialsChangedQueued = false;
let importanceMaterialsChangedGeneration = 0;

function emitImportanceMaterialsChanged() {
  eventBus.emit(RenderableLifecycleEvents.MATERIALS_CHANGED, {
    modeName: 'ImportanceColorMode',
  });
}

/**
 * 同一call stack内の同期Importance適用を1回の完了通知へまとめる。
 * 非同期batch中はbatch全体のonCompleteが通知責務を持つため抑止する。
 */
function queueImportanceMaterialsChanged() {
  if (importanceBatchApplyDepth > 0 || importanceMaterialsChangedQueued) return;
  importanceMaterialsChangedQueued = true;
  const generation = ++importanceMaterialsChangedGeneration;
  globalThis.queueMicrotask(() => {
    if (generation !== importanceMaterialsChangedGeneration) return;
    importanceMaterialsChangedQueued = false;
    if (importanceBatchApplyDepth > 0) return;
    emitImportanceMaterialsChanged();
  });
}

/**
 * 重要度別マテリアルを生成
 * @param {string} importanceLevel - 重要度レベル
 * @param {Object} options - オプション設定
 * @returns {THREE.Material} マテリアル
 */
function createImportanceMaterial(importanceLevel, options = {}) {
  // ColorManagerを使用してマテリアルを取得
  const materialParams = {
    elementType: options.elementType,
    importanceLevel: importanceLevel,
    wireframe: options.wireframe,
    isLine: false,
    isPoly: false,
  };

  const material = colorManager.getMaterial('importance', materialParams);

  return material;
}

/**
 * sectionIdのバリデーションエラー（sectionValidationMap / elementValidationMap）を確認する
 * sectionIdは数値・文字列どちらでも許容し、文字列に正規化してルックアップする
 * @param {string|number|undefined} sectionId
 * @returns {boolean}
 */
function hasSectionValidationError(sectionId) {
  if (sectionId == null || sectionId === '') return false;
  const sid = String(sectionId);
  const sectionValidation = getSectionValidation(sid);
  if (sectionValidation?.errors?.length > 0) return true;
  const elementValidation = getElementValidation(sid);
  return elementValidation?.errors?.length > 0;
}

/**
 * オブジェクトの有効重要度レベルを取得
 * REQUIRED（違反）/ NOT_APPLICABLE（対象外）の2値で返す
 * @param {THREE.Object3D} object - 対象オブジェクト
 * @returns {string} IMPORTANCE_LEVELS.REQUIRED または IMPORTANCE_LEVELS.NOT_APPLICABLE
 */
export function getEffectiveImportanceLevelForObject(object) {
  const importance = object?.userData?.importance;
  const hasValidationError = hasSectionValidationError(object?.userData?.sectionId);

  return importance === IMPORTANCE_LEVELS.REQUIRED || hasValidationError
    ? IMPORTANCE_LEVELS.REQUIRED
    : IMPORTANCE_LEVELS.NOT_APPLICABLE;
}

/**
 * オブジェクトに重要度マテリアルを適用
 * userData.importance（ImportanceManagerがJSON設定に基づき算出済み）を参照し、
 * REQUIRED（違反あり）のみ違反色、それ以外は対象外色にする。
 * バリデーションエラーがある断面を参照する要素も違反色にする。
 * @param {THREE.Object3D} object - 対象オブジェクト
 * @param {Object} options - オプション設定
 */
export function applyImportanceColorMode(object, options = {}) {
  try {
    const elementType = object.userData.elementType;

    if (object.isMesh) {
      const effectiveLevel = getEffectiveImportanceLevelForObject(object);

      const materialOptions = {
        ...options,
        elementType: elementType,
      };

      const material = importanceMaterialCache.getMaterial(effectiveLevel, materialOptions);
      if (material) {
        object.material = material;
        object.material.needsUpdate = true;
        queueImportanceMaterialsChanged();
      }
    }
  } catch (error) {
    log.warn(`Failed to apply importance color mode to object:`, error);
  }
}

/**
 * 重要度マテリアルキャッシュをクリア
 */
export function clearImportanceMaterialCache() {
  importanceMaterialCache.clear();
  // ColorManagerのキャッシュもクリア
  colorManager.clearMaterialCache();
}

/**
 * バッチ処理で複数オブジェクトに重要度マテリアルを適用
 * @param {THREE.Object3D[]} objects - 処理対象オブジェクト配列
 * @param {Object} options - オプション設定
 * @param {Function} [options.onComplete] 全バッチ完了後の追加コールバック
 */
export function applyImportanceColorModeBatch(objects, options = {}) {
  const batchSize = options.batchSize || 100; // バッチサイズ
  const delay = options.delay || 10; // バッチ間の遅延（ms）

  // 既に予約済みの同期通知はこのbatch完了通知へ吸収する。
  importanceMaterialsChangedGeneration++;
  importanceMaterialsChangedQueued = false;
  importanceBatchApplyDepth++;

  processObjectsInBatches(objects, {
    batchSize,
    processObject: (object) => {
      if (object.isMesh) applyImportanceColorMode(object, options);
    },
    // 重要度モードは従来どおり指定ミリ秒のタイマーで処理を分割する。
    scheduleNext: (nextBatch) => setTimeout(nextBatch, delay),
    onComplete: () => {
      scheduleRender();
      try {
        // callback内でImportance materialを再適用しても、このbatchの最終通知へ吸収する。
        options.onComplete?.();
      } finally {
        importanceBatchApplyDepth = Math.max(0, importanceBatchApplyDepth - 1);
        if (importanceBatchApplyDepth === 0) {
          emitImportanceMaterialsChanged();
        }
      }
    },
  });
}

/**
 * パフォーマンス統計情報を取得
 * @returns {Object} パフォーマンス統計
 */
export function getImportanceRenderingStats() {
  const stats = {
    materialCacheSize: importanceMaterialCache.cache.size,
    runtimeColorsActive: !!window.runtimeImportanceColors,
    runtimeColorCount: window.runtimeImportanceColors
      ? Object.keys(window.runtimeImportanceColors).length
      : 0,
  };

  return stats;
}

/**
 * 全てのマテリアルキャッシュをクリアする
 */
export function clearMaterialCache() {
  // 重要度マテリアルキャッシュをクリア
  clearImportanceMaterialCache();

  // ColorManagerのキャッシュもクリア
  colorManager.clearMaterialCache();
}
