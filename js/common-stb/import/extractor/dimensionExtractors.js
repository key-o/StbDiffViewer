/**
 * @fileoverview 断面寸法抽出ヘルパー
 *
 * S造・RC造・杭断面の寸法抽出ロジックを提供します。
 * sectionExtractor.js から分離された専用モジュールです。
 *
 * @module common/stb/parser/dimensionExtractors
 */

import { deriveDimensionsFromAttributes } from '../data/dimensionNormalizer.js';
import {
  getElementChildren,
  findFigureElement,
  collectChildrenByTag,
  sortByIdOrder,
} from './utils/domTraversal.js';

// ---------------- 追加ヘルパー: S造断面寸法抽出 ----------------
/**
 * steelFigureInfoからS造断面の寸法を抽出
 * @param {Object} steelFigureInfo - SectionShapeProcessorからの出力
 * @returns {Object|null} 寸法オブジェクト {H, A, B, t1, t2, r, ...}
 */
export function extractSteelDimensions(steelFigureInfo) {
  if (!steelFigureInfo) return null;

  // クロスH断面（shape_X / shape_Y）の場合は専用処理
  if (steelFigureInfo.crossH) {
    const { shapeX, shapeY } = steelFigureInfo.crossH;
    return {
      profile_hint: 'CROSS_H',
      crossH_shapeX: shapeX,
      crossH_shapeY: shapeY || shapeX,
    };
  }

  // T形複合断面（shape_H / shape_T + direction_type）の場合は専用処理
  // H形鋼とT形鋼を組み合わせた断面。T形鋼のウェブは必ずH形鋼に接合される。
  if (steelFigureInfo.shapeT) {
    const { shapeH, shapeT, directionType, offsetHX, offsetHY, offsetT } = steelFigureInfo.shapeT;
    return {
      profile_hint: 'SHAPE_T',
      shapeT_shapeH: shapeH,
      shapeT_shapeT: shapeT,
      shapeT_direction: directionType || 'T1',
      shapeT_offsetHX: offsetHX || 0,
      shapeT_offsetHY: offsetHY || 0,
      shapeT_offsetT: offsetT || 0,
    };
  }

  // 優先順位: same > notSame[0] > beamMultiSection[0] > variants[0]
  let sourceVariant = null;

  if (steelFigureInfo.same) {
    sourceVariant = steelFigureInfo.same;
  } else if (steelFigureInfo.notSame && steelFigureInfo.notSame.length > 0) {
    sourceVariant = steelFigureInfo.notSame[0];
  } else if (steelFigureInfo.beamMultiSection && steelFigureInfo.beamMultiSection.length > 0) {
    sourceVariant = steelFigureInfo.beamMultiSection[0];
  } else if (steelFigureInfo.variants && steelFigureInfo.variants.length > 0) {
    sourceVariant = steelFigureInfo.variants[0];
  }

  if (!sourceVariant) return null;

  const dims = {};

  // 鋼材寸法の標準属性名
  const steelAttrs = ['H', 'A', 'B', 't1', 't2', 'r', 'D', 'd', 't'];

  // 属性はsourceVariant.attributesに格納されている
  const attrSource = sourceVariant.attributes || sourceVariant;

  for (const attr of steelAttrs) {
    if (attrSource[attr] !== undefined) {
      const val = parseFloat(attrSource[attr]);
      if (isFinite(val)) {
        dims[attr] = val;
      }
    }
  }

  // 形状タイプからプロファイルヒントを設定
  if (sourceVariant.shape) {
    const shapeName = sourceVariant.shape.toUpperCase();
    if (shapeName.includes('H-') || shapeName.startsWith('H ') || /^H\d/.test(shapeName)) {
      dims.profile_hint = 'H';
    } else if (
      shapeName.includes('BOX') ||
      shapeName.includes('□') ||
      shapeName.includes('BCP') ||
      shapeName.includes('BCR')
    ) {
      dims.profile_hint = 'BOX';
    } else if (
      shapeName.includes('PIPE') ||
      shapeName.includes('○') ||
      shapeName.includes('STK') ||
      shapeName.startsWith('P-') ||
      shapeName.startsWith('P ')
    ) {
      dims.profile_hint = 'PIPE';
    } else if (shapeName.includes('[-') || shapeName.startsWith('C ') || /^C\d/.test(shapeName)) {
      dims.profile_hint = 'C';
    } else if (shapeName.includes('L-') || shapeName.startsWith('L ') || /^L\d/.test(shapeName)) {
      dims.profile_hint = 'L';
    } else if (shapeName.includes('T-') || /^(T|CT)\d/.test(shapeName)) {
      dims.profile_hint = 'T';
    } else if (
      shapeName.includes('FB-') ||
      shapeName.startsWith('FB ') ||
      /^FB\d/.test(shapeName)
    ) {
      dims.profile_hint = 'FB';
    } else if (
      shapeName.includes('RB-') ||
      shapeName.startsWith('RB ') ||
      /^RB\d/.test(shapeName)
    ) {
      dims.profile_hint = 'CIRCLE';
    }
  }

  // H形鋼の場合、幅と高さを設定
  if (dims.H && dims.B) {
    // H形鋼: H=せい、B=フランジ幅
    dims.height = dims.H;
    dims.width = dims.B;
  } else if (dims.A && dims.B) {
    // 角形鋼管など: A=せい、B=幅
    dims.height = dims.A;
    dims.width = dims.B;
  } else if (dims.D) {
    // 円形鋼管: D=直径
    dims.diameter = dims.D;
  } else if (dims.d) {
    dims.diameter = dims.d;
  }

  // 属性から寸法が取れなかった場合、shape名から解析
  if (!dims.width && !dims.height && !dims.diameter && sourceVariant.shape) {
    const parsedDims = parseDimensionsFromShapeName(sourceVariant.shape);
    if (parsedDims) {
      Object.assign(dims, parsedDims);
    }
  }

  return Object.keys(dims).length > 0 ? dims : null;
}

