/**
 * @fileoverview RC梁断面詳細の抽出ディスパッチャ
 *
 * StbSecBeam_RC / StbSecGirder_RC から断面詳細を抽出する。まず現行(2.1.x)形式を試み、
 * 該当しなければ旧形式（テーパー/ハンチ/直線 図形 + 配筋）へフォールバックする。
 */

import { querySelector, querySelectorAll } from '../sectionListUtils.js';
import { extractModernBeamSectionDetail } from './modernSectionDetail.js';
import {
  extractMultiplePositionFigures,
  extractStartEndPositionFigures,
  extractHaunchPositionFigures,
  extractSinglePositionFigure,
} from './figureExtractors.js';
import { extractBeamBarArrangement } from './legacyBarArrangement.js';

function readBooleanAttribute(element, name) {
  const value = String(element?.getAttribute?.(name) ?? '')
    .trim()
    .toLowerCase();
  return value === 'true' || value === '1';
}

/**
 * RC梁断面の詳細情報を抽出（STB v2.0.2と v2.1の両対応）
 * @param {Element} sectionElement - StbSecBeam_RC または StbSecGirder_RC要素
 * @returns {Object} 断面詳細データ
 */
export function extractRcBeamSectionDetail(sectionElement) {
  const id = sectionElement.getAttribute('id');
  const name = sectionElement.getAttribute('name');
  const strengthConcrete = sectionElement.getAttribute('strength_concrete') || null;
  const kindBeam = sectionElement.getAttribute('kind_beam') || 'GIRDER';
  const isFoundation = readBooleanAttribute(sectionElement, 'isFoundation');
  const isCanti = readBooleanAttribute(sectionElement, 'isCanti');

  const result = {
    id,
    name,
    beamType: kindBeam,
    isFoundation,
    isCanti,
    concrete: {
      strength: strengthConcrete,
    },
    positionPattern: 'UNKNOWN',
    positions: {},
  };

  // STB v2.1 は Figure / BarArrangement 自身の order で位置を表す。
  // 先に現行形式を処理し、該当しない場合のみ旧形式へフォールバックする。
  const isModernFormat = extractModernBeamSectionDetail(sectionElement, result);

  if (!isModernFormat) {
    // 寸法と配筋情報の抽出
    // STB v2.0.2: StbSecGirder_RC → StbSecGirder_RC_Straight
    const figureElement =
      querySelector(sectionElement, 'StbSecFigureBeam_RC') ||
      querySelector(sectionElement, 'StbSecFigureGirder_RC');

    if (!figureElement) {
      return result;
    }

    // STB v2.1形式: 複数のStbSecBeam_RC_Straight_NotSame要素（order属性付き）
    const straightNotSameElements = querySelectorAll(
      figureElement,
      'StbSecBeam_RC_Straight_NotSame',
    );
    if (straightNotSameElements.length > 0) {
      extractMultiplePositionFigures(straightNotSameElements, result, 'STB_V21');
    } else {
      // STB v2.0.2形式: テーパー形状（始端・終端）
      const taperElements = querySelectorAll(figureElement, 'StbSecBeam_RC_Taper');
      if (taperElements.length > 0) {
        extractStartEndPositionFigures(taperElements, result);
      } else {
        // STB v2.0.2形式: ハンチ形状（複数位置、pos属性付き）
        const haunchElements = querySelectorAll(figureElement, 'StbSecBeam_RC_Haunch');
        if (haunchElements.length > 0) {
          extractHaunchPositionFigures(haunchElements, result);
        } else {
          // STB v2.0.2形式: StbSecBeam_RC_Straight, StbSecGirder_RC_Straight（order属性なし、単一）
          const straightSameElement =
            querySelector(figureElement, 'StbSecBeam_RC_Straight_Same') ||
            querySelector(figureElement, 'StbSecBeam_RC_Straight') ||
            querySelector(figureElement, 'StbSecGirder_RC_Straight');
          if (straightSameElement) {
            extractSinglePositionFigure(straightSameElement, result, 'SAME');
          }
        }
      }
    }
    // 配筋情報の抽出
    const barArrangementElement =
      querySelector(sectionElement, 'StbSecBarArrangementBeam_RC') ||
      querySelector(sectionElement, 'StbSecBarArrangementGirder_RC');

    if (barArrangementElement) {
      extractBeamBarArrangement(barArrangementElement, result);
    }
  }

  // 位置構成パターンを判定
  if (!result.positionPattern || result.positionPattern === 'UNKNOWN') {
    determinePositionPattern(result);
  }

  return result;
}

/**
 * 位置構成パターンを判定（SAME/END_CENTER/THREE等）
 * @param {Object} result - 結果オブジェクト
 */
function determinePositionPattern(result) {
  const orders = result.orders || [1];

  if (orders.length === 1) {
    result.positionPattern = 'SAME';
  } else if (orders.length === 2) {
    result.positionPattern = 'END_CENTER';
  } else if (orders.length === 3) {
    result.positionPattern = 'THREE';
  } else {
    result.positionPattern = `MULTI_${orders.length}`;
  }
}
