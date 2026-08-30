/**
 * @fileoverview 比較キータイプ選択UIモジュール
 *
 * このモジュールは要素の対応関係を決定するキータイプの選択UIを提供します：
 * - 位置情報ベース vs GUIDベースの選択
 * - 設定変更時の再比較トリガー
 * - 設定の永続化（SettingsManager経由）
 */

import {
  COMPARISON_KEY_TYPE,
  COMPARISON_KEY_TYPE_LABELS,
  COMPARISON_KEY_TYPE_DESCRIPTIONS,
  SECTION_MATCH_CRITERION,
  SECTION_MATCH_CRITERION_LABELS,
  SECTION_MATCH_CRITERION_DESCRIPTIONS,
  STORY_AXIS_MATCH_CRITERION,
  STORY_AXIS_MATCH_CRITERION_LABELS,
  STORY_AXIS_MATCH_CRITERION_DESCRIPTIONS,
} from '../../config/comparisonKeyConfig.js';
import comparisonKeyManager from '../../app/comparisonKeyManager.js';
import { COMPARISON_KEY_EVENTS } from '../../constants/eventTypes.js';
import { showError } from '../common/toast.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ui:panels:comparisonKeySelector');

/**
 * 比較キー選択UIを初期化する
 * @param {string} containerSelector - UIコンテナーのセレクター
 * @param {function} onKeyTypeChanged - キータイプ変更時のコールバック
 */
export function initializeComparisonKeySelector(containerSelector, onKeyTypeChanged) {
  const container = document.querySelector(containerSelector);
  if (!container) {
    log.warn(`[ComparisonKeySelector] Container not found: ${containerSelector}`);
    return;
  }

  // 現在の配置要素・断面対応・通り芯階の各基準を取得
  const currentKeyType = comparisonKeyManager.getKeyType();
  const currentSectionCriterion = comparisonKeyManager.getSectionMatchCriterion();
  const currentStoryAxisCriterion = comparisonKeyManager.getStoryAxisMatchCriterion();
  const currentCrossSoftwareMode = comparisonKeyManager.getCrossSoftwareMode();

  // UIを作成
  const selectorHTML = createSelectorHTML(
    currentKeyType,
    currentSectionCriterion,
    currentStoryAxisCriterion,
    currentCrossSoftwareMode,
  );
  container.innerHTML = selectorHTML;

  // イベントリスナーを設定
  setupEventListeners(container, onKeyTypeChanged);

  // 用語ヘルプ（フローティングウィンドウ）を登録。
  // トグルボタン(#comparison-glossary-btn)は上のHTMLに含まれるため、この時点で存在する。
  // floatingWindowManager は生成時に window を参照するため、DOM が用意された
  // 初期化タイミングで動的 import する（トップレベル import だとテスト環境で window 未定義になる）。
  import('./comparisonGlossaryWindow.js')
    .then(({ initializeComparisonGlossaryWindow }) => {
      initializeComparisonGlossaryWindow();
    })
    .catch((error) => {
      log.warn('[ComparisonKeySelector] 用語ヘルプウィンドウの初期化に失敗:', error);
    });
}

/**
 * ラジオグループのHTMLを生成する共通ヘルパー
 * @param {Object} enumObj - 値の enum
 * @param {Object} labels - 値→ラベル
 * @param {Object} descriptions - 値→説明
 * @param {string} radioName - input name 属性
 * @param {string} currentValue - 現在値
 * @returns {string} HTML
 */
function createRadioGroupHTML(enumObj, labels, descriptions, radioName, currentValue) {
  return Object.values(enumObj)
    .map((value) => {
      const isChecked = value === currentValue ? 'checked' : '';
      return `
        <div class="selector-option">
          <label class="radio-label">
            <input type="radio" name="${radioName}" value="${value}" ${isChecked} />
            <span class="radio-text">
              <strong>${labels[value]}</strong>
              <span class="radio-description">${descriptions[value]}</span>
            </span>
          </label>
        </div>
      `;
    })
    .join('');
}

/**
 * セレクターのHTMLを生成する
 * @param {string} currentKeyType - 現在のキータイプ
 * @returns {string} HTML文字列
 */
