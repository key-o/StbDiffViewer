/**
 * @fileoverview 3D配筋の「部材端を基準にした鉄筋片」の共通表現
 *
 * 定着・カットオフのように「部材端から○mm」で決まる鉄筋は、断面配置
 * （区間比率で表す segments）では表せない。ここでは部材端を原点にした
 * 実寸の鉄筋片として持ち、viewer 側で部材長に載せて描く。
 *
 * - `anchor` は基準にする部材端。'start' は材軸マイナス側（柱は柱脚）、
 *   'end' は材軸プラス側（柱は柱頭）
 * - 材軸方向の距離は「部材内向きを正」とする。負の値は部材端より外側
 *   （定着で部材を越えて伸びる部分）を表す
 *
 * @module data/extractors/rebar3d/rebarPieces
 */

/**
 * 材軸方向にまっすぐ伸びる鉄筋片を作る
 * @param {Object} params - 鉄筋片のパラメータ
 * @param {'start'|'end'} params.anchor - 基準にする部材端
 * @param {number} params.from - 基準端からの始点距離 [mm]（内向き正）
 * @param {number} params.to - 基準端からの終点距離 [mm]（内向き正）
 * @param {number} params.u - 断面内座標 u [mm]
 * @param {number} params.v - 断面内座標 v [mm]
 * @param {number} params.dia - 呼び径 [mm]
 * @returns {Object|null} 鉄筋片。長さが0以下なら null
 */
export function axialPiece({ anchor, from, to, u, v, dia }) {
  if (!(Math.abs(to - from) > 0) || !(dia > 0)) return null;
  return { kind: 'axial', anchor, from, to, u, v, dia };
}

/**
 * 折曲げ後の余長（材軸に直交する、または材軸に平行に折り返す）を作る
 * @param {Object} params - 鉄筋片のパラメータ
 * @param {'start'|'end'} params.anchor - 基準にする部材端
 * @param {number} params.at - 基準端からの折曲げ位置 [mm]（内向き正）
 * @param {number} params.u - 折曲げ開始点の断面内座標 u [mm]
 * @param {number} params.v - 折曲げ開始点の断面内座標 v [mm]
 * @param {number} params.dia - 呼び径 [mm]
 * @param {'u'|'v'|'axial'} params.dir - 余長の伸びる方向
 * @param {number} params.sign - 向き（+1 / −1。axial は内向きが +1）
 * @param {number} params.length - 余長 [mm]
 * @param {number} [params.offsetU] - 折り返し（180°フック）の芯ずれ u [mm]
 * @param {number} [params.offsetV] - 折り返し（180°フック）の芯ずれ v [mm]
 * @returns {Object|null} 鉄筋片。長さが0以下なら null
 */
export function tailPiece({ anchor, at, u, v, dia, dir, sign, length, offsetU = 0, offsetV = 0 }) {
  if (!(length > 0) || !(dia > 0)) return null;
  return { kind: 'tail', anchor, at, u, v, dia, dir, sign, length, offsetU, offsetV };
}

/**
 * 断面中心へ向かう方向を、u/v のどちらか一方の軸で決める
 *
 * 90°折曲げ・180°フックの余長は柱の内側へ向けるため、
 * 断面中心から遠い方の軸を折り曲げ方向に選ぶ。
 * @param {number} u - 断面内座標 u [mm]
 * @param {number} v - 断面内座標 v [mm]
 * @returns {{dir:'u'|'v', sign:number}} 折り曲げ方向
 */
export function inwardDirection(u, v) {
  if (Math.abs(u) >= Math.abs(v)) {
    return { dir: 'u', sign: u > 0 ? -1 : 1 };
  }
  return { dir: 'v', sign: v > 0 ? -1 : 1 };
}
