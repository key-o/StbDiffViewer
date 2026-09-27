/**
 * @fileoverview RC梁断面抽出の共有純関数
 *
 * 位置名の決定・かぶり抽出・主筋重心位置/段間隔抽出・整数パースなど、
 * modern(2.1.x)/legacy(2.0.2) 双方から共有される状態非依存ヘルパーを提供する。
 */

/** @type {WeakMap<Document, Object|null>} */
const beamRebarPositionApplyCache = new WeakMap();

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

function firstFiniteAttrWithSource(candidates) {
  for (const [element, attribute, source] of candidates) {
    const value = parseFloat(element?.getAttribute(attribute));
    if (Number.isFinite(value)) return { value, source };
  }
  return { value: null, source: null };
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
 * 梁多段筋の段間位置情報を抽出する。
 *
 * v2.0.2仕様の length_to_center は段筋重心間距離、interval は段筋のあき。
 * v2.1.xでは center_interval を段筋重心間距離として扱う。
 */
export function extractBeamLayerSpacing(arrangementElement, simpleBarElement) {
  const center = firstFiniteAttrWithSource([
    [arrangementElement, 'length_to_center', 'stb-length-to-center'],
    [simpleBarElement, 'length_to_center', 'stb-length-to-center'],
    [arrangementElement, 'center_interval', 'stb-center-interval'],
    [simpleBarElement, 'center_interval', 'stb-center-interval'],
  ]);
  const clearInterval = firstFiniteAttr([
    [arrangementElement, 'interval'],
    [simpleBarElement, 'interval'],
  ]);

  if (center.value === null && clearInterval === null) return null;
  const result = { centerInterval: center.value, clearInterval };
  Object.defineProperty(result, 'centerSource', {
    value: center.source,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

function firstByTagName(root, tagName) {
  if (!root?.getElementsByTagName) return null;
  const elements = root.getElementsByTagName(tagName);
  return elements?.length ? elements[0] : null;
}

function buildLegacyBeamApplyDefaults(apply) {
  const setDefault = String(apply.getAttribute('set_default')).toLowerCase() === 'true';
  const topBottomCover = firstFiniteAttr([[apply, 'depth_cover_top_bottom']]);
  const sideCover = firstFiniteAttr([[apply, 'depth_cover_side']]);
  const topBottomCenter = firstFiniteAttr([[apply, 'center_top_bottom']]);
  const sideCenter = firstFiniteAttr([[apply, 'center_side']]);
  const centerInterval = firstFiniteAttr([[apply, 'length_to_center']]);
  const clearInterval = firstFiniteAttr([[apply, 'interval']]);

  return {
    applicable: true,
    setDefault,
    sourceCover:
      topBottomCover === null && sideCover === null
        ? null
        : {
            top: topBottomCover,
            bottom: topBottomCover,
            left: sideCover,
            right: sideCover,
          },
    mainCenters:
      topBottomCenter === null && sideCenter === null
        ? null
        : {
            top: topBottomCenter,
            bottom: topBottomCenter,
            side: sideCenter,
            left: sideCenter,
            right: sideCenter,
          },
    layerSpacing:
      centerInterval === null && clearInterval === null ? null : { centerInterval, clearInterval },
  };
}

function buildModernBeamApplyDefaults(apply) {
  const top = firstFiniteAttr([[apply, 'depth_cover_top']]);
  const bottom = firstFiniteAttr([[apply, 'depth_cover_bottom']]);
  const left = firstFiniteAttr([[apply, 'depth_cover_left']]);
  const right = firstFiniteAttr([[apply, 'depth_cover_right']]);
  const centerTop = firstFiniteAttr([[apply, 'center_top']]);
  const centerBottom = firstFiniteAttr([[apply, 'center_bottom']]);
  const centerSide = firstFiniteAttr([[apply, 'center_side']]);
  const centerInterval = firstFiniteAttr([[apply, 'center_interval']]);
  const clearInterval = firstFiniteAttr([[apply, 'interval']]);

  return {
    applicable: true,
    setDefault: true,
    sourceCover: [top, bottom, left, right].every((value) => value === null)
      ? null
      : { top, bottom, left, right },
    mainCenters: [centerTop, centerBottom, centerSide].every((value) => value === null)
      ? null
      : {
          top: centerTop,
          bottom: centerBottom,
          side: centerSide,
          left: centerSide,
          right: centerSide,
        },
    layerSpacing:
      centerInterval === null && clearInterval === null ? null : { centerInterval, clearInterval },
  };
}

/**
 * 梁配筋位置Applyの適用状態と省略値を抽出する。
 * v2.0.2の StbBeam_RC_RebarPositionApply と、v2.1.xの
 * StbApplyConditionList_RC/StbApply_RC_Beam の双方を認識する。
 * StbApplyConditionsList がない場合は適用可否を判断できないため null とする。
 * Apply list はあるが対象要素がない場合だけ applicable=false とする。
 */
export function extractBeamRebarPositionApplyDefaults(arrangementElement, simpleBarElement) {
  const doc = arrangementElement?.ownerDocument || simpleBarElement?.ownerDocument || null;
  if (!doc) return null;
  if (beamRebarPositionApplyCache.has(doc)) return beamRebarPositionApplyCache.get(doc);

  const list = firstByTagName(doc, 'StbApplyConditionsList');
  if (!list) {
    beamRebarPositionApplyCache.set(doc, null);
    return null;
  }

  const rcList = firstByTagName(list, 'StbApplyConditionList_RC');
  const modernApply = firstByTagName(rcList, 'StbApply_RC_Beam');
  const legacyApply = firstByTagName(list, 'StbBeam_RC_RebarPositionApply');
  const result = modernApply
    ? buildModernBeamApplyDefaults(modernApply)
    : legacyApply
      ? buildLegacyBeamApplyDefaults(legacyApply)
      : {
          applicable: false,
          setDefault: false,
          sourceCover: null,
          mainCenters: null,
          layerSpacing: null,
        };

  beamRebarPositionApplyCache.set(doc, result);
  return result;
}

/**
 * 互換coverオブジェクトへ、列挙されない厳密メタデータを付与する。
 * JSON/DeepEqual等の既存4面APIを変えず、断面リスト/3Dだけが
 * depth_cover / center_* / 段間隔 / Apply条件を区別して利用できるようにする。
 */
function attachBeamCoverMetadata(cover, sourceCover, mainCenters, layerSpacing, applyDefaults) {
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
    layerSpacing: {
      value: layerSpacing,
      enumerable: false,
      configurable: false,
      writable: false,
    },
    applyDefaults: {
      value: applyDefaults,
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
 * 既存利用者・テストを壊さないよう当面維持する。ただし位置resolverでは、
 * 非列挙のsourceCover/mainCenters/layerSpacing/applyDefaultsを参照して意味を厳密に分離する。
 */
export function extractBeamCover(arrangementElement, simpleBarElement) {
  const sourceCover = extractBeamSourceCover(arrangementElement, simpleBarElement);
  const centers = extractBeamMainCenters(arrangementElement, simpleBarElement);
  const layerSpacing = extractBeamLayerSpacing(arrangementElement, simpleBarElement);
  const applyDefaults = extractBeamRebarPositionApplyDefaults(arrangementElement, simpleBarElement);

  const top = sourceCover?.top ?? centers?.top ?? null;
  const bottom = sourceCover?.bottom ?? centers?.bottom ?? null;
  const left = sourceCover?.left ?? centers?.side ?? centers?.top ?? null;
  const right = sourceCover?.right ?? centers?.side ?? centers?.top ?? null;
  const hasFaceValue = ![top, bottom, left, right].every((value) => value === null);
  const hasApplyMeaning = applyDefaults !== null;

  if (!hasFaceValue && !layerSpacing && !hasApplyMeaning) return null;
  if (!hasFaceValue) {
    return attachBeamCoverMetadata({}, sourceCover, centers, layerSpacing, applyDefaults);
  }
  return attachBeamCoverMetadata(
    { top, bottom, left, right },
    sourceCover,
    centers,
    layerSpacing,
    applyDefaults,
  );
}
