/**
 * @fileoverview 統一断面抽出エンジン
 *
 * 設定駆動による統一的な断面データ抽出機能を提供します。
 * 従来の個別関数（extractColumnSections等）を統合し、
 * 重複コードを排除した効率的な実装を実現します。
 *
 * @module common/stb/parser/sectionExtractor
 */

import { resolveGeometryProfileTypeInPlace } from '../section/sectionTypeUtil.js';
import { getSectionConfig } from '../config/kernelConfig.js';
import {
  extractSteelDimensions,
  extractConcreteDimensions,
  extractConcreteTaperDimensions,
  extractConcreteHaunchDimensions,
  extractSteelPileDimensions,
  extractPileProductDimensions,
} from './dimensionExtractors.js';
import {
  extractSteelFigureVariants,
  findFigureElement,
  findFirstShapeElement,
  normalizeSectionMode,
  extractBasePlateData,
  extractSteelFigureOffsetLevel,
} from './steelFigureExtractors.js';
import { parseStbExtensions } from '../parser/stbParserCore.js';

// STB 名前空間（querySelector がヒットしない場合にフォールバック）
const STB_NS = 'https://www.building-smart.or.jp/dl';

import { createKernelLogger } from '../config/kernelConfig.js';

const _log = createKernelLogger('common-stb:extractor:sectionExtractor');

// 設定は kernelConfig 経由で取得（setSectionConfig で注入可能）
const _logger = {
  log: (...args) => _log.info(...args),
  debug: (...args) => _log.debug(...args),
  warn: (...args) => _log.warn(...args),
  error: (...args) => _log.error(...args),
};

const SECTION_RESULT_KEY_ALIASES = {
  FoundationColumn: ['foundationColumnSections', 'foundationcolumnSections'],
  IsolatingDevice: ['isolatingDeviceSections', 'isolatingdeviceSections'],
  DampingDevice: ['dampingDeviceSections', 'dampingdeviceSections'],
};

function getSectionResultKeys(elementType) {
  return SECTION_RESULT_KEY_ALIASES[elementType] || [`${elementType.toLowerCase()}Sections`];
}

/**
 * ドキュメント単位のキャッシュ（同一XMLドキュメントに対する重複抽出を防止）
 * 大規模モデル（HRC.stb等）ではロード中に3回以上呼ばれるため、
 * このキャッシュにより2回目以降の抽出をスキップする
 * @type {WeakMap<Document, Object>}
 */
const _extractAllSectionsCache = new WeakMap();

/**
 * 全要素タイプの断面データを一括抽出
 * 同一ドキュメントに対する2回目以降の呼び出しはキャッシュを返す
 * @param {Document} xmlDoc - パース済みのXMLドキュメント
 * @returns {Object} 全断面データマップ {columnSections: Map, girderSections: Map, beamSections: Map, braceSections: Map}
 */
export function extractAllSections(xmlDoc) {
  if (!xmlDoc) {
    _logger.warn('[Data] 断面抽出: XMLドキュメントが未定義です');
    return createEmptyResult();
  }

  // ドキュメント単位のキャッシュチェック
  if (_extractAllSectionsCache.has(xmlDoc)) {
    _logger.debug('[Data] 断面抽出: キャッシュヒット');
    return _extractAllSectionsCache.get(xmlDoc);
  }

  const result = {};

  // 設定に基づいて各要素タイプを処理
  Object.entries(getSectionConfig()).forEach(([elementType, config]) => {
    const sectionMap = extractSectionsByType(xmlDoc, elementType, config);
    const keys = getSectionResultKeys(elementType);
    keys.forEach((sectionKey) => {
      result[sectionKey] = sectionMap;
    });
  });

  logExtractionResults(result);

  // キャッシュに保存
  _extractAllSectionsCache.set(xmlDoc, result);

  return result;
}

