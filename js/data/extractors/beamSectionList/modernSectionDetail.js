/**
 * @fileoverview STB 2.1.x 形式のRC梁断面・配筋抽出
 *
 * Figure / BarArrangement 自身の order を位置として扱う現行形式の抽出ロジック。
 * Simple/Complex 双方の配筋（主筋・あばら筋・腹筋）に対応する。
 */

import { querySelector, querySelectorAll } from '../sectionListUtils.js';
import { parsePositiveInteger, getPositionName, extractBeamCover } from './beamSectionHelpers.js';
import { extractStirrupInfo, extractWebBarInfo } from './barInfoExtractors.js';

/**
 * STB 2.1.x形式のRC梁断面・配筋を抽出
 *
 * Figure / BarArrangement の order を位置として扱い、Figureが1つで
 * BarArrangementのみが複数の場合は同じ断面寸法を各位置に適用する。
 * @param {Element} sectionElement - StbSecBeam_RC要素
 * @param {Object} result - 結果オブジェクト
 * @returns {boolean} STB 2.1.x形式を処理した場合true
 */
export function extractModernBeamSectionDetail(sectionElement, result) {
  const figureEntries = querySelectorAll(sectionElement, 'StbSecFigureBeam_RC')
    .map((figure, index) => {
      const straight = querySelector(figure, 'StbSecBeamStraight');
      const taper = querySelector(figure, 'StbSecBeamTaper');
      if (!straight && !taper) return null;

      return {
        order: parsePositiveInteger(figure.getAttribute('order'), index + 1),
        straight,
        taper,
      };
    })
    .filter(Boolean);

  if (figureEntries.length === 0) {
    return false;
  }

  const barEntries = querySelectorAll(sectionElement, 'StbSecBarArrangementBeam_RC')
    .map((arrangement, index) => {
      const simple = querySelector(arrangement, 'StbSecBarBeamSimple');
      const complex = querySelector(arrangement, 'StbSecBarBeamComplex');
      if (!simple && !complex) return null;
      return {
        order: parsePositiveInteger(arrangement.getAttribute('order'), index + 1),
        arrangement,
        simple,
        complex,
      };
    })
    .filter(Boolean);

  const orderSet = new Set([
    ...figureEntries.map((entry) => entry.order),
    ...barEntries.map((entry) => entry.order),
  ]);
  const orders = Array.from(orderSet).sort((a, b) => a - b);
  const singleTaper = orders.length === 1 && figureEntries.length === 1 && figureEntries[0].taper;
  const effectiveOrders = singleTaper ? [orders[0], orders[0] + 1] : orders;

  result.orders = effectiveOrders;

  effectiveOrders.forEach((order, index) => {
    const position = singleTaper
      ? index === 0
        ? 'LEFT'
        : 'RIGHT'
      : getPositionName(index + 1, effectiveOrders.length);
    const figureEntry =
      figureEntries.find((entry) => entry.order === order) ||
      (figureEntries.length === 1 ? figureEntries[0] : figureEntries[index]);
    const dimensions = extractModernFigureDimensions(figureEntry, index, effectiveOrders.length);

    result.positions[position] = {
      order,
      width: dimensions.width,
      depth: dimensions.depth,
      topBar: null,
      bottomBar: null,
      stirrup: null,
      webBar: null,
    };

    const barEntry =
      barEntries.find((entry) => entry.order === order) ||
      (barEntries.length === 1 ? barEntries[0] : barEntries[index]);
    if (barEntry) {
      extractModernBarData(barEntry, result.positions[position]);
      result.positions[position].cover = extractBeamCover(
        barEntry.arrangement,
        barEntry.simple || barEntry.complex,
      );
    }
  });

  if (barEntries.length > 0) {
    result.cover = extractBeamCover(
      barEntries[0].arrangement,
      barEntries[0].simple || barEntries[0].complex,
    );
  }
  if (singleTaper) {
    result.positionPattern = 'TAPER';
  }

  return true;
}

/**
 * STB 2.1.x Figureから描画位置の寸法を取得
 * @param {Object} figureEntry - Figure抽出情報
 * @param {number} positionIndex - 位置インデック
 * @param {number} positionCount - 位置数
 * @returns {{width:number, depth:number}}
 */
function extractModernFigureDimensions(figureEntry, positionIndex, positionCount) {
  if (figureEntry?.straight) {
    return {
      width: parseFloat(figureEntry.straight.getAttribute('width')) || 0,
      depth: parseFloat(figureEntry.straight.getAttribute('depth')) || 0,
    };
  }

  if (figureEntry?.taper) {
    const startWidth = parseFloat(figureEntry.taper.getAttribute('start_width')) || 0;
    const startDepth = parseFloat(figureEntry.taper.getAttribute('start_depth')) || 0;
    const endWidth = parseFloat(figureEntry.taper.getAttribute('end_width')) || startWidth;
    const endDepth = parseFloat(figureEntry.taper.getAttribute('end_depth')) || startDepth;
    const ratio = positionCount <= 1 ? 0 : positionIndex / (positionCount - 1);
    return {
      width: startWidth + (endWidth - startWidth) * ratio,
      depth: startDepth + (endDepth - startDepth) * ratio,
    };
  }

  return { width: 0, depth: 0 };
}

/**
 * STB 2.1.x Simple配筋を単一位置データに抽出
 * @param {Object} barEntry - Simple / Complex配筋抽出情報
 * @param {Object} positionData - 位置データ
 */
