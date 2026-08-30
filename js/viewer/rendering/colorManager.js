/**
 * @fileoverview 色管理モジュール
 *
 * このファイルは、3Dビューワーの全ての色付けを一元管理します：
 * - 差分表示モードの色管理
 * - 部材別色付けモード - 要素タイプごとに色を設定
 * - スキーマエラー表示モード - スキーマチェックエラーを表示
 * - 重要度別色付けモード - 属性の重要度で色分け
 * - マテリアルのキャッシュと再利用
 *
 * 各色設定は専用のマネージャークラスで管理され、
 * ColorManagerはこれらを統合してマテリアル生成機能を提供します。
 */

import * as THREE from 'three';
import { clippingStateManager } from '../clipping/ClippingStateManager.js';
import elementColorManager from './elementColorManager.js';
import diffColorManager from './diffColorManager.js';
import schemaColorManager from './schemaColorManager.js';
import importanceColorManager from './importanceColorManager.js';
import loadColorManager from './loadColorManager.js';

/**
 * 色管理クラス
 * 全ての色付けモードの色設定とマテリアル生成を一元管理
 */
class ColorManager {
  constructor() {
    // 各色管理マネージャーへの参照
    this.elementColorManager = elementColorManager;
    this.diffColorManager = diffColorManager;
    this.schemaColorManager = schemaColorManager;
    this.importanceColorManager = importanceColorManager;
    this.loadColorManager = loadColorManager;

    // マテリアルキャッシュ
    this.materialCache = new Map();

    // 色変更時にマテリアルキャッシュをクリアするコールバックを登録
    elementColorManager.onColorChange(() => this.clearMaterialCache());
    diffColorManager.onColorChange(() => this.clearMaterialCache());
    schemaColorManager.onColorChange(() => this.clearMaterialCache());
    importanceColorManager.onColorChange(() => this.clearMaterialCache());
    loadColorManager.onColorChange(() => this.clearMaterialCache());
  }

  /**
   * 差分表示モードの色を取得
   * @param {string} state - 比較状態 ('matched', 'onlyA', 'onlyB')
   * @returns {string} 色コード
   */
  getDiffColor(state) {
    return this.diffColorManager.getDiffColor(state);
  }

  /**
   * 差分表示モードの色を設定
   * @param {string} state - 比較状態 ('matched', 'onlyA', 'onlyB')
   * @param {string} color - 色コード
   */
  setDiffColor(state, color) {
    this.diffColorManager.setDiffColor(state, color);
  }

  /**
   * 許容差対応の差分表示モード色を取得（5段階）
   * @param {string} state - 比較状態 ('exact', 'withinTolerance', 'mismatch', 'onlyA', 'onlyB')
   * @returns {string} 色コード
   */
  getToleranceDiffColor(state) {
    return this.diffColorManager.getToleranceDiffColor(state);
  }

  /**
   * 許容差対応の差分表示モード色を設定（5段階）
   * @param {string} state - 比較状態 ('exact', 'withinTolerance', 'mismatch', 'onlyA', 'onlyB')
   * @param {string} color - 色コード
   */
  setToleranceDiffColor(state, color) {
    this.diffColorManager.setToleranceDiffColor(state, color);
  }

  /**
   * 全ての許容差対応差分色を取得
   * @returns {Object} 比較状態をキー、色コードを値とするオブジェクト
   */
  getAllToleranceDiffColors() {
    return this.diffColorManager.getAllToleranceDiffColors();
  }

  /**
   * 部材別色を取得
   * @param {string} elementType - 要素タイプ
   * @returns {string} 色コード
   */
  getElementColor(elementType) {
    return this.elementColorManager.getElementColor(elementType);
  }

  /**
   * 部材別色を設定
   * @param {string} elementType - 要素タイプ
   * @param {string} color - 色コード
   */
  setElementColor(elementType, color) {
    return this.elementColorManager.setElementColor(elementType, color);
  }

  /**
   * 全ての部材別色を取得
   * @returns {Object<string, string>} 要素タイプ別の色
   */
  getAllElementColors() {
    return this.elementColorManager.getAllElementColors();
  }

  /**
   * 複数の部材別色を設定
   * @param {Object<string, string>} colors - 要素タイプ別の色
   */
  setAllElementColors(colors) {
    this.elementColorManager.setAllColors(colors);
  }

  /**
   * 部材別色をデフォルトへ一括リセット
   */
  resetElementColors() {
    this.elementColorManager.resetToDefault();
  }

  /**
   * 部材別色の変更を購読
   * @param {Function} callback - (elementType, color) => void
   * @returns {Function} 購読解除関数
   */
  onElementColorChange(callback) {
    return this.elementColorManager.onColorChange(callback);
  }

