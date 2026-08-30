/**
 * @fileoverview 比較キータイプ管理モジュール
 *
 * STB要素の対応関係を決定する際のキータイプ（位置情報ベース or GUIDベース）を管理します。
 * ColorManagerやDisplayModeManagerと同様のシングルトンパターンで実装。
 */

import {
  COMPARISON_KEY_TYPE,
  DEFAULT_COMPARISON_KEY_TYPE,
  SECTION_MATCH_CRITERION,
  DEFAULT_SECTION_MATCH_CRITERION,
  STORY_AXIS_MATCH_CRITERION,
  DEFAULT_STORY_AXIS_MATCH_CRITERION,
} from '../config/comparisonKeyConfig.js';
import { setCrossSoftwareConfig } from '../config/crossSoftwareConfig.js';
// UI層への依存を解消: constants/から直接インポート
import { COMPARISON_KEY_EVENTS } from '../constants/eventTypes.js';
import { storageHelper } from '../utils/storageHelper.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('app:comparisonKeyManager');

// storageHelper用のキー
const STORAGE_KEY = 'comparison-key-type';
const SECTION_CRITERION_STORAGE_KEY = 'section-match-criterion';
const STORY_AXIS_CRITERION_STORAGE_KEY = 'story-axis-match-criterion';
const CROSS_SOFTWARE_MODE_STORAGE_KEY = 'cross-software-mode';

/**
 * 比較キータイプ管理クラス
 * シングルトンパターンで実装
 */
export class ComparisonKeyManager {
  constructor() {
    // 現在のキータイプ
    this.currentKeyType = this.loadFromStorage();

    // 現在の断面一致基準（部材レベル）
    this.currentSectionMatchCriterion = this.loadSectionCriterionFromStorage();

    // 現在の通り芯・階の判定基準（名前 or 幾何位置）
    this.currentStoryAxisMatchCriterion = this.loadStoryAxisCriterionFromStorage();

    // 断面対応付け基準とは独立した、断面定義の階名正準化設定
    this.currentCrossSoftwareMode =
      storageHelper.get(CROSS_SOFTWARE_MODE_STORAGE_KEY, false) === true;
    setCrossSoftwareConfig({ enabled: this.currentCrossSoftwareMode });

    // 変更通知用のリスナー
    this.changeListeners = new Set();

    // 断面一致基準の変更通知用リスナー
    this.sectionCriterionChangeListeners = new Set();

    // 通り芯・階の判定基準の変更通知用リスナー
    this.storyAxisCriterionChangeListeners = new Set();

    this.crossSoftwareModeChangeListeners = new Set();
  }

  /**
   * storageHelperからキータイプを読み込む
   * @returns {string} 比較キータイプ
   * @private
   */
  loadFromStorage() {
    const saved = storageHelper.get(STORAGE_KEY);
    if (saved && Object.values(COMPARISON_KEY_TYPE).includes(saved)) {
      return saved;
    }
    return DEFAULT_COMPARISON_KEY_TYPE;
  }

  /**
   * storageHelperにキータイプを保存する
   * @param {string} keyType - 比較キータイプ
   * @private
   */
  saveToStorage(keyType) {
    storageHelper.set(STORAGE_KEY, keyType);
  }

  /**
   * storageHelperから断面一致基準を読み込む
   * @returns {string} 断面一致基準
   * @private
   */
  loadSectionCriterionFromStorage() {
    const saved = storageHelper.get(SECTION_CRITERION_STORAGE_KEY);
    if (saved && Object.values(SECTION_MATCH_CRITERION).includes(saved)) {
      return saved;
    }
    return DEFAULT_SECTION_MATCH_CRITERION;
  }

  /**
   * storageHelperから通り芯・階の判定基準を読み込む
   * @returns {string} 通り芯・階の判定基準
   * @private
   */
  loadStoryAxisCriterionFromStorage() {
    const saved = storageHelper.get(STORY_AXIS_CRITERION_STORAGE_KEY);
    if (saved && Object.values(STORY_AXIS_MATCH_CRITERION).includes(saved)) {
      return saved;
    }
    return DEFAULT_STORY_AXIS_MATCH_CRITERION;
  }

  /**
   * 現在の比較キータイプを取得
   * @returns {string} 比較キータイプ
   */
  getKeyType() {
    return this.currentKeyType;
  }

  /**
   * 現在の断面一致基準を取得
   * @returns {string} 断面一致基準（SECTION_MATCH_CRITERION の値）
   */
  getSectionMatchCriterion() {
    return this.currentSectionMatchCriterion;
  }

  /**
   * 断面一致基準を設定
   * @param {string} criterion - 断面一致基準（SECTION_MATCH_CRITERION の値）
   * @returns {boolean} 設定成功フラグ
   */
  setSectionMatchCriterion(criterion) {
    if (!Object.values(SECTION_MATCH_CRITERION).includes(criterion)) {
      log.error(`[ComparisonKeyManager] Invalid section match criterion: ${criterion}`);
      return false;
    }

    const oldCriterion = this.currentSectionMatchCriterion;
    if (oldCriterion === criterion) {
      return true;
    }

    this.currentSectionMatchCriterion = criterion;
    storageHelper.set(SECTION_CRITERION_STORAGE_KEY, criterion);
    this.notifySectionCriterionChange(criterion, oldCriterion);

    return true;
  }

