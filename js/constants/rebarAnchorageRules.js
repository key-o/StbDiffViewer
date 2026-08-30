/**
 * @fileoverview 梁主筋の柱内定着（のみこみ）ルールと必要定着長さの算定
 *
 * ST-Bridgeには定着形状・定着長さの情報が含まれないため、RC造配筋標準図の
 * 一般値（90°折曲げ定着）と、異形鉄筋の定着の長さの標準表から算定する。
 *
 * 必要定着長さの表は「公共建築工事標準仕様書（建築工事編）異形鉄筋の定着の長さ」
 * に準拠した一般値で、フック付き定着の L2h は水平投影長さである。
 * 実際の可否は使用する工法の設計指針・構造設計者の判断による。
 *
 * @module constants/rebarAnchorageRules
 */

/**
 * 梁主筋の柱内定着（のみこみ）ルール
 * 出典: RC造配筋標準図の一般値（90°折曲げ定着）
 * @constant {Object}
 */
export const REBAR_ANCHORAGE_RULES = {
  /** 水平投影定着長さ La: 柱せいに対する比率（3D/4以上） */
  projectionColumnDepthRatio: 0.75,
  /** 90°折曲げ後の余長: 呼び径dに対する倍率（8d以上） */
  tailDiaFactor: 8,
  /** 下端筋を直線定着とする場合の最小のみこみ長さ: 呼び径dに対する倍率（15d以上） */
  straightBottomDiaFactor: 15,
  /** 第1あばら筋の柱面からの距離 [mm]（50mm程度以内） */
  firstStirrupFromFaceMm: 50,
  /** 柱かぶり厚さの既定値 [mm]（柱断面から取得できない場合） */
  defaultColumnCoverMm: 40,
  /** 柱帯筋の呼び名の既定値（定着可能長さの控除に使う） */
  defaultColumnHoopDia: 'D10',
  /** 柱主筋の呼び名の既定値（定着可能長さの控除に使う） */
  defaultColumnMainDia: 'D22',
};

/**
 * 柱主筋の定着ルール
 *
 * 出典: 日本建設業連合会「鉄筋コンクリート造配筋標準図」(2013.03.27 改訂)
 * §7-1 3.（柱頭・柱脚主筋の定着）／§7-3（最上階・最下階の柱の定着）。
 * @constant {Object}
 */
export const COLUMN_ANCHORAGE_RULES = {
  /** 柱頭・柱脚主筋が梁面を越えて必要な長さ: 呼び径dに対する倍率（15d以上） */
  beyondBeamFaceDiaFactor: 15,
  /** 最下階柱脚の90°折曲げ余長: 呼び径dに対する倍率（8d以上。図7-3-3） */
  baseTailDiaFactor: 8,
  /** 同 余長の最小値 [mm]（8dかつ150以上） */
  baseTailMinMm: 150,
  /** 最上階柱頭 四隅の180°フック余長: 呼び径dに対する倍率（4d以上） */
  hookTailDiaFactor: 4,
  /** 同 余長の最小値 [mm] */
  hookTailMinMm: 60,
  /** 180°フックの折り返し位置の芯ずれ: 呼び径dに対する倍率（内法直径4d＋d） */
  hookReturnOffsetDiaFactor: 5,
};

/** 必要定着長さ表の既定コンクリート設計基準強度 [N/mm2]（strength_concrete が読めない場合） */
export const DEFAULT_CONCRETE_FC = 21;

/** 必要定着長さ表の既定鉄筋種別（strength / grade が読めない場合） */
export const DEFAULT_BAR_GRADE = 'SD345';

/**
 * 異形鉄筋の定着の長さ（呼び径dに対する倍率）
 *
 * `l2` は直線定着、`l2h` はフック付き定着の水平投影長さ。
 * Fc は範囲の下限・上限（両端を含む）で引く。
 * @constant {Array<{fcMin:number, fcMax:number, grades:Object<string,{l2:number, l2h:number}>}>}
 */
const DEVELOPMENT_LENGTH_TABLE = [
  {
    fcMin: 18,
    fcMax: 20,
    grades: { SD295: { l2: 40, l2h: 30 }, SD345: { l2: 40, l2h: 30 } },
  },
  {
    fcMin: 21,
    fcMax: 23,
    grades: {
      SD295: { l2: 35, l2h: 25 },
      SD345: { l2: 35, l2h: 25 },
      SD390: { l2: 40, l2h: 30 },
    },
  },
  {
    fcMin: 24,
    fcMax: 29,
    grades: {
      SD295: { l2: 30, l2h: 20 },
      SD345: { l2: 35, l2h: 25 },
      SD390: { l2: 40, l2h: 30 },
    },
  },
  {
    fcMin: 30,
    fcMax: 38,
    grades: {
      SD295: { l2: 30, l2h: 20 },
      SD345: { l2: 30, l2h: 20 },
      SD390: { l2: 35, l2h: 25 },
      SD490: { l2: 40, l2h: 30 },
    },
  },
  {
    fcMin: 39,
    fcMax: 47,
    grades: {
      SD295: { l2: 25, l2h: 15 },
      SD345: { l2: 30, l2h: 20 },
      SD390: { l2: 35, l2h: 25 },
      SD490: { l2: 40, l2h: 30 },
    },
  },
  {
    fcMin: 48,
    fcMax: 60,
    grades: {
      SD295: { l2: 25, l2h: 15 },
      SD345: { l2: 25, l2h: 15 },
      SD390: { l2: 30, l2h: 20 },
      SD490: { l2: 35, l2h: 25 },
    },
  },
];