  /**
   * スキーマ色を取得
   * @param {string|boolean} status - ステータス ('valid', 'info', 'warning', 'error') または hasError (boolean)
   * @returns {string} 色コード
   */
  getSchemaColor(status) {
    return this.schemaColorManager.getSchemaColor(status);
  }

  /**
   * スキーマ色を設定
   * @param {string} type - 'valid', 'info', 'warning', 'error'
   * @param {string} color - 色コード
   */
  setSchemaColor(type, color) {
    this.schemaColorManager.setSchemaColor(type, color);
  }

  /**
   * 重要度別色を取得
   * @param {string} importanceLevel - 重要度レベル
   * @returns {string} 色コード
   */
  getImportanceColor(importanceLevel) {
    return this.importanceColorManager.getImportanceColor(importanceLevel);
  }

  /**
   * 重要度別色を設定
   * @param {string} importanceLevel - 重要度レベル
   * @param {string} color - 色コード
   */
  setImportanceColor(importanceLevel, color) {
    this.importanceColorManager.setImportanceColor(importanceLevel, color);
  }

  /**
   * 重要度別視覚スタイルを取得
   * @param {string} importanceLevel - 重要度レベル
   * @returns {Object} 視覚スタイル
   */
  getImportanceVisualStyle(importanceLevel) {
    return this.importanceColorManager.getVisualStyle(importanceLevel);
  }

  /**
   * 荷重色を取得
   * @param {string} loadType - 荷重タイプ
   * @returns {string} 色コード
   */
  getLoadColor(loadType) {
    return this.loadColorManager.getLoadColor(loadType);
  }

  /**
   * 荷重色を設定
   * @param {string} loadType - 荷重タイプ
   * @param {string} color - 色コード
   */
  setLoadColor(loadType, color) {
    return this.loadColorManager.setLoadColor(loadType, color);
  }

  /**
   * マテリアルを取得（キャッシュから取得または新規作成）
   * @param {string} colorMode - 色付けモード
   * @param {Object} params - マテリアル生成パラメータ
   * @returns {THREE.Material} マテリアル
   */
  getMaterial(colorMode, params = {}) {
    const cacheKey = this._generateCacheKey(colorMode, params);
    let material;

    if (this.materialCache.has(cacheKey)) {
      material = this.materialCache.get(cacheKey);
    } else {
      material = this._createMaterial(colorMode, params);
      this.materialCache.set(cacheKey, material);
    }

    this._syncClippingPolicy(material, colorMode, params);
    return material;
  }

  /**
   * キャッシュ済みMaterialを含め、取得のたびにactive clipping policyへ同期する。
   * 通常時はMaterial-local clippingを空にし、SectionBox中だけ対象Renderableへ6面を適用する。
   * @private
   * @param {THREE.Material} material
   * @param {string} colorMode
   * @param {Object} params
   */
  _syncClippingPolicy(material, colorMode, params) {
    // Spriteは既存契約どおりclippingを持たせない。
    if (params.isSprite) return;

    clippingStateManager.applyToMaterial(material, {
      // Axis/Story等のlayout materialはSectionBox対象外。
      sectionBoxExempt: colorMode === 'layout',
    });
  }

  /**
   * マテリアルキャッシュキーを生成
   * @private
   */
  _generateCacheKey(colorMode, params) {
    // JSON.stringify を文字列連結に置換してパフォーマンスを改善
    // 大量の要素に対して呼ばれるため、軽量なキー生成が重要
    return `${colorMode}|${params.elementType ?? ''}|${params.comparisonState ?? ''}|${params.toleranceState ?? ''}|${params.positionState ?? ''}|${params.attributeState ?? ''}|${params.diffStatus ?? ''}|${params.isLine ?? ''}|${params.isSprite ?? ''}|${params.isPoly ?? ''}|${params.importanceLevel ?? ''}|${params.wireframe ?? ''}|${params.hasError ?? ''}|${params.status ?? ''}|${params.isTransparent ?? ''}|${params.layoutType ?? ''}|${params.overrideColor ?? ''}`;
  }