/**
 * 形状名から寸法を解析
 * 例: "H-250x250x9x14x13", "□-400x400x22x66", "P-100x10"
 * @param {string} shapeName - 形状名
 * @returns {Object|null} 寸法オブジェクト
 */
export function parseDimensionsFromShapeName(shapeName) {
  if (!shapeName) return null;

  const dims = {};

  // 数値部分を抽出（-の後の数値をxで分割）
  const match = shapeName.match(/[-]?([\d.]+(?:x[\d.]+)*)/);
  if (!match) return null;

  const numbers = match[1]
    .split('x')
    .map((n) => parseFloat(n))
    .filter((n) => isFinite(n));
  if (numbers.length === 0) return null;

  const upperName = shapeName.toUpperCase();

  // H形鋼: H-HxBxt1xt2xr
  if (upperName.startsWith('H-') || upperName.startsWith('H ') || /^H\d/.test(upperName)) {
    if (numbers.length >= 2) {
      dims.H = numbers[0];
      dims.B = numbers[1];
      dims.height = numbers[0];
      dims.width = numbers[1];
      if (numbers[2]) dims.t1 = numbers[2];
      if (numbers[3]) dims.t2 = numbers[3];
      if (numbers[4]) dims.r = numbers[4];
      dims.profile_hint = 'H';
    }
  }
  // 角形鋼管: □-AxBxtxr or BCP/BCR-AxBxt
  else if (
    upperName.includes('□') ||
    upperName.includes('BCP') ||
    upperName.includes('BCR') ||
    upperName.includes('BOX')
  ) {
    if (numbers.length >= 2) {
      dims.A = numbers[0];
      dims.B = numbers[1];
      dims.height = numbers[0];
      dims.width = numbers[1];
      if (numbers[2]) dims.t = numbers[2];
      if (numbers[3]) dims.r = numbers[3];
      dims.profile_hint = 'BOX';
    } else if (numbers.length === 1) {
      // 正方形の場合
      dims.A = numbers[0];
      dims.B = numbers[0];
      dims.height = numbers[0];
      dims.width = numbers[0];
      dims.profile_hint = 'BOX';
    }
  }
  // 円形鋼管: P-Dxt or ○-Dxt or STK-Dxt
  else if (
    upperName.startsWith('P-') ||
    upperName.startsWith('P ') ||
    upperName.includes('○') ||
    upperName.includes('STK')
  ) {
    if (numbers.length >= 1) {
      dims.D = numbers[0];
      dims.diameter = numbers[0];
      if (numbers[1]) dims.t = numbers[1];
      dims.profile_hint = 'PIPE';
    }
  }
  // C形鋼: [-HxBxt1xt2
  else if (upperName.includes('[-') || upperName.startsWith('C-') || upperName.startsWith('C ')) {
    if (numbers.length >= 2) {
      dims.H = numbers[0];
      dims.B = numbers[1];
      dims.height = numbers[0];
      dims.width = numbers[1];
      if (numbers[2]) dims.t1 = numbers[2];
      if (numbers[3]) dims.t2 = numbers[3];
      dims.profile_hint = 'C';
    }
  }
  // L形鋼: L-AxBxt
  else if (upperName.startsWith('L-') || upperName.startsWith('L ')) {
    if (numbers.length >= 2) {
      dims.A = numbers[0];
      dims.B = numbers[1];
      dims.height = numbers[0];
      dims.width = numbers[1];
      if (numbers[2]) dims.t = numbers[2];
      dims.profile_hint = 'L';
    }
  }
  // T形鋼やCT形鋼
  else if (upperName.startsWith('T-') || upperName.startsWith('CT-')) {
    if (numbers.length >= 2) {
      dims.H = numbers[0];
      dims.B = numbers[1];
      dims.height = numbers[0];
      dims.width = numbers[1];
      if (numbers[2]) dims.t1 = numbers[2];
      if (numbers[3]) dims.t2 = numbers[3];
      dims.profile_hint = 'T';
    }
  }
  // フラットバー（平鋼）: FB-Bxt
  else if (upperName.startsWith('FB-') || upperName.startsWith('FB ')) {
    if (numbers.length >= 2) {
      dims.B = numbers[0];
      dims.t = numbers[1];
      dims.width = numbers[0];
      dims.thickness = numbers[1];
      dims.profile_hint = 'FB';
    } else if (numbers.length === 1) {
      dims.B = numbers[0];
      dims.width = numbers[0];
      dims.profile_hint = 'FB';
    }
  }
  // 丸鋼（中実円）: RB-D
  else if (upperName.startsWith('RB-') || upperName.startsWith('RB ')) {
    if (numbers.length >= 1) {
      dims.D = numbers[0];
      dims.diameter = numbers[0];
      dims.profile_hint = 'CIRCLE';
    }
  }
  // 不明な形式でも数値があれば設定
  else if (numbers.length >= 2) {
    dims.height = numbers[0];
    dims.width = numbers[1];
  } else if (numbers.length === 1) {
    dims.diameter = numbers[0];
  }

  return Object.keys(dims).length > 0 ? dims : null;
}