/**
 * 指定要素タイプの断面のみ再抽出し、キャッシュ済み結果のMapをインプレース更新する。
 * 編集後のリアルタイム反映用（extractAllSections の全再抽出は大規模モデルで秒単位かかるため）。
 * Map参照を保持したまま中身を入れ替えるので、このMapを参照する全モジュール
 * （パースキャッシュ・globalState・比較キャッシュ）に自動的に反映される。
 * @param {Document} xmlDoc - 編集済みのXMLドキュメント
 * @param {string} elementType - SECTION_CONFIG のキー（'Column' 等）
 * @returns {Map|null} 更新後の断面Map（キャッシュ未生成・設定なしの場合は null）
 */
export function refreshSectionsForElementType(xmlDoc, elementType) {
  if (!xmlDoc || !_extractAllSectionsCache.has(xmlDoc)) return null;
  const config = getSectionConfig()[elementType];
  if (!config) return null;

  const cached = _extractAllSectionsCache.get(xmlDoc);
  const targetMap = cached[getSectionResultKeys(elementType)[0]];
  if (!(targetMap instanceof Map)) return null;

  const freshMap = extractSectionsByType(xmlDoc, elementType, config);
  targetMap.clear();
  for (const [key, value] of freshMap) {
    targetMap.set(key, value);
  }
  return targetMap;
}

/**
 * 断面XMLタグ名から、その断面を抽出対象とする要素タイプを逆引きする。
 * 1つのタグが複数タイプに対応する場合がある（例: StbSecColumn_RC → Column と Post）。
 * @param {string} tagName - 断面XMLタグ名（'StbSecColumn_RC' 等）
 * @returns {string[]} SECTION_CONFIG のキー配列
 */
export function getSectionTypesForTagName(tagName) {
  if (!tagName) return [];
  return Object.entries(getSectionConfig())
    .filter(([, config]) => config.selectors?.includes(tagName))
    .map(([elementType]) => elementType);
}

/**
 * 断面抽出キャッシュをクリア
 * モデルを切り替える際に呼び出す
 */
export function clearSectionExtractionCache() {
  // WeakMap は明示的クリア不可のため、新規インスタンスで置換はできない
  // 代わりに、ドキュメント参照が失われた時点でGCにより自動的にクリアされる
  // 明示的にクリアが必要な場合は、特定のドキュメントを削除する
  _logger.debug('[Data] 断面抽出キャッシュ: WeakMapによる自動管理');
}

/**
 * 指定要素タイプの断面データを抽出
 * @param {Document} xmlDoc - XMLドキュメント
 * @param {string} elementType - 要素タイプ
 * @param {Object} config - 抽出設定
 * @returns {Map} 断面データマップ
 */
