/**
 * @fileoverview 3D配筋（鉄筋の3次元配置）の算定ルール定数
 *
 * ST-Bridgeには鉄筋の3次元位置が含まれないため、断面の配筋情報
 * （本数・呼び径・かぶり・dt）から機械的に構成した想定配置を用いる。
 * かぶり・dt の考え方は梁貫通孔（開口補強筋）検討と共通で、
 * 「主筋芯 = かぶり ＋ 帯筋の最大外径 ＋ 主筋の最大外径/2」を基本とする。
 *
 * @module constants/rebarPlacementRules
 */

/**
 * 柱主筋の3D配置ルール
 * @constant {Object}
 */
export const COLUMN_REBAR_PLACEMENT_RULES = {
  /** かぶり厚さの既定値 [mm]（STBに depth_cover_* が無い場合） */
  defaultCoverMm: 40,
  /** 主筋呼び名の既定値（STBに D_main が無い場合） */
  defaultMainBarDia: 'D22',
  /** 帯筋呼び名の既定値（STBに D_band が無い場合） */
  defaultHoopDia: 'D10',
  /** 断面内に主筋芯を配置できる最小の内法寸法 [mm]（これ未満は配置不能とする） */
  minInnerSpanMm: 1,
};

/**
 * 梁（大梁・小梁）主筋の3D配置ルール
 * @constant {Object}
 */
export const BEAM_REBAR_PLACEMENT_RULES = {
  /** かぶり厚さの既定値 [mm]（STBに depth_cover_* が無い場合） */
  defaultCoverMm: 40,
  /** 主筋呼び名の既定値（STBに D_main が無い場合） */
  defaultMainBarDia: 'D25',
  /** あばら筋呼び名の既定値（STBに D_stirrup が無い場合） */
  defaultStirrupDia: 'D10',
  /** 腹筋呼び名の既定値 */
  defaultWebBarDia: 'D10',
};

/**
 * 帯筋（フープ）・あばら筋（スターラップ）の3D配置ルール
 *
 * 主筋と違い材軸に垂直な閉ループのため、ピッチで材軸方向に並べる。
 * 矩形は4辺の直線に分解し、円形はトーラスで描く。
 * @constant {Object}
 */
export const HOOP_PLACEMENT_RULES = {
  /**
   * 有効とみなす最小ピッチ [mm]。
   * これ未満（0や欠損を含む）はピッチ不明として配置しない。
   * 極端に小さい値でインスタンス数が発散するのを防ぐ意味もある。
   */
  minPitchMm: 10,
  /** ループを配置できる最小の内法寸法 [mm]（これ未満は配置不能とする） */
  minInnerSpanMm: 1,
};

/**
 * 3D鉄筋の描画パラメータ
 * @constant {Object}
 */
export const REBAR_RENDER_OPTIONS = {
  /** 円柱の円周分割数（本数が多いため粗めにする） */
  radialSegments: 6,
  /** 鉄筋の表示色 */
  colorHex: 0x2f6fd0,
  /** 1モデルあたりに生成する鉄筋本数の上限（描画負荷の保護） */
  maxBarsPerModel: 200000,
};

/**
 * 帯筋・あばら筋の描画パラメータ
 *
 * ピッチで並ぶため主筋より桁違いに本数が増える。上限は主筋と別枠で持つ。
 * @constant {Object}
 */
export const HOOP_RENDER_OPTIONS = {
  /**
   * 円形フープ（トーラス）の管断面の分割数。
   * 矩形フープの辺は主筋と同じ単位円柱を共有するため、こちらは円形専用。
   */
  radialSegments: 4,
  /** 円形フープ（トーラス）の周方向の分割数 */
  tubularSegments: 16,
  /** 帯筋・あばら筋の表示色（主筋と区別する） */
  colorHex: 0xd08a2f,
  /**
   * 1モデルあたりに生成するインスタンス数の上限。
   * 矩形フープ1組で4本（4辺）を消費する。
   */
  maxBarsPerModel: 300000,
};
