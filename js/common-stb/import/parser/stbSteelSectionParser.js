/**
 * @fileoverview STB 鋼材断面パーサーモジュール
 *
 * 鋼材断面データの抽出と寸法情報の正規化を提供します:
 * - StbSecSteel要素からの鋼材形状データ抽出
 * - H鋼・角鋼管・パイプ等の断面寸法正規化
 *
 * @module common/stb/parser/stbSteelSectionParser
 */

import { getLogger, parseElements } from './stbParserCore.js';
import { normalizeSteelDimensions } from '../data/steelDimensionNormalizers.js';

// --- 鋼材形状データ抽出関数 ---
/**
 * 鋼材形状データを抽出する
 *
 * **用途**:
 * - 3D立体表示: H鋼・角鋼管などの正確な断面形状メッシュ生成
 * - 線分表示: 簡略化された構造線の太さ・スタイル設定
 * - 断面設計: 構造計算・断面性能表示
 *
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @return {Map} 鋼材名をキーとする形状データのマップ
 */
export function extractSteelSections(xmlDoc) {
  const logger = getLogger();
  const steelSections = new Map();
  if (!xmlDoc) {
    logger.warn('[Data] 鋼材断面: XMLドキュメントが未定義です');
    return steelSections;
  }

  // StbSecSteel 要素を取得（StbSecSteel または StbSecSteel_S）
  let steelSectionList = null;

  if (typeof xmlDoc.querySelector === 'function') {
    steelSectionList = xmlDoc.querySelector('StbSecSteel_S') || xmlDoc.querySelector('StbSecSteel');
  }

  if (!steelSectionList) {
    steelSectionList =
      parseElements(xmlDoc, 'StbSecSteel_S')[0] || parseElements(xmlDoc, 'StbSecSteel')[0] || null;
  }

  if (steelSectionList) {
    const children = steelSectionList.children || steelSectionList.childNodes || [];
    const elementChildren = Array.from(children).filter((node) => node.nodeType === 1);

    for (const steelEl of elementChildren) {
      const name = steelEl.getAttribute('name');

      if (name) {
        const sectionData = {
          elementTag: steelEl.tagName,
          shapeTypeAttr: steelEl.getAttribute('type'),
          name: name,
        };

        // 数値属性リスト（ST-Bridge標準の断面寸法パラメータ）
        const numericAttrs = ['A', 'B', 'D', 't', 't1', 't2', 'r', 'r1', 'r2', 'H'];

        const attrs = Array.from(steelEl.attributes || []);
        for (const attr of attrs) {
          if (attr.name !== 'type' && attr.name !== 'name') {
            // 数値属性は数値に変換して保存
            if (numericAttrs.includes(attr.name)) {
              const numVal = parseFloat(attr.value);
              sectionData[attr.name] = isFinite(numVal) ? numVal : attr.value;
            } else {
              sectionData[attr.name] = attr.value;
            }
          }
        }

        // 形状タイプ(kind_struct)をタグ/属性から推定
        const tag = (sectionData.elementTag || '').toUpperCase();
        let kind = undefined;
        if (tag.includes('ROLL-H') || tag.includes('BUILD-H') || tag.includes('_H')) kind = 'H';
        else if (tag.includes('ROLL-BOX') || tag.includes('BUILD-BOX') || tag.includes('_BOX'))
          kind = 'BOX';
        else if (tag.includes('PIPE')) kind = 'PIPE';
        else if (
          tag.includes('ROLL-C') ||
          tag.includes('BUILD-C') ||
          tag.includes('_C') ||
          tag.includes('LIPC')
        )
          kind = 'C';
        else if (tag.includes('ROLL-L') || tag.includes('BUILD-L') || tag.includes('_L'))
          kind = 'L';
        else if (tag.includes('ROLL-T') || tag.includes('BUILD-T') || tag.includes('_T'))
          kind = 'T';
        else if (tag.includes('FLATBAR')) kind = 'FB';
        else if (tag.includes('ROUNDBAR')) kind = 'CIRCLE';

        // type属性で判別できる場合の対応
        const typeAttr = (sectionData.shapeTypeAttr || '').toUpperCase();
        if (!kind && (typeAttr === 'BCR' || typeAttr === 'BCP')) kind = 'BOX';
        if (!kind && typeAttr === 'H') kind = 'H';
        if (kind) sectionData.kind_struct = kind;

        // 正規化された寸法情報を追加
        const normalizedDims = normalizeSteelDimensions(sectionData, kind);
        if (normalizedDims) {
          sectionData.dimensions = normalizedDims;
        }

        steelSections.set(name, sectionData);
      } else {
        logger.warn(`[Data] 鋼材断面: name属性が不足 (tagName=${steelEl.tagName})`);
      }
    }
  } else {
    logger.log('[Load] 鋼材断面: StbSecSteel要素なし');
  }
  logger.log(`[Load] 鋼材断面読込完了: ${steelSections.size}種類`);
  return steelSections;
}