// ---------------- 追加ヘルパー: コンクリート図形寸法抽出 ----------------
export function extractConcreteDimensions(element, config) {
  if (!config.concreteFigures || config.concreteFigures.length === 0) return null;
  let dims = null;
  for (const figSel of config.concreteFigures) {
    const fig = findFigureElement(element, figSel);
    if (!fig) continue;
    // 子要素内の shape を持つもの or 寸法属性を持つものを調査
    const candidates = getElementChildren(fig);
    for (const c of candidates) {
      const d = deriveDimensionsFromAttributes(c.attributes);
      if (d) {
        // 円/矩形のヒントをタグ名から付与
        if (/Circle/i.test(c.tagName)) d.profile_hint = 'CIRCLE';
        if (/Rect/i.test(c.tagName)) d.profile_hint = d.profile_hint || 'RECTANGLE';

        // 杭の直杭(Straight)で直径がある場合は円形プロファイル
        // StbSecPile_RC_Straightは名前にCircleを含まないが円形断面
        if (/Straight/i.test(c.tagName) && (d.diameter || d.D)) {
          d.profile_hint = d.profile_hint || 'CIRCLE';
        }

        // 拡底杭タイプをタグ名から判定
        const pileTypeFromTag = extractPileTypeFromTagName(c.tagName);
        if (pileTypeFromTag) {
          d.pile_type = pileTypeFromTag;
          // 直杭(Straight)は円形断面なのでprofile_hintを上書きしない
          // 拡底杭のみEXTENDED_PILEを設定
          if (pileTypeFromTag !== 'Straight') {
            d.profile_hint = 'EXTENDED_PILE';
          }
          d.pileTagName = c.tagName; // デバッグ用にタグ名も保存
        }

        dims = dims ? { ...dims, ...d } : d;
      }
    }
    // fig 自身の属性も確認
    const selfDims = deriveDimensionsFromAttributes(fig.attributes);
    if (selfDims) {
      if (/Circle/i.test(fig.tagName)) selfDims.profile_hint = 'CIRCLE';
      if (/Rect/i.test(fig.tagName)) selfDims.profile_hint = selfDims.profile_hint || 'RECTANGLE';

      // 杭の直杭(Straight)で直径がある場合は円形プロファイル
      if (/Straight/i.test(fig.tagName) && (selfDims.diameter || selfDims.D)) {
        selfDims.profile_hint = selfDims.profile_hint || 'CIRCLE';
      }

      // 拡底杭タイプをタグ名から判定
      const pileTypeFromTag = extractPileTypeFromTagName(fig.tagName);
      if (pileTypeFromTag) {
        selfDims.pile_type = pileTypeFromTag;
        // 直杭(Straight)は円形断面なのでprofile_hintを上書きしない
        // 拡底杭のみEXTENDED_PILEを設定
        if (pileTypeFromTag !== 'Straight') {
          selfDims.profile_hint = 'EXTENDED_PILE';
        }
        selfDims.pileTagName = fig.tagName;
      }

      dims = dims ? { ...dims, ...selfDims } : selfDims;
    }
  }
  return dims;
}

