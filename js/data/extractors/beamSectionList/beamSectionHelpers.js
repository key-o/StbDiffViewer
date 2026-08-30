/**
 * @fileoverview RC梁断面抽出の共有純関数
 *
 * 位置名の決定・かぶり抽出・主筋重心位置抽出・整数パースなど、
 * modern(2.1.x)/legacy(2.0.2) 双方から共有される状態非依存ヘルパーを提供する。
 */

/**
 * 正の整数へパースし、不正・非正なら fallback を返す。
 * @param {string|null} value
 * @param {number} fallback
 * @returns {number}
 */
export function parsePositiveInteger(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 段番号(1/2/3)を序数文字列(1st/2nd/3rd)へ変換する。
 */
export function ordinal(step) {
  return step === 1 ? '1st' : step === 2 ? '2nd' : '3rd';
}

/** order値から位置名を取得 */
export function getPositionName(order, totalOrders) {
  if (totalOrders === 1) return 'SAME';
  if (totalOrders === 2) return order === 1 ? 'LEFT' : 'CENTER';
  if (totalOrders === 3) {
    if (order === 1) return 'LEFT';
    if (order === 2) return 'CENTER';
    if (order === 3) return 'RIGHT';
  }
  return `POS_${order}`;
}

function firstFiniteAttr(candidates) {
  for (const [element, attribute] of candidates) {
    const value = parseFloat(element?.getAttribute(attribute));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * ST-Bridge仕様上の「かぶり厚さ」だけを抽出する厳密API。
 * center_top / center_bottom / center_side は主筋重心位置なので含めない。
 */
export function extractBeamSourceCover(arrangementElement, simpleBarElement) {
  const top = firstFiniteAttr([
    [arrangementElement, 'depth_cover_top'],
    [simpleBarElement, 'depth_cover_top'],
  ]);
  const bottom = firstFiniteAttr([
    [arrangementElement, 'depth_cover_bottom'],
    [simpleBarElement, 'depth_cover_bottom'],
  ]);
  const left =
    firstFiniteAttr([
      [arrangementElement, 'width_cover_left'],
      [arrangementElement, 'depth_cover_left'],
      [simpleBarElement, 'width_cover_left'],
      [arrangementElement, 'depth_cover_start_X'],
      [simpleBarElement, 'depth_cover_start_X'],
      [simpleBarElement, 'depth_cover_left'],
    ]) ?? top;
  const right =
    firstFiniteAttr([
      [arrangementElement, 'width_cover_right'],
      [arrangementElement, 'depth_cover_right'],
      [simpleBarElement, 'width_cover_right'],
      [arrangementElement, 'depth_cover_end_X'],
      [simpleBarElement, 'depth_cover_end_X'],
      [simpleBarElement, 'depth_cover_right'],
    ]) ?? top;

  if ([top, bottom, left, right].every((value) => value === null)) return null;
  return { top, bottom, left, right };
}

/**
 * 梁の1段目主筋重心位置を抽出する。
 * ST-Bridge v2.0.2のcenter_*と、既存v2.1系入力で使用されるcenter_X/Yを
 * かぶりとは分離して保持する。
 */
export function extractBeamMainCenters(arrangementElement, simpleBarElement) {
  const top = firstFiniteAttr([
    [arrangementElement, 'center_top'],
    [simpleBarElement, 'center_top'],
    [simpleBarElement, 'center_X'],
  ]);
  const bottom = firstFiniteAttr([
    [arrangementElement, 'center_bottom'],
    [simpleBarElement, 'center_bottom'],
    [simpleBarElement, 'center_Y'],
  ]);
  const side = firstFiniteAttr([
    [arrangementElement, 'center_side'],
    [simpleBarElement, 'center_side'],
  ]);

  if ([top, bottom, side].every((value) => value === null)) return null;
  return { top, bottom, side };
}

/**
 * 互換coverオブジェクトへ、列挙されない厳密メタデータを付与する。
 * JSON/DeepEqual等の既存4面APIを変えず、断面リスト作図だけが
 * depth_coverとcenter_*を区別して利用できるようにする。
 */
function attachBeamCoverMetadata(cover, sourceCover, mainCenters) {
  Object.defineProperties(cover, {
    sourceCover: {
      value: sourceCover,
      enumerable: false,
      configurable: false,
      writable: false,
    },
    mainCenters: {
      value: mainCenters,
      enumerable: false,
      configurable: false,
      writable: false,
    },
  });
  return cover;
}

/**
 * 既存抽出データの `cover` 互換API。
 *
 * 歴史的にcenter_*をdepth_cover欠損時のフォールバックとして返しているため、
 * 既存利用者・テストを壊さないよう当面維持する。ただし断面リスト作図では、
 * 非列挙のsourceCover/mainCentersを参照して両者を厳密に分離する。
 */
export function extractBeamCover(arrangementElement, simpleBarElement) {
  const sourceCover = extractBeamSourceCover(arrangementElement, simpleBarElement);
  const centers = extractBeamMainCenters(arrangementElement, simpleBarElement);

  const top = sourceCover?.top ?? centers?.top ?? null;
  const bottom = sourceCover?.bottom ?? centers?.bottom ?? null;
  const left = sourceCover?.left ?? centers?.side ?? centers?.top ?? null;
  const right = sourceCover?.right ?? centers?.side ?? centers?.top ?? null;

  if ([top, bottom, left, right].every((value) => value === null)) return null;
  return attachBeamCoverMetadata({ top, bottom, left, right }, sourceCover, centers);
}