  /**
   * マテリアルを新規作成
   * @private
   */
  _createMaterial(colorMode, params) {
    let color;
    let material;
    const materialOptions = {
      side: THREE.DoubleSide,
      // 新規Materialは常に「SectionBox外」のlocal clipping状態から生成する。
      // getMaterial()末尾の共通同期でactive SectionBox 6面を適用し、その際に
      // この空baselineを復元先として記録する。
      clippingPlanes: clippingStateManager.getMaterialPlanes({ clippingExempt: true }),
    };

    // 構成要素ごとの明示色（例: SRC柱のRC/S）
    if (params.overrideColor) {
      color = params.overrideColor;
    }

    // 色付けモードに応じて色を決定
    switch (params.overrideColor ? '__OVERRIDE__' : colorMode) {
      case 'diff':
        // 6カテゴリ分類: diffStatusが直接指定されている場合
        if (params.diffStatus) {
          color = this.getDiffColor(params.diffStatus);
        }
        // positionState + attributeState から6カテゴリを決定
        else if (params.positionState && params.attributeState) {
          const diffStatus = this._determineDiffStatusFromStates(
            params.positionState,
            params.attributeState,
          );
          color = this.getDiffColor(diffStatus);
        }
        // レガシー: toleranceState が指定されている場合
        else if (params.toleranceState) {
          color = this.getToleranceDiffColor(params.toleranceState);
        }
        // デフォルト: comparisonState から取得
        else {
          color = this.getDiffColor(params.comparisonState || 'matched');
        }
        break;

      case 'element':
        color = this.getElementColor(params.elementType);
        break;

      case 'schema':
        color = this.getSchemaColor(params.status || (params.hasError ? 'error' : 'valid'));
        break;

      case 'importance':
        color = this.getImportanceColor(params.importanceLevel || 'REQUIRED');
        const visualStyle = this.getImportanceVisualStyle(params.importanceLevel);
        materialOptions.opacity = visualStyle.opacity;
        materialOptions.transparent = visualStyle.opacity < 1.0;
        break;

      case 'highlight':
        return this._createHighlightMaterial(params);

      case 'selectionCandidate':
        return this._createSelectionCandidateMaterial(params);

      case 'layout':
        return this._createLayoutMaterial(params);

      case '__OVERRIDE__':
        break;

      default:
        color = '#888888';
    }

    // ワイヤーフレーム設定
    // 注意: Storyは半透明の面として表示すべきなので、ワイヤーフレームにしない
    // Axisは別途LineBasicMaterialを使用するのでここでは不要
    const shouldUseWireframe = params.wireframe;

    if (shouldUseWireframe) {
      materialOptions.wireframe = true;
    }

    if (params.isLine) {
      // 線要素用マテリアル (一点鎖線はジオメトリで実現済み)
      material = new THREE.LineBasicMaterial({
        color: new THREE.Color(color),
        clippingPlanes: materialOptions.clippingPlanes,
      });
    } else if (params.isPoly) {
      // ポリゴン要素用マテリアル（半透明）
      material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: 0.8,
        metalness: 0.1,
        transparent: true,
        opacity: materialOptions.opacity !== undefined ? materialOptions.opacity : 0.7,
        ...materialOptions,
      });
    } else if (params.isTransparent) {
      // SRC造RC部分用半透明マテリアル
      material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: 0.7,
        metalness: 0.0,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        ...materialOptions,
      });
    } else {
      // 通常のメッシュ要素用マテリアル
      const baseOpacity = materialOptions.opacity !== undefined ? materialOptions.opacity : 1.0;
      material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: 0.6,
        metalness: 0.1,
        transparent: baseOpacity < 1.0,
        opacity: baseOpacity,
        ...materialOptions,
      });
    }

    // 彩度調整（重要度モードの場合）
    if (colorMode === 'importance' && params.importanceLevel) {
      const visualStyle = this.getImportanceVisualStyle(params.importanceLevel);
      if (visualStyle.saturation < 1.0) {
        this._adjustMaterialSaturation(material, visualStyle.saturation);
      }
    }

    return material;
  }

  /**
   * ハイライト用マテリアルを作成
   * @private
   * @param {Object} params - { isLine: boolean, isSprite: boolean }
   * @returns {THREE.Material}
   */
  _createHighlightMaterial(params) {
    const clippingPlanes = clippingStateManager.getMaterialPlanes({ clippingExempt: true });
    const highlightColor = '#ffc107'; // Material Amber

    if (params.isLine) {
      return new THREE.LineBasicMaterial({
        color: new THREE.Color(highlightColor),
        linewidth: 5,
        clippingPlanes,
      });
    }

    if (params.isSprite) {
      return new THREE.SpriteMaterial({
        color: new THREE.Color(highlightColor),
        transparent: true,
        opacity: 1,
        depthTest: false,
        depthWrite: false,
      });
    }

    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(highlightColor),
      roughness: 0.5,
      metalness: 0.2,
      side: THREE.DoubleSide,
      emissive: new THREE.Color(0x554400),
      clippingPlanes,
    });
  }

  /**
   * 選択候補プレビュー用マテリアルを生成
   * @private
   * @param {Object} params - { isLine: boolean, isSprite: boolean }
   * @returns {THREE.Material}
   */
  _createSelectionCandidateMaterial(params) {
    const clippingPlanes = clippingStateManager.getMaterialPlanes({ clippingExempt: true });
    const candidateColor = '#26c6da'; // Cyan

    if (params.isLine) {
      return new THREE.LineBasicMaterial({
        color: new THREE.Color(candidateColor),
        linewidth: 5,
        clippingPlanes,
      });
    }

    if (params.isSprite) {
      return new THREE.SpriteMaterial({
        color: new THREE.Color(candidateColor),
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
      });
    }

    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(candidateColor),
      roughness: 0.45,
      metalness: 0.15,
      side: THREE.DoubleSide,
      emissive: new THREE.Color(0x0c4a52),
      clippingPlanes,
    });
  }

  /**
   * レイアウト要素（通り芯・階）用マテリアルを作成
   * @private
   * @param {Object} params - { layoutType: 'axis'|'story', isLine: boolean }
   * @returns {THREE.Material}
   */
  _createLayoutMaterial(params) {
    const clippingPlanes = clippingStateManager.getMaterialPlanes({ clippingExempt: true });
    const layoutType = params.layoutType || 'axis';

    if (params.isLine) {
      return new THREE.LineBasicMaterial({
        color: new THREE.Color(0xaaaaaa),
        linewidth: 1,
        transparent: layoutType === 'story',
        opacity: layoutType === 'story' ? 0.5 : 1.0,
        clippingPlanes,
      });
    }

    // 面マテリアル（MeshBasicMaterial — ライティング影響なし）
    return new THREE.MeshBasicMaterial({
      color: new THREE.Color(layoutType === 'axis' ? 0x888888 : 0xaaaaaa),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: layoutType === 'axis' ? 0.1 : 0.08,
      depthWrite: false,
      clippingPlanes,
    });
  }

  /**
   * positionState と attributeState から6カテゴリのdiffStatusを決定
   * @private
   * @param {string} positionState - 位置状態 ('exact' | 'withinTolerance' | 'mismatch')
   * @param {string} attributeState - 属性状態 ('matched' | 'mismatch')
   * @returns {string} 6カテゴリのdiffStatus
   */
  _determineDiffStatusFromStates(positionState, attributeState) {
    // 位置完全一致
    if (positionState === 'exact') {
      if (attributeState === 'matched') {
        return 'matched';
      }
      return 'attributeMismatch';
    }

    // 位置許容差内
    if (positionState === 'withinTolerance') {
      if (attributeState === 'matched') {
        return 'positionTolerance';
      }
      return 'combined';
    }

    // 位置許容差超過（通常はマッチング失敗でonlyA/onlyBになる）
    return 'attributeMismatch';
  }

  /**
   * マテリアルの彩度を調整
   * @private
   */
  _adjustMaterialSaturation(material, saturation) {
    if (!material.color) return;

    const hsl = {};
    material.color.getHSL(hsl);
    hsl.s *= saturation;
    material.color.setHSL(hsl.h, hsl.s, hsl.l);

    if (material.emissive) {
      const emissiveHsl = {};
      material.emissive.getHSL(emissiveHsl);
      emissiveHsl.s *= saturation;
      material.emissive.setHSL(emissiveHsl.h, emissiveHsl.s, emissiveHsl.l);
    }
  }

  /**
   * マテリアルキャッシュをクリア
   */
  clearMaterialCache() {
    // マテリアルを破棄
    for (const material of this.materialCache.values()) {
      if (material.dispose) {
        material.dispose();
      }
    }
    this.materialCache.clear();
  }

  /**
   * 全ての色設定をデフォルトにリセット
   */
  resetAllColors() {
    this.diffColorManager.resetToDefault();
    this.elementColorManager.resetToDefault();
    this.schemaColorManager.resetToDefault();
    this.importanceColorManager.resetToDefault();
    this.loadColorManager.resetToDefault();

    this.clearMaterialCache();
  }

  /**
   * デバッグ情報を取得
   */
  getDebugInfo() {
    return {
      diffColors: this.diffColorManager.getAllDiffColors(),
      elementColors: this.elementColorManager.getAllElementColors(),
      schemaColors: this.schemaColorManager.getAllSchemaColors(),
      importanceColors: this.importanceColorManager.getAllImportanceColors(),
      loadColors: this.loadColorManager.getAllLoadColors(),
      materialCacheSize: this.materialCache.size,
      managerDebugInfo: {
        diffColorManager: this.diffColorManager.getDebugInfo(),
        elementColorManager: this.elementColorManager.getDebugInfo(),
        schemaColorManager: this.schemaColorManager.getDebugInfo(),
        importanceColorManager: this.importanceColorManager.getDebugInfo(),
        loadColorManager: this.loadColorManager.getDebugInfo(),
      },
    };
  }
}

// シングルトンインスタンスを作成してエクスポート
export const colorManager = new ColorManager();