/**
 * RC/SRC梁のテーパー断面（START/END 2断面）寸法を抽出
 *
 * STB 2.1.0: <StbSecBeamTaper start_width=".." start_depth=".." end_width=".." end_depth=".."/>
 * STB 2.0.2: <StbSecBeam_RC_Taper pos="START" width=".." depth=".."/> ×2（START/END）
 *
 * @param {Element} element - 断面のDOM要素（StbSecBeam_RC / StbSecGirder_RC 等）
 * @param {Object} config - 抽出設定（concreteFigures配列を含む）
 * @returns {{start: Object, end: Object}|null} 始端・終端の寸法 {width, height, depth} または null
 */
export function extractConcreteTaperDimensions(element, config) {
  if (!config?.concreteFigures || config.concreteFigures.length === 0) return null;

  for (const figSel of config.concreteFigures) {
    const fig = findFigureElement(element, figSel);
    if (!fig) continue;

    const children = getElementChildren(fig);

    // STB 2.1.0 形式: 単一要素に start_*/end_* 属性
    for (const c of children) {
      if (!/Taper$/i.test(c.tagName || '')) continue;
      const startWidth = parseFloat(c.getAttribute('start_width'));
      const startDepth = parseFloat(c.getAttribute('start_depth'));
      const endWidth = parseFloat(c.getAttribute('end_width'));
      const endDepth = parseFloat(c.getAttribute('end_depth'));
      if ([startWidth, startDepth, endWidth, endDepth].every(isFinite)) {
        return {
          start: { width: startWidth, height: startDepth, depth: startDepth },
          end: { width: endWidth, height: endDepth, depth: endDepth },
        };
      }
    }

    // STB 2.0.2 形式: pos="START"/"END" の2要素（width/depth 属性）
    let start = null;
    let end = null;
    for (const c of children) {
      if (!/_Taper$/i.test(c.tagName || '')) continue;
      const pos = (c.getAttribute('pos') || '').toUpperCase();
      const width = parseFloat(c.getAttribute('width'));
      const depth = parseFloat(c.getAttribute('depth'));
      if (!isFinite(width) || !isFinite(depth)) continue;
      const sectionDims = { width, height: depth, depth };
      if (pos === 'START') start = sectionDims;
      else if (pos === 'END') end = sectionDims;
    }
    if (start && end) return { start, end };
  }

  return null;
}

/**
 * RC/SRC梁のハンチ断面（START/[CENTER]/END の2〜3断面）寸法を抽出
 *
 * STB 2.0.2: <StbSecBeam_RC_Haunch pos="START" width=".." depth=".."/> ×2〜3
 * Straight/Taper と異なり pos ごとに断面が変化しうるため、代表寸法へ潰さず
 * pos 別に保持する。多断面ジオメトリ生成と形状等価判定(GSS)で使用する。
 *
 * @param {Element} element - 断面のDOM要素（StbSecBeam_RC / StbSecGirder_RC 等）
 * @param {Object} config - 抽出設定（concreteFigures配列を含む）
 * @returns {Array<{pos:string, width:number, height:number, depth:number}>|null}
 *   pos 順（START→CENTER→END）で並べた寸法配列。該当2断面未満なら null
 */
