/**
 * @fileoverview 梁断面の位置・寸法フィギュア抽出
 *
 * ハンチ／テーパー／複数位置（Straight_NotSame）／単一位置の各フィギュア要素から
 * result.positions / result.orders を組み立てる。STB v2.0.2 と v2.1 の図形形式に対応する。
 */

import { getPositionName } from './beamSectionHelpers.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('data:extractors:beamSectionListExtractor');

/**
 * ハンチ形状の図形情報を抽出（STB v2.0.2形式）
 * @param {Element[]} haunchElements - StbSecBeam_RC_Haunch要素の配列
 * @param {Object} result - 結果オブジェクト
 */
export function extractHaunchPositionFigures(haunchElements, result) {
  const positionMap = {
    START: 'LEFT',
    CENTER: 'CENTER',
    END: 'RIGHT',
  };

  const orders = [];

  haunchElements.forEach((el) => {
    const posAttr = el.getAttribute('pos');
    const position = positionMap[posAttr] || 'SAME';
    const width = parseFloat(el.getAttribute('width')) || 0;
    const depth = parseFloat(el.getAttribute('depth')) || 0;

    // orderを決定（START=1, CENTER=2, END=3）
    let order = 1;
    if (posAttr === 'START') order = 1;
    else if (posAttr === 'CENTER') order = 2;
    else if (posAttr === 'END') order = 3;

    orders.push(order);
    result.positions[position] = {
      order: order,
      width,
      depth,
      topBar: null,
      bottomBar: null,
      stirrup: null,
      webBar: null,
    };
  });

  // 複数位置を昇順でソート
  result.orders = orders.sort((a, b) => a - b);
}

/**
 * STB v2.0.2テーパー形状の始端・終端寸法を抽出
 * @param {Element[]} taperElements - StbSecBeam_RC_Taper要素の配列
 * @param {Object} result - 結果オブジェクト
 */
export function extractStartEndPositionFigures(taperElements, result) {
  const positionMap = { START: 'LEFT', END: 'RIGHT' };
  const orderMap = { START: 1, END: 2 };

  taperElements.forEach((element) => {
    const pos = element.getAttribute('pos');
    const position = positionMap[pos];
    if (!position) return;

    result.positions[position] = {
      order: orderMap[pos],
      width: parseFloat(element.getAttribute('width')) || 0,
      depth: parseFloat(element.getAttribute('depth')) || 0,
      topBar: null,
      bottomBar: null,
      stirrup: null,
      webBar: null,
    };
  });

  result.orders = Object.values(result.positions)
    .map(({ order }) => order)
    .sort((a, b) => a - b);
  result.positionPattern = 'START_END';
}

/**
 * 複数位置の図形情報を抽出（STB v2.1形式）
 * @param {Element[]} straightElements - StbSecBeam_RC_Straight_NotSame要素の配列
 * @param {Object} result - 結果オブジェクト
 */
export function extractMultiplePositionFigures(straightElements, result) {
  const orders = [];

  straightElements.forEach((el, index) => {
    const orderAttr = el.getAttribute('order');
    const order = orderAttr !== null ? parseInt(orderAttr, 10) : -1;
    const width = parseFloat(el.getAttribute('width')) || 0;
    const depth = parseFloat(el.getAttribute('depth')) || 0;

    // order属性がない場合はインデックスを使用
    let finalOrder = order;
    if (order < 0) {
      finalOrder = index + 1;
      log.warn('[beamSectionListExtractor] No order attribute, using index:', {
        index,
        finalOrder,
        width,
        depth,
      });
    }

    if (finalOrder > 0) {
      orders.push(finalOrder);
      const position = getPositionName(finalOrder, straightElements.length);
      result.positions[position] = {
        order: finalOrder,
        width,
        depth,
        topBar: null,
        bottomBar: null,
        stirrup: null,
        webBar: null,
      };
    }
  });

  // 複数位置を昇順でソート
  result.orders = orders.sort((a, b) => a - b);
}

/**
 * 単一位置の図形情報を抽出（STB v2.0.2形式）
 * @param {Element} straightElement - StbSecGirder_RC_Straight要素
 * @param {Object} result - 結果オブジェクト
 * @param {string} positionName - 位置名（SAME）
 */
export function extractSinglePositionFigure(straightElement, result, positionName = 'SAME') {
  const width = parseFloat(straightElement.getAttribute('width')) || 0;
  const depth = parseFloat(straightElement.getAttribute('depth')) || 0;

  result.positions[positionName] = {
    order: 1,
    width,
    depth,
    topBar: null,
    bottomBar: null,
    stirrup: null,
    webBar: null,
  };
  result.orders = [1];
}
