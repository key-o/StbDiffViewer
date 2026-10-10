/**
 * @fileoverview 断面等価性評価エンジン
 *
 * このモジュールは、モデルA/B間の構造要素の断面を比較し、
 * 構造的に等価かどうかを評価する機能を提供します。
 *
 * **主要機能**:
 * - 断面タイプの正規化と互換性判定
 * - 形状パラメータの比較（許容誤差考慮）
 * - 材質・強度の比較
 * - 評価結果の詳細レポート生成
 *
 * @module sectionEquivalenceEngine
 */

import { normalizeProfileTypeToken } from '../common-stb/import/section/sectionTypeUtil.js';
import {
  areMaterialGradesEquivalent,
  normalizeMaterialGradeForEquivalence,
} from '../common-stb/comparison/materialGradeEquivalence.js';

/**
 * 断面等価性評価の設定
 */
const EQUIVALENCE_CONFIG = {
  // 許容誤差（パーセント）
  tolerances: {
    dimension: 1.0, // 寸法: 1%
    strength: 5.0, // 強度: 5%
  },

  // 断面タイプの互換性マッピング
  sectionTypeCompatibility: {
    H: ['H', 'I'],
    I: ['H', 'I'],
    BOX: ['BOX', 'SQUARE'],
    SQUARE: ['BOX', 'SQUARE'],
    PIPE: ['PIPE', 'ROUND'],
    ROUND: ['PIPE', 'ROUND'],
    C: ['C', 'CHANNEL'],
    CHANNEL: ['C', 'CHANNEL'],
    L: ['L'],
    T: ['T'],
    RECTANGLE: ['RECTANGLE'],
    CIRCLE: ['CIRCLE'],
    CFT: ['CFT'],
    SRC: ['SRC'],
  },
};

/**
 * 断面データを評価用に正規化
 *
 * @param {Object} sectionData - 断面データオブジェクト
 * @param {string} elementType - 要素タイプ（'Column', 'Beam'等）
 * @returns {Object} 正規化された断面データ
 */
export function normalizeSectionData(sectionData, elementType) {
  if (!sectionData || typeof sectionData !== 'object') {
    return null;
  }

  return {
    type: normalizeProfileTypeToken(sectionData.section_type || sectionData.type),
    material: (
      sectionData.material ||
      sectionData.strength_name ||
      sectionData.strength_main ||
      sectionData.strength ||
      sectionData.strength_concrete ||
      ''
    )
      ?.toString()
      .trim()
      .toUpperCase(),
    webMaterial: (sectionData.strength_web || sectionData.strength_main || '')
      .toString()
      .trim()
      .toUpperCase(),
    dimensions: extractDimensions(sectionData, elementType),
    reinforcement: sectionData.reinforcement || null,
  };
}

/**
 * 2つの断面の等価性を評価
 *
 * @param {Object} sectionA - モデルAの断面データ
 * @param {Object} sectionB - モデルBの断面データ
 * @param {string} elementType - 要素タイプ（'Column', 'Beam'等）
 * @returns {Object} 評価結果 {isEquivalent, checks, summary, passRate}
 */
export function evaluateSectionEquivalence(sectionA, sectionB, elementType) {
  if (!sectionA || !sectionB) {
    return {
      isEquivalent: false,
      checks: [],
      summary: '断面データが不足しています',
      passRate: '0.0',
    };
  }

  // 正規化
  const normA = normalizeSectionData(sectionA, elementType);
  const normB = normalizeSectionData(sectionB, elementType);

  if (!normA || !normB) {
    return {
      isEquivalent: false,
      checks: [],
      summary: '断面データの正規化に失敗しました',
      passRate: '0.0',
    };
  }

  // チェック実行
  const checks = [
    checkSectionType(normA, normB),
    checkDimensions(normA, normB),
    checkSteelComponents(checkMaterial, normA, normB),
    checkSteelComponents(checkStrength, normA, normB),
    checkReinforcement(normA, normB),
  ];

  // 結果集計
  const passedChecks = checks.filter((c) => c.passed).length;
  const totalChecks = checks.length;
  const isEquivalent = passedChecks === totalChecks;

  return {
    isEquivalent,
    checks,
    summary: `${passedChecks} / ${totalChecks} 項目一致`,
    passRate: ((passedChecks / totalChecks) * 100).toFixed(1),
  };
}