export function extractConcreteHaunchDimensions(element, config) {
  if (!config?.concreteFigures || config.concreteFigures.length === 0) return null;

  const POS_ORDER = { START: 0, CENTER: 1, END: 2 };

  for (const figSel of config.concreteFigures) {
    const fig = findFigureElement(element, figSel);
    if (!fig) continue;

    const children = getElementChildren(fig);
    const stations = [];
    for (const c of children) {
      if (!/_Haunch$/i.test(c.tagName || '')) continue;
      const pos = (c.getAttribute('pos') || '').toUpperCase();
      if (!(pos in POS_ORDER)) continue;
      const width = parseFloat(c.getAttribute('width'));
      const depth = parseFloat(c.getAttribute('depth'));
      if (!isFinite(width) || !isFinite(depth)) continue;
      stations.push({ pos, width, height: depth, depth });
    }

    if (stations.length >= 2) {
      stations.sort((a, b) => POS_ORDER[a.pos] - POS_ORDER[b.pos]);
      return stations;
    }
  }

  return null;
}

/**
 * 鋼管杭(StbSecPile_S)の寸法データを抽出
 * 複数のStbSecPile_S_Straight要素からlength_pileを合計し、
 * 先頭要素からD（直径）とt（肉厚）を取得
 *
 * @param {Element} element - StbSecPile_S要素
 * @param {Object} config - 抽出設定
 * @returns {Object|null} 寸法データ { length_pile, D, t, diameter, profile_hint, pile_type, segments }
 */
export function extractSteelPileDimensions(element, _config) {
  const tagName = element.tagName || element.localName;

  // StbSecPile_S以外は処理しない
  if (tagName !== 'StbSecPile_S') {
    return null;
  }

  // StbSecFigurePile_S > StbSecPile_S_Straight の構造を探す
  const figureElement = findFigureElement(element, ['StbSecFigurePile_S']);

  if (!figureElement) {
    return null;
  }

  // StbSecPile_S_Straight 要素を収集
  const straightElements = collectChildrenByTag(
    figureElement,
    (tag) => tag === 'StbSecPile_S_Straight',
  );

  if (straightElements.length === 0) {
    return null;
  }

  // id_order でソート（昇順）
  sortByIdOrder(straightElements);

  // 各セグメントからデータを抽出し、合計長さを計算
  let totalLength = 0;
  const segments = [];

  for (const seg of straightElements) {
    const lengthPile = parseFloat(seg.getAttribute('length_pile') || '0');
    const D = parseFloat(seg.getAttribute('D') || '0');
    const t = parseFloat(seg.getAttribute('t') || '0');
    const idOrder = parseInt(seg.getAttribute('id_order') || '0', 10);

    if (lengthPile > 0) {
      totalLength += lengthPile;
    }

    segments.push({
      id_order: idOrder,
      length_pile: lengthPile,
      D: D,
      t: t,
    });
  }

  // 先頭セグメントからD（直径）を取得（杭頭部の直径）
  const firstSeg = segments[0];
  const D = firstSeg?.D || 0;
  const t = firstSeg?.t || 0;

  if (totalLength === 0 && D === 0) {
    return null;
  }

  const dims = {
    pile_type: 'Straight',
    profile_hint: 'CIRCLE',
  };

  if (totalLength > 0) {
    dims.length_pile = totalLength;
  }

  if (D > 0) {
    dims.D = D;
    dims.diameter = D;
    dims.radius = D / 2;
    dims.width = D;
    dims.height = D;
  }

  if (t > 0) {
    dims.t = t;
    dims.thickness = t;
  }

  // セグメント情報を保持（将来的に多段杭の可視化に使用可能）
  if (segments.length > 1) {
    dims.segments = segments;
    dims.segmentCount = segments.length;
  }

  return dims;
}