function extractSectionsByType(xmlDoc, elementType, config) {
  const sections = new Map();

  try {
    // 設定されたセレクターで要素を取得
    const elements = [];
    for (const sel of config.selectors) {
      let nodeList = [];
      try {
        nodeList = xmlDoc.querySelectorAll(sel);
      } catch (_) {
        nodeList = [];
      }
      if (!nodeList || nodeList.length === 0) {
        // 名前空間フォールバック
        if (typeof xmlDoc.getElementsByTagNameNS === 'function') {
          const nsNodes = xmlDoc.getElementsByTagNameNS(STB_NS, sel);
          for (let i = 0; i < nsNodes.length; i++) elements.push(nsNodes[i]);
          if (nsNodes.length > 0) {
            _logger.debug(
              `[${elementType}] Found ${nsNodes.length} elements via getElementsByTagNameNS for selector: ${sel}`,
            );
          }
          continue;
        }
      }
      // 通常経路
      if (nodeList && nodeList.forEach) {
        if (nodeList.length > 0) {
          _logger.debug(
            `[${elementType}] Found ${nodeList.length} elements via querySelectorAll for selector: ${sel}`,
          );
        }
        nodeList.forEach((el) => elements.push(el));
      }
    }

    if (elements.length === 0) {
      _logger.warn(
        `[${elementType}] No elements found for any selector. Selectors: ${config.selectors.join(', ')}`,
      );
    }

    let filteredCount = 0;
    let extractedCount = 0;

    elements.forEach((element) => {
      const elementId = element.getAttribute('id');
      const tagName = element.tagName || element.localName;

      // attributeFilter が設定されている場合、フィルタリングを適用
      if (config.attributeFilter) {
        // skipFilterForTags に含まれるタグはフィルターをスキップ
        const shouldSkipFilter =
          config.skipFilterForTags && config.skipFilterForTags.includes(tagName);

        // isFoundation="true" の基礎梁もフィルターをスキップ（kind_beam属性を持たないため）
        const isFoundation = element.getAttribute('isFoundation') === 'true';

        if (!shouldSkipFilter && !isFoundation) {
          let matches = true;
          for (const [attr, value] of Object.entries(config.attributeFilter)) {
            const attrValue = element.getAttribute(attr);
            // 属性が存在しない場合
            if (attrValue === null) {
              // skipFilterIfAttributeMissingが設定されていればマッチとみなす
              if (!config.skipFilterIfAttributeMissing) {
                matches = false;
              }
              continue;
            }
            // 属性が存在し、値が異なる場合は不一致
            if (attrValue !== value) {
              matches = false;
              break;
            }
          }
          if (!matches) {
            filteredCount++;
            if (elementId === '51' && elementType === 'Girder') {
              _logger.debug(
                `[${elementType}] Filtering out ${tagName} id="${elementId}" (kind_beam="${element.getAttribute('kind_beam')}" does not match filter)`,
              );
            }
            return; // フィルタに一致しない要素はスキップ
          }
        }
      }

      const sectionData = extractSectionData(element, config);
      if (sectionData && sectionData.id) {
        sections.set(sectionData.id, sectionData);
        extractedCount++;
        if (sectionData.id === 51 && elementType === 'Girder') {
          _logger.debug(
            `[${elementType}] Successfully extracted section id="${sectionData.id}" from ${tagName}`,
          );
        }
      }
    });

    if (elementType === 'Girder') {
      _logger.debug(
        `[${elementType}] Summary: extracted=${extractedCount}, filtered=${filteredCount}, total=${sections.size}`,
      );
    }
  } catch (error) {
    _logger.error(`Error extracting ${elementType} sections:`, error);
  }

  return sections;
}

/**
 * 単一要素から断面データを抽出
 * @param {Element} element - DOM要素
 * @param {Object} config - 抽出設定
 * @returns {Object|null} 断面データまたはnull
 */