function createSelectorHTML(
  currentKeyType,
  currentSectionCriterion,
  currentStoryAxisCriterion,
  currentCrossSoftwareMode,
) {
  return `
    <div class="comparison-key-selector">
      <div class="selector-header">
        <label class="selector-label">配置要素の対応判定基準:</label>
        <button type="button" id="comparison-glossary-btn" class="selector-help-btn"
                aria-label="用語ヘルプを開く" title="用語ヘルプ（点/線/面基準・オフセット・許容差）">
          ❓ 用語ヘルプ
        </button>
      </div>
      <div class="selector-options">
        ${createRadioGroupHTML(
          COMPARISON_KEY_TYPE,
          COMPARISON_KEY_TYPE_LABELS,
          COMPARISON_KEY_TYPE_DESCRIPTIONS,
          'comparisonKeyType',
          currentKeyType,
        )}
      </div>

      <div class="selector-group selector-group-section">
        <div class="selector-header selector-header-section">
          <label class="selector-label">断面比較</label>
        </div>
        <div class="selector-subheader">
          <label class="selector-sublabel">断面の対応付け基準（部材）:</label>
        </div>
        <div class="selector-options">
          ${createRadioGroupHTML(
            SECTION_MATCH_CRITERION,
            SECTION_MATCH_CRITERION_LABELS,
            SECTION_MATCH_CRITERION_DESCRIPTIONS,
            'sectionMatchCriterion',
            currentSectionCriterion,
          )}
        </div>
        <div class="selector-info">
          <small>
            ※ 対応付け後の「同一ジオメトリ形状」「全属性の差分」は、設定条件ではなく比較結果として表示します
          </small>
        </div>
      </div>

      <div class="selector-group selector-group-cross-software">
        <div class="selector-header">
          <label class="selector-label">断面定義の結果正規化:</label>
        </div>
        <label class="checkbox-label">
          <input type="checkbox" name="crossSoftwareMode" ${currentCrossSoftwareMode ? 'checked' : ''} />
          <span>異ソフト間の階名表記差を吸収する</span>
        </label>
        <div class="selector-info">
          <small>StbSec.floor を StbStory の標高・順序で正規化します（断面の対応付け基準とは独立）</small>
        </div>
      </div>

      <div class="selector-group selector-group-story-axis">
        <div class="selector-header selector-header-story-axis">
          <label class="selector-label">通り芯・階の判定基準:</label>
        </div>
        <div class="selector-options">
          ${createRadioGroupHTML(
            STORY_AXIS_MATCH_CRITERION,
            STORY_AXIS_MATCH_CRITERION_LABELS,
            STORY_AXIS_MATCH_CRITERION_DESCRIPTIONS,
            'storyAxisMatchCriterion',
            currentStoryAxisCriterion,
          )}
        </div>
      </div>

      <div class="selector-info">
        <small>
          ※ 設定を変更すると自動的に再比較が実行されます
        </small>
      </div>
    </div>
  `;
}

/**
 * イベントリスナーを設定する
 * @param {Element} container - UIコンテナー
 * @param {function} onKeyTypeChanged - キータイプ変更時のコールバック
 */