  /**
   * 断面一致基準の変更通知リスナーを登録
   * @param {Function} callback - コールバック関数 (newCriterion, oldCriterion) => void
   */
  onSectionCriterionChange(callback) {
    if (typeof callback === 'function') {
      this.sectionCriterionChangeListeners.add(callback);
    }
  }

  /**
   * 断面一致基準の変更通知リスナーを削除
   * @param {Function} callback - コールバック関数
   */
  offSectionCriterionChange(callback) {
    this.sectionCriterionChangeListeners.delete(callback);
  }

  /**
   * 断面一致基準の変更を通知
   * @param {string} newCriterion - 新しい基準
   * @param {string} oldCriterion - 古い基準
   * @private
   */
  notifySectionCriterionChange(newCriterion, oldCriterion) {
    const event = new CustomEvent(COMPARISON_KEY_EVENTS.SECTION_MATCH_CRITERION_CHANGED, {
      detail: { newCriterion, oldCriterion },
    });
    document.dispatchEvent(event);

    this.sectionCriterionChangeListeners.forEach((callback) => {
      try {
        callback(newCriterion, oldCriterion);
      } catch (error) {
        log.error('[ComparisonKeyManager] Error in section criterion change listener:', error);
      }
    });
  }

  /**
   * 現在の通り芯・階の判定基準を取得
   * @returns {string} 通り芯・階の判定基準（STORY_AXIS_MATCH_CRITERION の値）
   */
  getStoryAxisMatchCriterion() {
    return this.currentStoryAxisMatchCriterion;
  }

  /**
   * 異ソフト間の階名正準化が有効かどうかを取得する。
   * @returns {boolean}
   */
  getCrossSoftwareMode() {
    return this.currentCrossSoftwareMode;
  }

  /**
   * 異ソフト間の階名正準化を、断面の対応付け基準とは独立して設定する。
   * @param {boolean} enabled
   * @returns {boolean} 設定成功フラグ
   */
  setCrossSoftwareMode(enabled) {
    if (typeof enabled !== 'boolean') return false;
    const oldEnabled = this.currentCrossSoftwareMode;
    if (oldEnabled === enabled) return true;

    this.currentCrossSoftwareMode = enabled;
    storageHelper.set(CROSS_SOFTWARE_MODE_STORAGE_KEY, enabled);
    setCrossSoftwareConfig({ enabled });
    this.notifyCrossSoftwareModeChange(enabled, oldEnabled);
    return true;
  }

  onCrossSoftwareModeChange(callback) {
    if (typeof callback === 'function') this.crossSoftwareModeChangeListeners.add(callback);
  }

  offCrossSoftwareModeChange(callback) {
    this.crossSoftwareModeChangeListeners.delete(callback);
  }

  notifyCrossSoftwareModeChange(enabled, oldEnabled) {
    document.dispatchEvent(
      new CustomEvent(COMPARISON_KEY_EVENTS.CROSS_SOFTWARE_MODE_CHANGED, {
        detail: { enabled, oldEnabled },
      }),
    );
    this.crossSoftwareModeChangeListeners.forEach((callback) => {
      try {
        callback(enabled, oldEnabled);
      } catch (error) {
        log.error('[ComparisonKeyManager] Error in cross software mode listener:', error);
      }
    });
  }

  /**
   * 通り芯・階の判定基準を設定
   * @param {string} criterion - STORY_AXIS_MATCH_CRITERION の値
   * @returns {boolean} 設定成功フラグ
   */
  setStoryAxisMatchCriterion(criterion) {
    if (!Object.values(STORY_AXIS_MATCH_CRITERION).includes(criterion)) {
      log.error(`[ComparisonKeyManager] Invalid story/axis match criterion: ${criterion}`);
      return false;
    }

    const oldCriterion = this.currentStoryAxisMatchCriterion;
    if (oldCriterion === criterion) {
      return true;
    }

    this.currentStoryAxisMatchCriterion = criterion;
    storageHelper.set(STORY_AXIS_CRITERION_STORAGE_KEY, criterion);
    this.notifyStoryAxisCriterionChange(criterion, oldCriterion);

    return true;
  }

  /**
   * 通り芯・階の判定基準の変更通知リスナーを登録
   * @param {Function} callback - コールバック関数 (newCriterion, oldCriterion) => void
   */
  onStoryAxisCriterionChange(callback) {
    if (typeof callback === 'function') {
      this.storyAxisCriterionChangeListeners.add(callback);
    }
  }

  /**
   * 通り芯・階の判定基準の変更通知リスナーを削除
   * @param {Function} callback - コールバック関数
   */
  offStoryAxisCriterionChange(callback) {
    this.storyAxisCriterionChangeListeners.delete(callback);
  }