/**
 * 既製杭(StbSecPileProduct)の寸法データを抽出
 * 複数のStbSecPileProduct_*要素からlength_pileを合計し、
 * 先頭要素からD（直径）を取得
 *
 * 対応する既製杭タイプ:
 * - StbSecPileProduct_PHC (高強度プレストレストコンクリート杭)
 * - StbSecPileProduct_SC (鋼管ソイルセメント杭)
 * - StbSecPileProduct_CPRC (遠心力鉄筋コンクリート杭)
 * - StbSecPileProductNodular_PHC (節杭PHC)
 *
 * @param {Element} element - StbSecPileProduct要素
 * @param {Object} config - 抽出設定
 * @returns {Object|null} 寸法データ { length_pile, D, diameter, profile_hint, pile_type, segments }
 */
export function extractPileProductDimensions(element, _config) {
  const tagName = element.tagName || element.localName;

  // StbSecPileProduct以外は処理しない
  if (tagName !== 'StbSecPileProduct') {
    return null;
  }

  // StbSecFigurePileProduct を探す
  const figureElement = findFigureElement(element, 'StbSecFigurePileProduct');

  if (!figureElement) {
    return null;
  }

  // 既製杭セグメント要素を収集
  // StbSecPileProduct_PHC, StbSecPileProduct_SC, StbSecPileProduct_CPRC,
  // StbSecPileProductNodular_PHC など
  // StbSecPileProduct_ または StbSecPileProductNodular_ で始まる要素を収集
  const pileSegmentElements = collectChildrenByTag(figureElement, (tag) =>
    /^StbSecPileProduct/.test(tag),
  );

  if (pileSegmentElements.length === 0) {
    return null;
  }

  // id_order でソート（昇順）
  sortByIdOrder(pileSegmentElements);

  // 各セグメントからデータを抽出し、合計長さを計算
  let totalLength = 0;
  const segments = [];

  for (const seg of pileSegmentElements) {
    const lengthPile = parseFloat(seg.getAttribute('length_pile') || '0');
    // D, D1（節杭の場合の主径）のいずれかから直径を取得
    const D = parseFloat(seg.getAttribute('D') || seg.getAttribute('D1') || '0');
    // t, tc（コンクリート肉厚）のいずれかから肉厚を取得
    const t = parseFloat(seg.getAttribute('t') || seg.getAttribute('tc') || '0');
    const idOrder = parseInt(seg.getAttribute('id_order') || '0', 10);

    if (lengthPile > 0) {
      totalLength += lengthPile;
    }

    segments.push({
      id_order: idOrder,
      length_pile: lengthPile,
      D: D,
      t: t,
      tagName: seg.tagName || seg.localName,
    });
  }

  // 先頭セグメントからD（直径）を取得（杭頭部の直径）
  const firstSeg = segments[0];
  const D = firstSeg?.D || 0;
  const t = firstSeg?.t || 0;

  if (totalLength === 0 && D === 0) {
    return null;
  }

  const dims = {
    pile_type: 'Straight',
    profile_hint: 'CIRCLE',
  };

  if (totalLength > 0) {
    dims.length_pile = totalLength;
  }

  if (D > 0) {
    dims.D = D;
    dims.diameter = D;
    dims.radius = D / 2;
    dims.width = D;
    dims.height = D;
  }

  if (t > 0) {
    dims.t = t;
    dims.thickness = t;
  }

  // セグメント情報を保持（将来的に多段杭の可視化に使用可能）
  if (segments.length > 1) {
    dims.segments = segments;
    dims.segmentCount = segments.length;
  }

  return dims;
}

/**
 * タグ名から拡底杭タイプを抽出
 * @param {string} tagName - XML要素のタグ名
 * @returns {string|null} 杭タイプ ('ExtendedFoot', 'ExtendedTop', 'ExtendedTopFoot', 'Straight') または null
 */
export function extractPileTypeFromTagName(tagName) {
  if (!tagName) return null;

  // StbSecPile_RC_ExtendedTopFoot - 頭部・根固め部拡大杭（先に判定）
  if (/ExtendedTopFoot/i.test(tagName)) {
    return 'ExtendedTopFoot';
  }
  // StbSecPile_RC_ExtendedFoot - 根固め部拡大杭
  if (/ExtendedFoot/i.test(tagName)) {
    return 'ExtendedFoot';
  }
  // StbSecPile_RC_ExtendedTop - 頭部拡大杭
  if (/ExtendedTop/i.test(tagName)) {
    return 'ExtendedTop';
  }
  // StbSecPile_RC_Straight - 直杭
  if (/Pile.*Straight/i.test(tagName)) {
    return 'Straight';
  }

  return null;
}