function setupEventListeners(container, onKeyTypeChanged) {
  const radioButtons = container.querySelectorAll('input[name="comparisonKeyType"]');

  radioButtons.forEach((radio) => {
    radio.addEventListener('change', async (event) => {
      const newKeyType = event.target.value;
      await handleKeyTypeChange(newKeyType, onKeyTypeChanged);
    });
  });

  // グローバルイベントリスナー（他のタブでの変更を監視）
  document.addEventListener(COMPARISON_KEY_EVENTS.KEY_TYPE_CHANGED, (event) => {
    const { newKeyType } = event.detail;
    updateUISelection(container, 'comparisonKeyType', newKeyType);
  });

  // 断面一致基準のラジオ
  const sectionCriterionRadios = container.querySelectorAll('input[name="sectionMatchCriterion"]');
  sectionCriterionRadios.forEach((radio) => {
    radio.addEventListener('change', (event) => {
      const newCriterion = event.target.value;
      try {
        const success = comparisonKeyManager.setSectionMatchCriterion(newCriterion);
        if (!success) {
          throw new Error(`Invalid section match criterion: ${newCriterion}`);
        }
        log.info(`[ComparisonKeySelector] 断面一致基準を変更: ${newCriterion}`);
      } catch (error) {
        log.error('[ComparisonKeySelector] Failed to change section match criterion:', error);
        showError('断面一致基準の変更に失敗しました。詳細はコンソールを確認してください。');
      }
    });
  });

  // 断面一致基準変更の同期
  document.addEventListener(COMPARISON_KEY_EVENTS.SECTION_MATCH_CRITERION_CHANGED, (event) => {
    const { newCriterion } = event.detail;
    updateUISelection(container, 'sectionMatchCriterion', newCriterion);
  });

  const crossSoftwareCheckbox = container.querySelector('input[name="crossSoftwareMode"]');
  crossSoftwareCheckbox?.addEventListener('change', (event) => {
    const success = comparisonKeyManager.setCrossSoftwareMode(event.target.checked);
    if (!success) {
      event.target.checked = comparisonKeyManager.getCrossSoftwareMode();
      showError('階名正規化設定の変更に失敗しました。');
    }
  });

  document.addEventListener(COMPARISON_KEY_EVENTS.CROSS_SOFTWARE_MODE_CHANGED, (event) => {
    const checkbox = container.querySelector('input[name="crossSoftwareMode"]');
    if (checkbox) checkbox.checked = event.detail.enabled;
  });

  // 通り芯・階の判定基準のラジオ
  const storyAxisCriterionRadios = container.querySelectorAll(
    'input[name="storyAxisMatchCriterion"]',
  );
  storyAxisCriterionRadios.forEach((radio) => {
    radio.addEventListener('change', (event) => {
      const newCriterion = event.target.value;
      try {
        const success = comparisonKeyManager.setStoryAxisMatchCriterion(newCriterion);
        if (!success) {
          throw new Error(`Invalid story/axis match criterion: ${newCriterion}`);
        }
        log.info(`[ComparisonKeySelector] 通り芯・階の判定基準を変更: ${newCriterion}`);
      } catch (error) {
        log.error('[ComparisonKeySelector] Failed to change story/axis match criterion:', error);
        showError('通り芯・階の判定基準の変更に失敗しました。詳細はコンソールを確認してください。');
      }
    });
  });

  // 通り芯・階の判定基準変更の同期
  document.addEventListener(COMPARISON_KEY_EVENTS.STORY_AXIS_MATCH_CRITERION_CHANGED, (event) => {
    const { newCriterion } = event.detail;
    updateUISelection(container, 'storyAxisMatchCriterion', newCriterion);
  });
}

/**
 * キータイプ変更を処理する
 * @param {string} newKeyType - 新しいキータイプ
 * @param {function} onKeyTypeChanged - コールバック関数（async対応）
 */
async function handleKeyTypeChange(newKeyType, onKeyTypeChanged) {
  try {
    log.info(`[ComparisonKeySelector] requested key type change: ${newKeyType}`);

    // ComparisonKeyManagerに設定を保存（これによりイベントが発火される）
    const success = comparisonKeyManager.setKeyType(newKeyType);

    if (!success) {
      throw new Error(`Invalid key type: ${newKeyType}`);
    }

    // コールバックを実行（再比較をトリガー）
    if (typeof onKeyTypeChanged === 'function') {
      await onKeyTypeChanged(newKeyType);
    } else {
      log.warn('[ComparisonKeySelector] No callback provided for key type change');
    }
  } catch (error) {
    log.error('[ComparisonKeySelector] Failed to change key type:', error);
    showError('比較キータイプの変更に失敗しました。詳細はコンソールを確認してください。');
  }
}

/**
 * UI選択状態を更新する
 * @param {Element} container - UIコンテナー
 * @param {string} radioName - ラジオグループ名（comparisonKeyType / sectionMatchCriterion）
 * @param {string} value - 選択する値
 */
function updateUISelection(container, radioName, value) {
  const radioButtons = container.querySelectorAll(`input[name="${radioName}"]`);
  radioButtons.forEach((radio) => {
    radio.checked = radio.value === value;
  });
}