/**
 * 断面タイプのチェック
 *
 * @param {Object} normA - 正規化された断面Aのデータ
 * @param {Object} normB - 正規化された断面Bのデータ
 * @returns {Object} チェック結果
 */
function checkSectionType(normA, normB) {
  const typeA = normA.type;
  const typeB = normB.type;

  if (!typeA || !typeB) {
    return {
      category: '断面種別',
      name: '種別データ',
      passed: false,
      details: '断面種別データが不足しています',
    };
  }

  // 完全一致
  if (typeA === typeB) {
    return {
      category: '断面種別',
      name: '種別一致',
      passed: true,
      details: `両方: ${typeA}`,
    };
  }

  // 互換性チェック
  const compatibleTypes = EQUIVALENCE_CONFIG.sectionTypeCompatibility[typeA] || [];
  const isCompatible = compatibleTypes.includes(typeB);

  return {
    category: '断面種別',
    name: '種別互換性',
    passed: isCompatible,
    details: isCompatible ? `互換: ${typeA} ≈ ${typeB}` : `非互換: ${typeA} ≠ ${typeB}`,
  };
}

/**
 * 寸法のチェック
 *
 * @param {Object} normA - 正規化された断面Aのデータ
 * @param {Object} normB - 正規化された断面Bのデータ
 * @returns {Object} チェック結果
 */
function checkDimensions(normA, normB) {
  const dimA = normA.dimensions;
  const dimB = normB.dimensions;

  if (!dimA || !dimB || Object.keys(dimA).length === 0 || Object.keys(dimB).length === 0) {
    return {
      category: '寸法',
      name: '寸法データ',
      passed: true, // データがない場合はスキップ
      details: '比較可能な寸法データがありません',
      subChecks: [],
    };
  }

  const subChecks = [];
  const tolerance = EQUIVALENCE_CONFIG.tolerances.dimension;

  // 共通の寸法キーをチェック
  const commonKeys = Object.keys(dimA).filter((k) => k in dimB);

  if (commonKeys.length === 0) {
    return {
      category: '寸法',
      name: '寸法データ',
      passed: true,
      details: '共通の寸法項目がありません',
      subChecks: [],
    };
  }

  for (const key of commonKeys) {
    const valA = parseFloat(dimA[key]);
    const valB = parseFloat(dimB[key]);

    if (isNaN(valA) || isNaN(valB)) continue;

    const diff = Math.abs(valA - valB);
    const diffPercent = valA !== 0 ? (diff / Math.abs(valA)) * 100 : 0;
    const passed = diffPercent <= tolerance;

    subChecks.push({
      name: key,
      passed,
      details: `${valA.toFixed(1)} vs ${valB.toFixed(1)} (${diffPercent.toFixed(2)}%)`,
    });
  }

  const allPassed = subChecks.every((c) => c.passed);

  return {
    category: '寸法',
    name: '寸法比較',
    passed: allPassed,
    subChecks,
    details: allPassed
      ? `全${subChecks.length}項目が許容差${tolerance}%以内です`
      : `許容差${tolerance}%を超える寸法があります`,
  };
}

/**
 * 鋼材の主材とウェブを、同じ材質・強度の判定基準で個別に評価する。
 *
 * @param {Function} check - 単一材の材質または強度チェック
 * @param {Object} normA - 正規化された断面Aのデータ
 * @param {Object} normB - 正規化された断面Bのデータ
 * @returns {Object} チェック結果
 */