/**
 * `strength_concrete` 属性からコンクリート設計基準強度を取り出す
 *
 * "Fc21" / "FC21" / "21" / "Fc21N" などの表記を許容し、最初の数値を採用する。
 * @param {string|null|undefined} strength - strength_concrete 属性値
 * @returns {number|null} Fc [N/mm2]。読めない場合は null
 */
export function parseConcreteFc(strength) {
  if (typeof strength !== 'string') return null;
  const matched = strength.match(/\d+(?:\.\d+)?/);
  if (!matched) return null;
  const value = Number(matched[0]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * `strength` / `grade` 属性から鉄筋種別を正規化する
 *
 * "SD295A" / "SD295B" は表では同一のため "SD295" に丸める。
 * @param {string|null|undefined} grade - 鉄筋種別の属性値
 * @returns {string|null} 正規化した種別。読めない場合は null
 */
export function normalizeBarGrade(grade) {
  if (typeof grade !== 'string') return null;
  const matched = grade.toUpperCase().match(/SD\s*(\d{3})/);
  return matched ? `SD${matched[1]}` : null;
}

/**
 * 必要定着長さ（呼び径dに対する倍率）を表から引く
 *
 * 表の範囲外の Fc は最も近い端の行へ丸める（Fc60超は最上段、Fc18未満は最下段）。
 * 表に無い鉄筋種別は最も強度の高い（＝必要長さの大きい）種別の値を使う。
 * @param {number} fc - コンクリート設計基準強度 [N/mm2]
 * @param {string} grade - 正規化済みの鉄筋種別（'SD345' 等）
 * @returns {{l2:number, l2h:number, exact:boolean}} 倍率。表を丸めた場合 exact=false
 */
export function resolveDevelopmentLengthFactors(fc, grade) {
  const rows = DEVELOPMENT_LENGTH_TABLE;
  let exact = true;

  let row = rows.find((item) => fc >= item.fcMin && fc <= item.fcMax);
  if (!row) {
    exact = false;
    row = fc < rows[0].fcMin ? rows[0] : rows[rows.length - 1];
  }

  let factors = row.grades[grade];
  if (!factors) {
    exact = false;
    // 表に無い種別（高強度鉄筋等）は、その行で最も必要長さの大きい値を採る
    factors = Object.values(row.grades).reduce((max, item) => (item.l2h > max.l2h ? item : max));
  }
  return { l2: factors.l2, l2h: factors.l2h, exact };
}

/**
 * 異形鉄筋の必要定着長さ [mm] を算定する
 *
 * 直線定着は L2、フック付き定着は L2h（フックを除く投影長さ）を返す。
 * @param {Object} params - 算定パラメータ
 * @param {number} params.barDiaMm - 主筋の呼び径 [mm]
 * @param {boolean} [params.hooked] - フック付き定着か（true で L2h）
 * @param {number} [params.fc] - コンクリート設計基準強度 [N/mm2]
 * @param {string} [params.grade] - 鉄筋種別（正規化済み）
 * @returns {{requiredMm:number, factor:number, exact:boolean}} 必要定着長さと倍率
 */
export function computeDevelopmentLength({
  barDiaMm,
  hooked = false,
  fc = DEFAULT_CONCRETE_FC,
  grade = DEFAULT_BAR_GRADE,
}) {
  const factors = resolveDevelopmentLengthFactors(fc, grade);
  const factor = hooked ? factors.l2h : factors.l2;
  return { requiredMm: factor * barDiaMm, factor, exact: factors.exact };
}

/**
 * 90°折曲げ定着の必要水平投影長さを算定する
 *
 * 必要長さは「表による L2h」と「柱せいの3/4」の大きい方とする。
 * @param {Object} params - 算定パラメータ
 * @param {number} params.barDiaMm - 主筋の呼び径 [mm]
 * @param {number} params.columnDepthMm - 梁軸方向の柱せい [mm]
 * @param {number} [params.fc] - コンクリート設計基準強度 [N/mm2]
 * @param {string} [params.grade] - 鉄筋種別（正規化済み）
 * @returns {{requiredMm:number, l2hMm:number, minByColumnMm:number, factor:number, exact:boolean}}
 *   必要水平投影長さと内訳
 */
export function computeRequiredHookProjection({
  barDiaMm,
  columnDepthMm,
  fc = DEFAULT_CONCRETE_FC,
  grade = DEFAULT_BAR_GRADE,
}) {
  const { l2h, exact } = resolveDevelopmentLengthFactors(fc, grade);
  const l2hMm = l2h * barDiaMm;
  const minByColumnMm = columnDepthMm * REBAR_ANCHORAGE_RULES.projectionColumnDepthRatio;
  return {
    requiredMm: Math.max(l2hMm, minByColumnMm),
    l2hMm,
    minByColumnMm,
    factor: l2h,
    exact,
  };
}