function extractModernBarData(barEntry, positionData) {
  if (barEntry.simple) {
    positionData.topBar = extractModernMainBar(barEntry.simple, 'TOP');
    positionData.bottomBar = extractModernMainBar(barEntry.simple, 'BOTTOM');
    positionData.stirrup = extractStirrupInfo(barEntry.simple);
    positionData.webBar = extractWebBarInfo(barEntry.simple);
    return;
  }

  positionData.topBar = extractModernComplexMainBar(barEntry.complex, 'TOP');
  positionData.bottomBar = extractModernComplexMainBar(barEntry.complex, 'BOTTOM');
  positionData.stirrup = extractModernComplexStirrup(barEntry.complex);
  positionData.webBar = extractModernComplexWebBar(barEntry.complex);
}

/**
 * STB 2.1.x主筋をstep順に集約（2段筋対応）
 * @param {Element} simpleBarElement - StbSecBarBeamSimple要素
 * @param {string} pos - TOP / BOTTOM
 * @returns {Object|null}
 */
function extractModernMainBar(simpleBarElement, pos) {
  const bars = querySelectorAll(simpleBarElement, 'StbSecBarBeamSimpleMain')
    .filter((bar) => bar.getAttribute('pos') === pos)
    .sort(
      (a, b) =>
        parsePositiveInteger(a.getAttribute('step'), 1) -
        parsePositiveInteger(b.getAttribute('step'), 1),
    );

  if (bars.length === 0) return null;

  const layers = bars
    .map((bar) => ({
      step: parsePositiveInteger(bar.getAttribute('step'), 1),
      count: parseInt(bar.getAttribute('N'), 10) || 0,
      dia: bar.getAttribute('D')?.toUpperCase() || null,
      grade: bar.getAttribute('strength') || null,
    }))
    .filter((layer) => layer.count > 0);

  const representative = layers[0];
  const count1st = layers
    .filter((layer) => layer.step === 1)
    .reduce((sum, layer) => sum + layer.count, 0);
  const count2nd = layers
    .filter((layer) => layer.step === 2)
    .reduce((sum, layer) => sum + layer.count, 0);
  const count = layers.reduce((sum, layer) => sum + layer.count, 0);

  if (!representative || count <= 0) return null;

  return {
    count,
    count1st,
    count2nd,
    dia: representative.dia,
    grade: representative.grade,
    layers,
  };
}

/**
 * STB 2.1.x Complex主筋の各Line/Locを層データへ集約
 * @param {Element} complexBarElement - StbSecBarBeamComplex要素
 * @param {string} pos - TOP / BOTTOM
 * @returns {Object|null}
 */
function extractModernComplexMainBar(complexBarElement, pos) {
  const main = querySelectorAll(complexBarElement, 'StbSecBarBeamComplexMain').find(
    (element) => element.getAttribute('pos') === pos,
  );
  if (!main) return null;

  const layers = querySelectorAll(main, 'StbSecBarBeamComplexMainLine')
    .map((line) => {
      const locations = querySelectorAll(line, 'StbSecBarBeamComplexMainLoc')
        .map((location) => parseFloat(location.getAttribute('distance')))
        .filter(Number.isFinite);
      return {
        step: parsePositiveInteger(line.getAttribute('step'), 1),
        count: locations.length,
        dia: line.getAttribute('D')?.toUpperCase() || null,
        grade: line.getAttribute('strength') || null,
        depth: parseFloat(line.getAttribute('depth')) || 0,
        locations,
      };
    })
    .filter((layer) => layer.count > 0)
    .sort((a, b) => a.step - b.step);

  const representative = layers[0];
  if (!representative) return null;

  return {
    count: layers.reduce((sum, layer) => sum + layer.count, 0),
    count1st: layers
      .filter((layer) => layer.step === 1)
      .reduce((sum, layer) => sum + layer.count, 0),
    count2nd: layers
      .filter((layer) => layer.step === 2)
      .reduce((sum, layer) => sum + layer.count, 0),
    dia: representative.dia,
    grade: representative.grade,
    layers,
  };
}

/**
 * STB 2.1.x Complexあばら筋を集約
 * @param {Element} complexBarElement - StbSecBarBeamComplex要素
 * @returns {Object|null}
 */
function extractModernComplexStirrup(complexBarElement) {
  const stirrup = querySelector(complexBarElement, 'StbSecBarBeamComplexStirrup');
  if (!stirrup) return null;
  const locations = querySelectorAll(stirrup, 'StbSecBarBeamComplexStirrupLoc')
    .map((location) => parseFloat(location.getAttribute('distance')))
    .filter(Number.isFinite);
  const dia = stirrup.getAttribute('D');
  const pitch = parseFloat(stirrup.getAttribute('pitch')) || 0;
  if (!dia || pitch <= 0 || locations.length === 0) return null;

  return {
    dia: dia.toUpperCase(),
    pitch,
    count: locations.length,
    grade: stirrup.getAttribute('strength') || null,
    locations,
  };
}

/**
 * STB 2.1.x Complex腹筋を集約
 * @param {Element} complexBarElement - StbSecBarBeamComplex要素
 * @returns {Object|null}
 */
function extractModernComplexWebBar(complexBarElement) {
  const web = querySelector(complexBarElement, 'StbSecBarBeamComplexWeb');
  if (!web) return null;
  const locations = querySelectorAll(web, 'StbSecBarBeamComplexWebLoc')
    .map((location) => parseFloat(location.getAttribute('distance')))
    .filter(Number.isFinite);
  const dia = web.getAttribute('D');
  if (!dia || locations.length === 0) return null;

  return {
    dia: dia.toUpperCase(),
    count: locations.length,
    grade: web.getAttribute('strength') || null,
    locations,
  };
}