function checkSteelComponents(check, normA, normB) {
  const main = check(normA, normB);
  if (!normA.webMaterial && !normB.webMaterial) return main;

  // strength_web の省略時継承で主材と同じ値になっているだけなら、
  // 従来の単一材表示を維持し、独立した web 指定がある場合だけ2成分比較へ展開する。
  const hasIndependentWeb =
    normA.webMaterial !== normA.material || normB.webMaterial !== normB.material;
  if (!hasIndependentWeb) return main;

  const web = check({ material: normA.webMaterial }, { material: normB.webMaterial });
  return {
    ...main,
    name: `${main.category}比較`,
    passed: main.passed && web.passed,
    details: `主材: ${main.details}\nウェブ: ${web.details}`,
    subChecks: [
      { ...main, name: `主材 ${main.name}` },
      { ...web, name: `ウェブ ${web.name}` },
    ],
  };
}

/**
 * 材質のチェック
 *
 * @param {Object} normA - 正規化された断面Aのデータ
 * @param {Object} normB - 正規化された断面Bのデータ
 * @returns {Object} チェック結果
 */
function checkMaterial(normA, normB) {
  const matA = normA.material;
  const matB = normB.material;

  if (!matA || !matB) {
    return {
      category: '材質',
      name: '材質データ',
      passed: true, // データがない場合はスキップ
      details: '比較可能な材質データがありません',
    };
  }

  if (matA === matB) {
    return {
      category: '材質',
      name: '材質一致',
      passed: true,
      details: `両方: ${matA}`,
    };
  }

  const isCompatible = areMaterialGradesEquivalent(matA, matB);
  const normalizedA = normalizeMaterialGradeForEquivalence(matA);
  const normalizedB = normalizeMaterialGradeForEquivalence(matB);

  return {
    category: '材質',
    name: '材質互換性',
    passed: isCompatible,
    details: isCompatible
      ? `互換: ${matA} ≈ ${matB}（同一グレード群: ${normalizedA}）`
      : `非互換: ${matA} ≠ ${matB}（比較キー: ${normalizedA} / ${normalizedB}）`,
  };
}

/**
 * 強度のチェック
 *
 * @param {Object} normA - 正規化された断面Aのデータ
 * @param {Object} normB - 正規化された断面Bのデータ
 * @returns {Object} チェック結果
 */
function checkStrength(normA, normB) {
  // 材質から強度を推定
  const strengthA = estimateStrength(normA.material);
  const strengthB = estimateStrength(normB.material);

  if (!strengthA || !strengthB) {
    return {
      category: '強度',
      name: '強度データ',
      passed: true, // データがない場合はスキップ
      details: '比較可能な強度データがありません',
    };
  }

  const tolerance = EQUIVALENCE_CONFIG.tolerances.strength;
  const diff = Math.abs(strengthA - strengthB);
  const diffPercent = strengthA !== 0 ? (diff / strengthA) * 100 : 0;
  const passed = diffPercent <= tolerance;

  return {
    category: '強度',
    name: '降伏強度',
    passed,
    details: `${strengthA} vs ${strengthB} N/mm² (${diffPercent.toFixed(1)}%)`,
  };
}

function needsSourcePositionDisplay(rebar) {
  const sourceDescriptions = rebar?.sourceDescriptions || {};

  if (rebar?.pattern === 'SAME') {
    const descriptions = Object.values(sourceDescriptions);
    return descriptions.length > 1 && descriptions.some((value) => value !== descriptions[0]);
  }

  if (rebar?.pattern === 'END_CENTER') {
    return Boolean(
      sourceDescriptions.START &&
      sourceDescriptions.END &&
      sourceDescriptions.START !== sourceDescriptions.END,
    );
  }

  return false;
}

