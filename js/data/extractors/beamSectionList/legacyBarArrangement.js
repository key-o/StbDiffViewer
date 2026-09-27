/**
 * @fileoverview STB v2.0.2 形式の梁配筋抽出
 *
 * Same / ThreeTypes / StartEnd の直接属性形式と、v2.1.0 の子要素形式を判別し、
 * 主筋・あばら筋・腹筋・かぶりを result へ格納する。子要素形式は barInfoExtractors を用いる。
 */

import { querySelector, querySelectorAll } from '../sectionListUtils.js';
import { captureLegacyBeamAuxiliaryFacts } from '../rebar3d/beamAuxiliaryPlacement.js';
import { resolveReinforcementStrength } from '../reinforcementStrengthResolver.js';
import { extractBeamCover, getPositionName, ordinal } from './beamSectionHelpers.js';
import {
  findMainBarElement,
  extractMainBarInfo,
  extractStirrupInfo,
  extractWebBarInfo,
} from './barInfoExtractors.js';

/**
 * 梁の配筋情報を抽出
 * @param {Element} barArrangementElement - StbSecBarArrangementBeam_RC要素
 * @param {Object} result - 結果オブジェクト
 */
export function extractBeamBarArrangement(barArrangementElement, result) {
  // STB v2.1: StbSecBarBeamSimple
  let simpleBarElement = querySelector(barArrangementElement, 'StbSecBarBeamSimple');
  let isV202Format = false;

  // STB v2.0.2: StbSecBarBeam_RC_Same or StbSecBarBeam_RC_ThreeTypes
  if (!simpleBarElement) {
    simpleBarElement = querySelector(barArrangementElement, 'StbSecBarBeam_RC_Same');
    isV202Format = !!simpleBarElement;
  }

  // STB v2.0.2: 位置別の直接属性形式
  let hasPositionedBars = false;
  if (!simpleBarElement) {
    const threeTypes = querySelectorAll(barArrangementElement, 'StbSecBarBeam_RC_ThreeTypes');
    if (threeTypes.length > 0) {
      hasPositionedBars = true;
      extractLegacyPositionedBars(
        threeTypes,
        result,
        { START: 'LEFT', CENTER: 'CENTER', END: 'RIGHT' },
        { START: 1, CENTER: 2, END: 3 },
      );
      result.positionPattern = 'THREE';
    } else {
      const startEnd = querySelectorAll(barArrangementElement, 'StbSecBarBeam_RC_StartEnd');
      if (startEnd.length > 0) {
        hasPositionedBars = true;
        extractLegacyPositionedBars(
          startEnd,
          result,
          { START: 'LEFT', END: 'RIGHT' },
          { START: 1, END: 2 },
        );
        result.positionPattern = 'START_END';
      }
    }
  }

  if (simpleBarElement) {
    // STB v2.0.2形式：直接属性から読み込み
    if (isV202Format) {
      extractBarDataFromDirectAttributes(simpleBarElement, result);
    } else {
      // STB v2.1.0形式：子要素から読み込み
      extractBarDataFromChildElements(simpleBarElement, result);
    }

    result.cover = extractBeamCover(barArrangementElement, simpleBarElement);
  }

  if (hasPositionedBars && !result.cover) {
    result.cover = extractBeamCover(barArrangementElement, null);
  }
}

/**
 * STB v2.0.2の位置別配筋を既存または共通寸法から生成した位置へ格納
 * @param {Element[]} barElements - 位置別配筋要素
 * @param {Object} result - 断面抽出結果
 * @param {Object<string,string>} positionMap - pos属性から位置キーへの対応
 * @param {Object<string,number>} orderMap - pos属性から表示順への対応
 */
