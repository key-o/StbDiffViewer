/**
 * @fileoverview barArrangementExtractor ベースの配筋情報抽出
 *
 * 主筋・あばら筋・腹筋を barArrangementExtractor の3段階属性フォールバック
 * （v2.0.2 → v1.x → legacy）で抽出する。modern(2.1.x)/legacy(2.0.2子要素) 双方から共有される。
 */

import { querySelectorAll } from '../sectionListUtils.js';
import {
  extractBeamMainBar,
  extractStirrupInfo as extractStirrupInfoFromBar,
  extractWebBarInfo as extractWebBarInfoFromBar,
} from '../../../common-stb/utils/barArrangementExtractor.js';

/**
 * 指定した位置の主筋要素を検索
 * @param {Element} simpleBarElement - StbSecBarBeamSimple要素
 * @param {string} pos - 位置（TOP/BOTTOM）
 * @param {number} order - order値
 * @returns {Element|null}
 */
export function findMainBarElement(simpleBarElement, pos, order) {
  const mainBars = querySelectorAll(simpleBarElement, 'StbSecBarBeamSimpleMain');

  for (const bar of mainBars) {
    const barPos = bar.getAttribute('pos');
    const barOrder = parseInt(bar.getAttribute('order')) || 1;

    if (barPos === pos && barOrder === order) {
      return bar;
    }
  }

  // STB v2.0.2形式のフォールバック
  const mainBarElements = querySelectorAll(simpleBarElement, 'StbSecBarGirder_RC_Same_Main');
  for (const bar of mainBarElements) {
    const barPos = bar.getAttribute('pos') || bar.getAttribute('position');
    if (barPos === pos) {
      return bar;
    }
  }

  return null;
}

/**
 * 主筋情報を抽出（barArrangementExtractorベース）
 * 3段階属性フォールバック: v2.0.2 → v1.x → legacy
 * @param {Element} mainBarElement - StbSecBarBeamSimpleMain要素
 * @returns {Object} 主筋情報
 */
export function extractMainBarInfo(mainBarElement) {
  if (!mainBarElement) {
    return { count: 0, dia: null, grade: null };
  }

  // barArrangementExtractor の3段階フォールバックを使用
  const barInfo = extractBeamMainBar(mainBarElement);

  // v2.0.2 と v2.1.0 の両方の属性名対応
  const count =
    parseInt(
      mainBarElement.getAttribute('N') ||
        mainBarElement.getAttribute('count_main') ||
        barInfo.N_main_X,
    ) || 0;
  const dia =
    (
      mainBarElement.getAttribute('D_bar') ||
      mainBarElement.getAttribute('D') ||
      barInfo.D_main
    )?.toUpperCase() || null;
  const grade =
    mainBarElement.getAttribute('strength') || mainBarElement.getAttribute('grade') || null;

  return {
    count,
    dia,
    grade,
  };
}

/**
 * スターラップ情報を抽出（barArrangementExtractorベース）
 * 3段階属性フォールバック: v2.0.2 → v1.x → legacy
 * @param {Element} simpleBarElement - StbSecBarBeamSimple要素
 * @param {number} order - order値
 * @returns {Object|null} スターラップ情報
 */
export function extractStirrupInfo(simpleBarElement, _order) {
  if (!simpleBarElement) {
    return null;
  }

  // barArrangementExtractor の3段階フォールバックを使用
  const stirrupInfo = extractStirrupInfoFromBar(simpleBarElement);

  // 径を確定（v2.0.2と v2.1.0の両方に対応）
  const dStirrup =
    simpleBarElement.getAttribute('D_stirrup') ||
    simpleBarElement.getAttribute('D_band') ||
    stirrupInfo.D_stirrup;

  if (!dStirrup) {
    return null;
  }

  // 本数
  const nStirrup =
    parseInt(
      simpleBarElement.getAttribute('N_stirrup') ||
        simpleBarElement.getAttribute('N_band') ||
        stirrupInfo.N_stirrup,
    ) || 0;

  // 間隔
  const pitchStirrup =
    parseFloat(
      simpleBarElement.getAttribute('pitch_stirrup') ||
        simpleBarElement.getAttribute('pitch_band') ||
        stirrupInfo.spacing,
    ) || null;

  // グレード
  const gradeStirrup =
    simpleBarElement.getAttribute('strength_stirrup') ||
    simpleBarElement.getAttribute('strength_band') ||
    null;

  return {
    dia: dStirrup.toUpperCase(),
    pitch: pitchStirrup,
    count: nStirrup,
    grade: gradeStirrup,
  };
}

/**
 * 腹筋情報を抽出（barArrangementExtractorベース）
 * 3段階属性フォールバック: v2.0.2 → v1.x → legacy
 * @param {Element} simpleBarElement - StbSecBarBeamSimple要素
 * @param {number} order - order値
 * @returns {Object|null} 腹筋情報
 */
export function extractWebBarInfo(simpleBarElement, _order) {
  if (!simpleBarElement) {
    return null;
  }

  // barArrangementExtractor の3段階フォールバックを使用
  const webBarInfo = extractWebBarInfoFromBar(simpleBarElement);

  // 径を確定
  const dWeb = simpleBarElement.getAttribute('D_web') || webBarInfo.D_web;

  if (!dWeb) {
    return null;
  }

  // 本数
  const nWeb = parseInt(simpleBarElement.getAttribute('N_web') || webBarInfo.N_web) || 0;

  if (nWeb <= 0) {
    return null;
  }

  // グレード
  const gradeWeb = simpleBarElement.getAttribute('strength_web') || null;

  return {
    dia: dWeb.toUpperCase(),
    count: nWeb,
    grade: gradeWeb,
  };
}