function extractSectionData(element, config) {
  const idAttr = element.getAttribute('id');
  const name = element.getAttribute('name');
  const idSteel = element.getAttribute('id_steel');
  const steelFigureInfo = extractSteelFigureVariants(element, config);

  // ID必須チェック
  if (!idAttr) {
    _logger.warn(`[Data] 断面: ID属性が不足 (tag=${element.tagName})`);
    return null;
  }

  // STB仕様: IDは整数として扱う。ただし数値でない場合は文字列として保持
  const parsedId = parseInt(idAttr, 10);
  const id = isNaN(parsedId) ? idAttr : parsedId;

  const guid = element.getAttribute('guid');

  const sectionData = {
    id: id,
    name: name,
    sectionType: element.tagName,
    shapeName:
      (steelFigureInfo?.primaryShape || steelFigureInfo?.fallbackShape || null) ??
      extractShapeName(element, config),
  };

  // RCスラブの均一厚さは図形の子要素（2.0.2 / 2.1.x）に記録される。
  // 汎用コンクリート寸法抽出が読まないため、従来はSlabGeneratorで
  // 実厚と無関係に150mmの既定値へ落ちていた。変断面や複数図形は除外する。
  if (element.tagName === 'StbSecSlab_RC') {
    const slabFigures = Array.from(element.getElementsByTagName('*')).filter((node) =>
      /^StbSecSlab_RC_(?:Conventional)?(?:Straight|Taper|Haunch|Hollow|Waffle)$/u.test(
        node.tagName,
      ),
    );
    if (slabFigures.length === 1 && /Straight$/u.test(slabFigures[0].tagName)) {
      const depth = Number(slabFigures[0].getAttribute('depth'));
      if (Number.isFinite(depth) && depth > 0) sectionData.depth = depth;
    }
  }

  // 断面GUID（断面一致基準=GUID で対応キーに使用。無い場合は付与しない）
  if (guid !== null && guid !== '') sectionData.guid = guid;

  // SS7エクスポート用: 断面の適用階と片持フラグを抽出
  const floor = element.getAttribute('floor');
  if (floor !== null && floor !== '') sectionData.floor = floor;
  if (element.getAttribute('isCanti') === 'true') sectionData.isCanti = true;

  // コンクリート強度（RC/SRC断面で使用）
  const strengthConcrete = element.getAttribute('strength_concrete');
  if (strengthConcrete) sectionData.strength_concrete = strengthConcrete;

  if (element.attributes) {
    for (let i = 0; i < element.attributes.length; i++) {
      const attr = element.attributes.item(i);
      if (attr?.name?.startsWith('ss7_')) {
        sectionData[attr.name] = attr.value;
      }
    }
  }

  const extProps = parseStbExtensions(element.ownerDocument, element.tagName).get(idAttr);
  if (extProps) {
    for (const [key, value] of Object.entries(extProps)) {
      if (key.startsWith('ss7_')) sectionData[key] = value;
    }
  }

  if (idSteel) {
    sectionData.id_steel = idSteel;
    if (!sectionData.shapeName) sectionData.shapeName = idSteel;
  }

  // S造・SRC造柱のisReferenceDirection属性を読み込む
  // （鋼材の基準方向に対する配置を示す: true=基準方向、false=90度回転）
  if (element.tagName === 'StbSecColumn_S' || element.tagName === 'StbSecColumn_SRC') {
    const isRefDir = element.getAttribute('isReferenceDirection');
    // デフォルト値はtrue（XSDスキーマに従う）
    sectionData.isReferenceDirection = isRefDir === null || isRefDir === 'true';
  }

  if (steelFigureInfo) {
    if (steelFigureInfo.variants && steelFigureInfo.variants.length > 0) {
      sectionData.steelVariants = steelFigureInfo.variants;
    }
    if (steelFigureInfo.same || (steelFigureInfo.notSame && steelFigureInfo.notSame.length > 0)) {
      sectionData.sameNotSamePattern = {
        hasSame: Boolean(steelFigureInfo.same),
        notSameCount: steelFigureInfo.notSame.length,
      };
    }

    // 多断面ジオメトリ対応: mode と shapes フィールドを正規化
    normalizeSectionMode(sectionData, steelFigureInfo);

    // S造断面の寸法をdimensionsに追加
    const steelDims = extractSteelDimensions(steelFigureInfo);
    if (steelDims && Object.keys(steelDims).length > 0) {
      sectionData.dimensions = {
        ...(sectionData.dimensions || {}),
        ...steelDims,
      };

      // SRC造の場合に備えて、RC寸法で上書きされる前の鉄骨プロファイル情報を保存
      // S部分メッシュの生成に使用する（H鋼断面等）
      sectionData.steelProfile = {
        section_type: steelDims.profile_hint || null,
        dimensions: { ...steelDims },
      };

      // クロスH断面フラグ（shape_X / shape_Y を持つSRC造柱専用断面）
      if (steelDims.profile_hint === 'CROSS_H') {
        sectionData.isCrossH = true;
      }

      // T形複合断面フラグ（shape_H / shape_T を持つSRC造柱専用断面）
      if (steelDims.profile_hint === 'SHAPE_T') {
        sectionData.isShapeT = true;
      }
    }
  }

  // RC / SRC / CFT などコンクリート図形寸法の抽出
  // SRC造では鉄骨寸法とマージされるため、クリーンなコンクリート寸法を別途保持する
  let concreteDimsClean = null;
  try {
    concreteDimsClean = extractConcreteDimensions(element, config);
    if (concreteDimsClean) {
      sectionData.dimensions = {
        ...(sectionData.dimensions || {}),
        ...concreteDimsClean,
      };

      // 断面タイプの推定（RC円形の優先、次にRC矩形のデフォルト）
      if (concreteDimsClean.profile_hint === 'CIRCLE') {
        sectionData.section_type = 'CIRCLE';
      } else if (!sectionData.section_type && /_RC$/i.test(element.tagName)) {
        sectionData.section_type = 'RECTANGLE';
      }

      // RC等でsteel形状が無い場合、寸法から形状名を補完
      if (!sectionData.shapeName) {
        const d = concreteDimsClean.diameter || concreteDimsClean.outer_diameter;
        if (d) {
          sectionData.shapeName = `CIRCLE_D${d}`;
        } else {
          const w =
            concreteDimsClean.width ||
            concreteDimsClean.outer_width ||
            concreteDimsClean.overall_width;
          const h =
            concreteDimsClean.height || concreteDimsClean.overall_depth || concreteDimsClean.depth;
          if (w && h) {
            sectionData.shapeName = `RECT_${w}x${h}`;
          } else if (w) {
            sectionData.shapeName = `RECT_W${w}`;
          } else if (h) {
            sectionData.shapeName = `RECT_H${h}`;
          }
        }
      }
    }
  } catch (e) {
    _logger.warn(`[Data] 断面: コンクリート寸法解析失敗 (id=${id})`, e);
  }

  // RC/SRC梁のテーパー断面（STB 2.0.2: pos=START/END、STB 2.1.0: start_*/end_*属性）
  // 代表寸法は始端断面に統一する（2.0.2では要素マージにより終端寸法が残ってしまうため）
  try {
    const concreteTaper = extractConcreteTaperDimensions(element, config);
    if (concreteTaper) {
      sectionData.dimensions = {
        ...(sectionData.dimensions || {}),
        ...concreteTaper.start,
      };
      // 2.0.2では要素マージで終端値が残るため、overall_* も始端に揃える
      if (sectionData.dimensions.overall_depth !== undefined) {
        sectionData.dimensions.overall_depth = concreteTaper.start.depth;
      }
      if (sectionData.dimensions.overall_width !== undefined) {
        sectionData.dimensions.overall_width = concreteTaper.start.width;
      }
      if (concreteDimsClean) {
        Object.assign(concreteDimsClean, concreteTaper.start);
      }
      if (!sectionData.section_type) {
        sectionData.section_type = 'RECTANGLE';
      }
      sectionData.shapeStations = [
        {
          pos: 'START',
          section_type: 'RECTANGLE',
          dimensions: concreteTaper.start,
        },
        {
          pos: 'END',
          section_type: 'RECTANGLE',
          dimensions: concreteTaper.end,
        },
      ];

      // SRC造はRC外形＋内蔵鉄骨の専用経路で描画されるため、多断面モードへは切り替えない。
      // 鉄骨多断面（Haunch等）が既に設定されている場合もそちらを優先する。
      const hasSteelMultiSection = sectionData.mode === 'double' || sectionData.mode === 'multi';
      const isSrcSection = /_SRC$/i.test(element.tagName);
      if (!hasSteelMultiSection && !isSrcSection) {
        const startName = `RECT_${concreteTaper.start.width}x${concreteTaper.start.height}`;
        const endName = `RECT_${concreteTaper.end.width}x${concreteTaper.end.height}`;
        sectionData.shapeName = startName;
        sectionData.mode = 'double';
        sectionData.multiSectionType = 'ConcreteTaper';
        sectionData.shapes = [
          { pos: 'START', shapeName: startName, dimensions: concreteTaper.start },
          { pos: 'END', shapeName: endName, dimensions: concreteTaper.end },
        ];
      }
    }
  } catch (e) {
    _logger.warn(`[Data] 断面: テーパー寸法解析失敗 (id=${id})`, e);
  }

  // RC/SRC梁のハンチ断面（STB 2.0.2: pos=START/[CENTER]/END の2〜3断面）
  // pos ごとに断面が変化しうるため、pos 別寸法を形状等価判定(GSS)専用フィールド
  // shapeStations に保持する（buildGeometryShapeSignature が参照する）。
  // 描画・エクスポート等が参照する mode/shapes/dimensions は変更せず、
  // 従来挙動を維持したうえで等価判定にのみ pos 別情報を供給する。
  try {
    const concreteHaunch = extractConcreteHaunchDimensions(element, config);
    if (concreteHaunch && concreteHaunch.length >= 2) {
      sectionData.shapeStations = concreteHaunch.map((s) => ({
        pos: s.pos,
        section_type: 'RECTANGLE',
        dimensions: { width: s.width, height: s.height, depth: s.depth },
      }));
    }
  } catch (e) {
    _logger.warn(`[Data] 断面: ハンチ寸法解析失敗 (id=${id})`, e);
  }

  // 鋼管杭(StbSecPile_S)の寸法抽出
  // 複数セグメントのlength_pileを合計して総杭長を計算
  try {
    const steelPileDims = extractSteelPileDimensions(element, config);
    if (steelPileDims) {
      sectionData.dimensions = {
        ...(sectionData.dimensions || {}),
        ...steelPileDims,
      };

      // 断面タイプを設定
      if (steelPileDims.profile_hint === 'CIRCLE') {
        sectionData.section_type = 'CIRCLE';
      }

      // shapeName を設定
      if (!sectionData.shapeName && steelPileDims.D) {
        sectionData.shapeName = `PIPE_D${steelPileDims.D}`;
      }
    }
  } catch (e) {
    _logger.warn(`[Data] 断面: 鋼管杭寸法解析失敗 (id=${id})`, e);
  }

  // 既製杭(StbSecPileProduct)の寸法抽出
  // PHC杭、SC杭、CPRC杭、節杭などの複数セグメントからlength_pileを合計
  try {
    const pileProductDims = extractPileProductDimensions(element, config);
    if (pileProductDims) {
      sectionData.dimensions = {
        ...(sectionData.dimensions || {}),
        ...pileProductDims,
      };

      // 断面タイプを設定
      if (pileProductDims.profile_hint === 'CIRCLE') {
        sectionData.section_type = 'CIRCLE';
      }

      // shapeName を設定
      if (!sectionData.shapeName && pileProductDims.D) {
        sectionData.shapeName = `PHC_D${pileProductDims.D}`;
      }
    }
  } catch (e) {
    _logger.warn(`[Data] 断面: 既製杭寸法解析失敗 (id=${id})`, e);
  }

  // 断面タイプの正規化（section_type, profile_type, sectionType の統一）
  resolveGeometryProfileTypeInPlace(sectionData);

  // SRC造の判定とフラグ設定
  const isSRC = /_SRC$/i.test(element.tagName);
  if (isSRC) {
    sectionData.isSRC = true;

    // RC部分の寸法を明示的に格納（SRC複合ジオメトリ生成用）
    // クリーンなコンクリート寸法（鉄骨寸法とマージ前）を使用して
    // 鉄骨の width/height が混入するのを防止する
    const rcSource = concreteDimsClean || sectionData.dimensions;
    if (rcSource) {
      const rcProfileType = rcSource.profile_hint === 'CIRCLE' ? 'CIRCLE' : 'RECTANGLE';
      sectionData.concreteProfile = {
        // 柱・ポスト用（width_X, width_Y）
        width_X: rcSource.width_X,
        width_Y: rcSource.width_Y,
        // 梁用（幅・せい）— コンクリート固有の属性を優先し、鉄骨値の混入を防ぐ
        width: rcSource.width_X || rcSource.outer_width || rcSource.width,
        height: rcSource.width_Y || rcSource.overall_depth || rcSource.depth || rcSource.height,
        // 円形断面用
        diameter: rcSource.diameter || rcSource.D,
        // プロファイルタイプ（矩形 or 円形）
        profileType: rcProfileType,
      };

      // SRC造の外形ジオメトリはRC部分で生成するため、
      // section_type をRC型に強制設定（鉄骨の profile_hint が優先されるのを防止）
      sectionData.section_type = rcProfileType;

      // dimensions の width/height もRC寸法で上書きし、
      // RECTANGLE プロファイル生成時に鉄骨寸法が使われるのを防止する
      if (sectionData.dimensions) {
        const rcWidth = sectionData.concreteProfile.width;
        const rcHeight = sectionData.concreteProfile.height;
        if (rcWidth) {
          sectionData.dimensions.width = rcWidth;
          sectionData.dimensions.outer_width = rcWidth;
        }
        if (rcHeight) {
          sectionData.dimensions.height = rcHeight;
          sectionData.dimensions.outer_height = rcHeight;
        }
        // profile_hint もRC型に統一
        sectionData.dimensions.profile_hint = rcProfileType;
      }
    }

    // SRC造梁の鋼材図形からoffset/levelを抽出
    // STB仕様:
    //   offset = 鉄骨ウェブ芯までの距離（RC梁芯基準で水平方向）
    //   level = 鉄骨天端までの距離（RC梁天端基準で下方向）
    // これらが指定されていない場合、断面の芯が一致することを意味する
    //   → S梁天端はRC梁天端より(RC梁せい-S梁せい)/2だけ下がる
    try {
      const steelFigureOffset = extractSteelFigureOffsetLevel(element, config);
      if (steelFigureOffset) {
        sectionData.steelFigureOffset = steelFigureOffset;
      }
    } catch (e) {
      _logger.warn(`[Data] SRC造断面: offset/level抽出失敗 (id=${id})`, e);
    }
  }

  // ベースプレート（柱脚）データの抽出
  // S造・SRC造・CFT造の柱断面に付属するベースプレート情報を読み取る
  try {
    const basePlateData = extractBasePlateData(element, config);
    if (basePlateData) {
      sectionData.basePlate = basePlateData;
    }
  } catch (e) {
    _logger.warn(`[Data] 断面: ベースプレートデータ解析失敗 (id=${id})`, e);
  }

  return sectionData;
}