  /**
   * 通り芯・階の判定基準の変更を通知
   * @param {string} newCriterion - 新しい基準
   * @param {string} oldCriterion - 古い基準
   * @private
   */
  notifyStoryAxisCriterionChange(newCriterion, oldCriterion) {
    const event = new CustomEvent(COMPARISON_KEY_EVENTS.STORY_AXIS_MATCH_CRITERION_CHANGED, {
      detail: { newCriterion, oldCriterion },
    });
    document.dispatchEvent(event);

    this.storyAxisCriterionChangeListeners.forEach((callback) => {
      try {
        callback(newCriterion, oldCriterion);
      } catch (error) {
        log.error('[ComparisonKeyManager] Error in story/axis criterion change listener:', error);
      }
    });
  }

  /**
   * 比較キータイプを設定
   * @param {string} keyType - 比較キータイプ
   * @returns {boolean} 設定成功フラグ
   */
  setKeyType(keyType) {
    // 入力検証
    if (!Object.values(COMPARISON_KEY_TYPE).includes(keyType)) {
      log.error(`[ComparisonKeyManager] Invalid key type: ${keyType}`);
      return false;
    }

    const oldKeyType = this.currentKeyType;
    if (oldKeyType === keyType) {
      return true;
    }

    // 設定を変更
    this.currentKeyType = keyType;

    // 保存
    this.saveToStorage(keyType);

    // 変更通知
    this.notifyChange(keyType, oldKeyType);

    return true;
  }

  /**
   * 位置情報ベース（節点位置のみ/+オフセット/+オフセット+回転のいずれか）かどうかを判定
   * @returns {boolean} 位置情報ベースならtrue
   */
  isPositionBased() {
    return (
      this.currentKeyType === COMPARISON_KEY_TYPE.POSITION_NODE_ONLY ||
      this.currentKeyType === COMPARISON_KEY_TYPE.POSITION_WITH_OFFSET ||
      this.currentKeyType === COMPARISON_KEY_TYPE.POSITION_WITH_ROTATE
    );
  }

  /**
   * GUIDベースかどうかを判定
   * @returns {boolean} GUIDベースならtrue
   */
  isGuidBased() {
    return this.currentKeyType === COMPARISON_KEY_TYPE.GUID_BASED;
  }

  /**
   * 変更通知リスナーを登録
   * @param {Function} callback - コールバック関数 (newKeyType, oldKeyType) => void
   */
  onChange(callback) {
    if (typeof callback === 'function') {
      this.changeListeners.add(callback);
    }
  }

  /**
   * 変更通知リスナーを削除
   * @param {Function} callback - コールバック関数
   */
  offChange(callback) {
    this.changeListeners.delete(callback);
  }

  /**
   * 変更を通知
   * @param {string} newKeyType - 新しいキータイプ
   * @param {string} oldKeyType - 古いキータイプ
   * @private
   */
  notifyChange(newKeyType, oldKeyType) {
    // カスタムイベントを発行
    const event = new CustomEvent(COMPARISON_KEY_EVENTS.KEY_TYPE_CHANGED, {
      detail: { newKeyType, oldKeyType },
    });
    document.dispatchEvent(event);

    // 登録されたリスナーを実行
    this.changeListeners.forEach((callback) => {
      try {
        callback(newKeyType, oldKeyType);
      } catch (error) {
        log.error('[ComparisonKeyManager] Error in change listener:', error);
      }
    });
  }

  /**
   * デフォルト値にリセット
   */
  reset() {
    this.setKeyType(DEFAULT_COMPARISON_KEY_TYPE);
    this.setSectionMatchCriterion(DEFAULT_SECTION_MATCH_CRITERION);
    this.setStoryAxisMatchCriterion(DEFAULT_STORY_AXIS_MATCH_CRITERION);
    this.setCrossSoftwareMode(false);
  }

  /**
   * デバッグ情報を取得
   * @returns {Object} デバッグ情報
   */
  getDebugInfo() {
    return {
      currentKeyType: this.currentKeyType,
      currentSectionMatchCriterion: this.currentSectionMatchCriterion,
      currentStoryAxisMatchCriterion: this.currentStoryAxisMatchCriterion,
      currentCrossSoftwareMode: this.currentCrossSoftwareMode,
      isPositionBased: this.isPositionBased(),
      isGuidBased: this.isGuidBased(),
      listenerCount: this.changeListeners.size,
      sectionCriterionListenerCount: this.sectionCriterionChangeListeners.size,
      crossSoftwareModeListenerCount: this.crossSoftwareModeChangeListeners.size,
    };
  }
}

// シングルトンインスタンスをエクスポート
const comparisonKeyManager = new ComparisonKeyManager();

// 開発者向けにwindowに公開
if (typeof window !== 'undefined') {
  window.comparisonKeyManager = comparisonKeyManager;
}

export default comparisonKeyManager;