function extractLegacyPositionedBars(barElements, result, positionMap, orderMap) {
  const samePosition = result.positions.SAME;
  const sourcePositions = barElements
    .map((element) => element.getAttribute('pos'))
    .filter((pos) => positionMap[pos]);

  if (samePosition && sourcePositions.length > 0) {
    delete result.positions.SAME;
    result.orders = [];

    sourcePositions.forEach((pos) => {
      const position = positionMap[pos];
      const order = orderMap[pos];
      if (result.positions[position]) return;

      result.positions[position] = {
        ...samePosition,
        order,
        topBar: null,
        bottomBar: null,
        stirrup: null,
        webBar: null,
      };
      result.orders.push(order);
    });
  }

  // 形状側と配筋側の位置数が異なる場合も、既存寸法から不足位置を補う。
  // 例: Taper（START/END）+ ThreeTypes（START/CENTER/END）。
  sourcePositions.forEach((pos) => {
    const position = positionMap[pos];
    if (result.positions[position]) {
      result.positions[position].order = orderMap[pos];
      return;
    }

    const left = result.positions.LEFT;
    const right = result.positions.RIGHT;
    const fallback = left || right || result.positions.CENTER;
    if (!fallback) return;

    result.positions[position] = {
      ...fallback,
      order: orderMap[pos],
      width:
        position === 'CENTER' && left && right
          ? (Number(left.width) + Number(right.width)) / 2
          : fallback.width,
      depth:
        position === 'CENTER' && left && right
          ? (Number(left.depth) + Number(right.depth)) / 2
          : fallback.depth,
      topBar: null,
      bottomBar: null,
      stirrup: null,
      webBar: null,
    };
  });

  result.orders = Object.values(result.positions)
    .map(({ order }) => order)
    .sort((a, b) => a - b);

  barElements.forEach((element) => {
    const position = positionMap[element.getAttribute('pos')];
    if (position && result.positions[position]) {
      extractBarDataFromDirectAttributesSingle(element, result.positions[position]);
    }
  });
}

/**
 * STB v2.0.2形式：直接属性から配筋情報を抽出
 * @param {Element} barElement - StbSecBarBeam_RC_Same or StbSecBarBeam_RC_ThreeTypes要素
 * @param {Object} result - 結果オブジェクト
 */
function extractBarDataFromDirectAttributes(barElement, result) {
  // STB v2.0.2では全位置で同じ鉄筋データを使用
  const positions = ['SAME', 'LEFT', 'CENTER', 'RIGHT'].filter((p) => result.positions[p]);

  positions.forEach((position) => {
    const positionData = result.positions[position];

    positionData.topBar = extractLegacyMainBar(barElement, 'top');
    positionData.bottomBar = extractLegacyMainBar(barElement, 'bottom');

    positionData.stirrup = extractLegacyStirrup(barElement);
    positionData.webBar = extractLegacyWebBar(barElement);
    captureLegacyBeamAuxiliaryFacts(barElement, positionData);
  });
}

/**
 * STB v2.0.2 ThreeTypes形式：単一位置の配筋情報を直接属性から抽出
 * @param {Element} barElement - StbSecBarBeam_RC_ThreeTypes要素（個別位置）
 * @param {Object} positionData - 位置データオブジェクト
 */
function extractBarDataFromDirectAttributesSingle(barElement, positionData) {
  positionData.topBar = extractLegacyMainBar(barElement, 'top');
  positionData.bottomBar = extractLegacyMainBar(barElement, 'bottom');
  positionData.stirrup = extractLegacyStirrup(barElement);
  positionData.webBar = extractLegacyWebBar(barElement);
  captureLegacyBeamAuxiliaryFacts(barElement, positionData);
}

/**
 * STB v2.0.2直接属性からあばら筋を抽出（欠損属性はnull保持）
 * @param {Element} barElement - Same / ThreeTypes / StartEnd配筋要素
 * @returns {Object|null} あばら筋データ
 */
function extractLegacyStirrup(barElement) {
  const count = parseInt(barElement.getAttribute('N_stirrup')) || 0;
  if (count <= 0) return null;

  const dia = barElement.getAttribute('D_stirrup')?.toUpperCase() || null;
  const grade = resolveReinforcementStrength({
    element: barElement,
    diameter: dia,
    explicitStrength: barElement.getAttribute('strength_stirrup'),
  }).value;

  return {
    count,
    dia,
    pitch: parseInt(barElement.getAttribute('pitch_stirrup')) || null,
    grade: grade?.toUpperCase() || null,
  };
}

/**
 * STB v2.0.2直接属性から腹筋を抽出（欠損属性はnull保持）
 * @param {Element} barElement - Same / ThreeTypes / StartEnd配筋要素
 * @returns {Object|null} 腹筋データ
 */