/**
 * 要素から形状名を抽出
 * @param {Element} element - DOM要素
 * @param {Object} config - 抽出設定
 * @returns {string|null} 形状名またはnull
 */
function extractShapeName(element, config) {
  // 鋼材図形から形状名を抽出
  if (config.steelFigures) {
    for (const figureSelector of config.steelFigures) {
      const figureElement = findFigureElement(element, figureSelector);
      if (figureElement) {
        const shapeElement =
          (typeof figureElement.querySelector === 'function' &&
            figureElement.querySelector('*[shape]')) ||
          findFirstShapeElement(figureElement);
        if (shapeElement) {
          return shapeElement.getAttribute('shape');
        }
      }
    }
  }

  return null;
}

/**
 * 空の結果オブジェクトを作成
 * @returns {Object} 空の断面マップ
 */
function createEmptyResult() {
  const result = {};
  Object.keys(getSectionConfig()).forEach((elementType) => {
    const keys = getSectionResultKeys(elementType);
    keys.forEach((sectionKey) => {
      result[sectionKey] = new Map();
    });
  });
  return result;
}

/**
 * 抽出結果をログ出力
 * @param {Object} result - 抽出結果
 */
function logExtractionResults(result) {
  const summary = Object.entries(result)
    .map(([key, sections]) => `${key}: ${sections.size}`)
    .join(', ');

  _logger.log(`Extracted sections - ${summary}`);
}