function orderedSourceDisplayKeys(rebarA, rebarB) {
  const allKeys = Array.from(
    new Set([
      ...Object.keys(rebarA?.sourceDescriptions || {}),
      ...Object.keys(rebarB?.sourceDescriptions || {}),
    ]),
  );
  const physicalKeys = allKeys.filter((key) => key !== 'SAME');
  const keys = physicalKeys.length > 0 ? physicalKeys : allKeys;
  const preferredOrder = ['START', 'CENTER', 'END'];

  return [
    ...preferredOrder.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !preferredOrder.includes(key)),
  ];
}

function resolveSourceDisplayEntry(rebar, key) {
  const sourceSpec = rebar?.sourcePositions?.[key];
  const sourceDescription = rebar?.sourceDescriptions?.[key];
  if (sourceSpec || sourceDescription) {
    return {
      spec: sourceSpec,
      description: sourceDescription || 'なし',
    };
  }

  if (key !== 'SAME' && rebar?.sourcePositions?.SAME) {
    return {
      spec: rebar.sourcePositions.SAME,
      description: rebar.sourceDescriptions?.SAME || 'なし',
    };
  }

  if ((key === 'START' || key === 'END') && rebar?.pattern === 'END_CENTER') {
    return {
      spec: rebar.positions?.END,
      description: rebar.descriptions?.END || 'なし',
    };
  }

  return {
    spec: rebar?.positions?.[key],
    description: rebar?.descriptions?.[key] || 'なし',
  };
}

function compareReinforcementPositions(rebarA, rebarB) {
  const subChecks = [];
  const useSourcePositions =
    needsSourcePositionDisplay(rebarA) || needsSourcePositionDisplay(rebarB);
  const allKeys = useSourcePositions
    ? orderedSourceDisplayKeys(rebarA, rebarB)
    : Array.from(
        new Set([...Object.keys(rebarA?.positions || {}), ...Object.keys(rebarB?.positions || {})]),
      );

  subChecks.push({
    name: '配筋パターン',
    passed: rebarA.pattern === rebarB.pattern,
    details: `${rebarA.pattern} vs ${rebarB.pattern}`,
    valueA: rebarA.pattern,
    valueB: rebarB.pattern,
  });

  for (const key of allKeys) {
    const entryA = useSourcePositions
      ? resolveSourceDisplayEntry(rebarA, key)
      : {
          spec: rebarA.positions?.[key],
          description: rebarA.descriptions?.[key] || 'なし',
        };
    const entryB = useSourcePositions
      ? resolveSourceDisplayEntry(rebarB, key)
      : {
          spec: rebarB.positions?.[key],
          description: rebarB.descriptions?.[key] || 'なし',
        };
    const passed = JSON.stringify(entryA.spec ?? null) === JSON.stringify(entryB.spec ?? null);
    const labelMap = {
      SAME: '全断面',
      END: useSourcePositions ? '終端' : '端部',
      CENTER: '中央',
      START: '始端',
    };
    subChecks.push({
      name: labelMap[key] || key,
      passed,
      details: `モデルA: ${entryA.description}\nモデルB: ${entryB.description}`,
      valueA: entryA.description,
      valueB: entryB.description,
    });
  }

  return subChecks;
}

/**
 * RC梁配筋の意味等価チェック。
 * Same / ThreeTypes / StartEnd / 2.1 Simple/Complex 等のXML表現差は、
 * sectionData.reinforcement の正規形で吸収済み。
 */
function checkReinforcement(normA, normB) {
  const rebarA = normA.reinforcement;
  const rebarB = normB.reinforcement;

  if (!rebarA && !rebarB) {
    return {
      category: '配筋',
      name: '配筋データ',
      passed: true,
      details: 'この断面種別は現在の配筋等価比較の対象外です',
      subChecks: [],
    };
  }

  if (!rebarA || !rebarB) {
    return {
      category: '配筋',
      name: '配筋データ',
      passed: false,
      details: '片方のモデルだけ配筋比較データを取得できました',
      subChecks: [],
    };
  }

  if (!rebarA.hasData && !rebarB.hasData) {
    return {
      category: '配筋',
      name: '配筋データ',
      passed: true,
      details: '両方とも比較可能な配筋データがありません',
      subChecks: [],
    };
  }

  const subChecks = compareReinforcementPositions(rebarA, rebarB);
  const passed = rebarA.signature === rebarB.signature;

  return {
    category: '配筋',
    name: '配筋等価比較',
    passed,
    details: passed
      ? 'XML上の持ち方の差を正規化した結果、配筋仕様は等価です'
      : '正規化後の配筋仕様に差があります',
    subChecks,
  };
}