function extractLegacyWebBar(barElement) {
  const count = parseInt(barElement.getAttribute('N_web')) || 0;
  if (count <= 0) return null;

  const dia = barElement.getAttribute('D_web')?.toUpperCase() || null;
  const grade = resolveReinforcementStrength({
    element: barElement,
    diameter: dia,
    explicitStrength: barElement.getAttribute('strength_web'),
  }).value;

  return {
    count,
    dia,
    grade: grade?.toUpperCase() || null,
  };
}

/**
 * STB v2.0.2の主筋属性を最大3段まで抽出
 * @param {Element} barElement - Same / ThreeTypes / StartEnd配筋要素
 * @param {'top'|'bottom'} side - 上端または下端
 * @returns {Object|null} 主筋データ
 */
function extractLegacyMainBar(barElement, side) {
  const dia = barElement.getAttribute('D_main')?.toUpperCase() || null;
  const grade =
    resolveReinforcementStrength({
      element: barElement,
      diameter: dia,
      explicitStrength: barElement.getAttribute('strength_main'),
    }).value?.toUpperCase() || null;
  const secondDia = barElement.getAttribute('D_2nd_main')?.toUpperCase() || null;
  const secondGrade =
    resolveReinforcementStrength({
      element: barElement,
      diameter: secondDia || dia,
      explicitStrength:
        barElement.getAttribute('strength_2nd_main') ||
        (!secondDia ? barElement.getAttribute('strength_main') : null),
    }).value?.toUpperCase() || null;
  const primaryCounts = [1, 2, 3].map(
    (step) => parseInt(barElement.getAttribute(`N_main_${side}_${ordinal(step)}`), 10) || 0,
  );
  const secondaryCounts = [1, 2, 3].map(
    (step) => parseInt(barElement.getAttribute(`N_2nd_main_${side}_${ordinal(step)}`), 10) || 0,
  );
  const layers = [];

  primaryCounts.forEach((primaryCount, index) => {
    const groups = [];
    if (primaryCount > 0) groups.push({ count: primaryCount, dia, grade });
    if (secondaryCounts[index] > 0) {
      const secondaryGroup = {
        count: secondaryCounts[index],
        dia: secondDia || dia,
        grade: secondGrade,
      };
      const compatibleGroup = groups.find(
        (group) => group.dia === secondaryGroup.dia && group.grade === secondaryGroup.grade,
      );
      if (compatibleGroup) {
        compatibleGroup.count += secondaryGroup.count;
      } else {
        groups.push(secondaryGroup);
      }
    }
    if (groups.length === 0) return;

    layers.push({
      step: index + 1,
      count: groups.reduce((sum, group) => sum + group.count, 0),
      dia: groups[0].dia,
      grade: groups[0].grade,
      ...(groups.length > 1 ? { barGroups: groups } : {}),
    });
  });

  const counts = primaryCounts.map((value, index) => value + secondaryCounts[index]);
  const count = counts.reduce((sum, value) => sum + value, 0);

  if (count <= 0) return null;

  return {
    count,
    count1st: counts[0],
    count2nd: counts[1],
    count3rd: counts[2],
    dia,
    grade,
    layers,
  };
}

/**
 * STB v2.1.0形式：子要素から配筋情報を抽出
 * @param {Element} simpleBarElement - StbSecBarBeamSimple要素
 * @param {Object} result - 結果オブジェクト
 */
function extractBarDataFromChildElements(simpleBarElement, result) {
  // 各位置ごとに配筋情報を抽出
  result.orders.forEach((order) => {
    const position = getPositionName(order, result.orders.length);
    const positionData = result.positions[position];

    if (positionData) {
      // 上端筋
      const topBarElement = findMainBarElement(simpleBarElement, 'TOP', order);
      if (topBarElement) {
        positionData.topBar = extractMainBarInfo(topBarElement);
      }

      // 下端筋
      const bottomBarElement = findMainBarElement(simpleBarElement, 'BOTTOM', order);
      if (bottomBarElement) {
        positionData.bottomBar = extractMainBarInfo(bottomBarElement);
      }

      // スターラップ（order属性が直下 or 内部）
      const stirrupInfo = extractStirrupInfo(simpleBarElement, order);
      if (stirrupInfo) {
        positionData.stirrup = stirrupInfo;
      }

      // 腹筋（存在する場合のみ）
      const webBarInfo = extractWebBarInfo(simpleBarElement, order);
      if (webBarInfo) {
        positionData.webBar = webBarInfo;
      }
    }
  });
}