/*
 * 寸法を抽出
 *
 * @param {Object} sectionData - 断面データ
 * @param {string} elementType - 要素タイプ
 * @returns {Object} 抽出された寸法データ
 */
function extractDimensions(sectionData, _elementType) {
  if (!sectionData) return {};

  // ネストされたdimensionsオブジェクトがある場合はそれを使用、なければsectionData自体を使用
  const dims = sectionData.dimensions || sectionData;

  // 断面タイプに応じた寸法抽出
  const type = normalizeProfileTypeToken(sectionData.section_type || sectionData.type);
  const result = {};

  switch (type) {
    case 'H':
    case 'I':
      if (dims.A || dims.height) result.height = dims.A || dims.height;
      if (dims.B || dims.width) result.width = dims.B || dims.width;
      if (dims.t1 || dims.tw || dims.webThickness) {
        result.webThickness = dims.t1 || dims.tw || dims.webThickness;
      }
      if (dims.t2 || dims.tf || dims.flangeThickness) {
        result.flangeThickness = dims.t2 || dims.tf || dims.flangeThickness;
      }
      break;

    case 'BOX':
    case 'SQUARE':
      if (dims.A || dims.height) result.height = dims.A || dims.height;
      if (dims.B || dims.width) result.width = dims.B || dims.width;
      if (dims.t || dims.thickness) result.thickness = dims.t || dims.thickness;
      break;

    case 'PIPE':
    case 'ROUND':
      if (dims.D || dims.diameter) result.diameter = dims.D || dims.diameter;
      if (dims.t || dims.thickness) result.thickness = dims.t || dims.thickness;
      break;

    case 'RECTANGLE':
      if (dims.width || dims.D || dims.B) {
        result.width = dims.width || dims.D || dims.B;
      }
      if (dims.height || dims.depth || dims.D2 || dims.A) {
        result.height = dims.height || dims.depth || dims.D2 || dims.A;
      }
      break;

    case 'CIRCLE':
      if (dims.diameter || dims.D) {
        result.diameter = dims.diameter || dims.D;
      }
      break;

    default:
      // 未知のタイプの場合、一般的な寸法を抽出
      if (dims.A) result.A = dims.A;
      if (dims.B) result.B = dims.B;
      if (dims.D) result.D = dims.D;
      if (dims.t) result.t = dims.t;
      if (dims.width) result.width = dims.width;
      if (dims.height) result.height = dims.height;
      break;
  }

  return result;
}

/**
 * 材質から降伏強度を推定
 *
 * @param {string} material - 材質名
 * @returns {number|null} 推定降伏強度 (N/mm²)、または推定不可の場合はnull
 */
function estimateStrength(material) {
  if (!material) return null;

  const mat = normalizeMaterialGradeForEquivalence(material);

  const strengthMap = {
    // 鋼材
    SS400: 235,
    SN400: 235,
    SN490: 325,
    SM490: 325,
    SS540: 400,
    SN400B: 235,
    SN400C: 235,
    SN490B: 325,
    SN490C: 325,
    // コンクリート（圧縮強度）
    FC18: 18,
    FC21: 21,
    FC24: 24,
    FC27: 27,
    FC30: 30,
    FC33: 33,
    FC36: 36,
    FC40: 40,
    FC45: 45,
    FC50: 50,
  };

  return strengthMap[mat] || null;
}
