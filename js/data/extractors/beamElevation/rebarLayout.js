/**
 * @fileoverview 梁主筋の配置算定とあき・干渉チェック
 *
 * かぶり・あき係数（1.5d / 2.0d 等）・粗骨材最大寸法といった設定値から、
 * 主筋の段位置（梁天端からの距離）と断面内の水平あきを算定し、
 * 「鉄筋同士が重なっていないか」「貫通孔が主筋に干渉していないか」を判定する。
 *
 * ST-Bridgeには鉄筋の3次元位置が入っていないため、ここでの位置は
 * かぶり・あきの設定から construct した想定配置である。
 *
 * @module data/extractors/beamElevation/rebarLayout
 */

import {
  REBAR_SPACING_RULES,
  minBarClearanceMm,
  barDiameterMm,
  barOuterDiameterMm,
  resolveWebBarRequirement,
  WEB_BAR_RULES,
} from '../../../constants/beamOpeningRules.js';

/**
 * 配置設定の既定値
 * @returns {{coverMm:number, clearanceDiaFactor:number, maxAggregateSizeMm:number,
 *            holeDiameterMm:number|null, holeCenterRatio:number}}
 */
export function createDefaultRebarSettings() {
  return {
    coverMm: REBAR_SPACING_RULES.defaultCoverMm,
    clearanceDiaFactor: REBAR_SPACING_RULES.defaultClearanceDiaFactor,
    maxAggregateSizeMm: REBAR_SPACING_RULES.maxAggregateSizeMm,
    /** null のとき「孔径の上限 min(D/3,750)」を使う */
    holeDiameterMm: null,
    /** null のときモデルから拾ったスラブ厚を使う */
    slabDepthMm: null,
    /** 孔中心の高さ（梁天端からの比率） */
    holeCenterRatio: 0.5,
    /**
     * この梁の主筋が直交方向（内側）に配置されるか。
     * 交差部ではX方向梁とY方向梁の主筋が重なるため、内側の梁は主筋位置が
     * 主筋の最大外径ぶん内側へ寄り、かぶりが大きくなる。
     */
    isOrthogonalDirection: false,
    /** 基礎梁として腹筋ルールを適用するか（null のとき STB属性＋梁名推定の既定値を使う） */
    isFoundationBeam: null,
  };
}

/**
 * 1段分の主筋配置を組み立てる
 * @param {Object} bar - {total, first, second, dia}
 * @param {number} step - 段番号（1 or 2）
 * @returns {{count:number, dia:number}|null}
 */
function layerOf(bar, step) {
  if (!bar) return null;
  const count = step === 1 ? bar.first : bar.second;
  if (!count) return null;
  return { count, dia: barDiameterMm(bar.dia, 25) };
}

/**
 * チェック結果を1件作る
 * @param {string} label - 表示名
 * @param {number} actual - 実際の値 [mm]
 * @param {number} required - 必要値 [mm]
 * @param {string} unitNote - 補足（判定式など）
 * @returns {Object}
 */
function makeCheck(label, actual, required, unitNote) {
  return {
    label,
    actual,
    required,
    note: unitNote,
    comparison: 'min',
    ok: actual >= required - 1e-6,
  };
}

/**
 * 上限値との比較チェックを1件作る
 * @param {string} label - 表示名
 * @param {number} actual - 実際の値 [mm]
 * @param {number} limit - 上限値 [mm]
 * @param {string} unitNote - 補足
 * @returns {Object}
 */
function makeMaxCheck(label, actual, limit, unitNote) {
  return {
    label,
    actual,
    required: limit,
    note: unitNote,
    comparison: 'max',
    ok: actual <= limit + 1e-6,
  };
}

/**
 * 主筋配置とあき・干渉チェックを算定する
 * @param {Object} span - スパンデータ（extractBeamElevationData の spans[i]）
 * @param {Object} [settings] - createDefaultRebarSettings() の設定値
 * @param {string} [positionKey='start'] - 参照する断面位置（'start' | 'center' | 'end'）
 * @returns {Object} {layers, hole, checks, requiredClearance, effectiveDepth}
 */
export function computeRebarLayout(span, settings = {}, positionKey = 'start') {
  const config = { ...createDefaultRebarSettings(), ...settings };
  const position = span.section[positionKey] || span.section.start || span.section.center;
  const depth = span.section.depth;
  const width = span.section.width;

  const stirrupDia = barDiameterMm(position?.stirrup?.dia, 10);
  const topDia = barDiameterMm(position?.topBar?.dia, 25);
  const bottomDia = barDiameterMm(position?.bottomBar?.dia, 25);
  // 実配置位置は節を含む最大外径で決まる
  const stirrupOuter = barOuterDiameterMm(position?.stirrup?.dia, 10);
  const topOuter = barOuterDiameterMm(position?.topBar?.dia, 25);
  const bottomOuter = barOuterDiameterMm(position?.bottomBar?.dia, 25);

  const clearanceOptions = {
    clearanceDiaFactor: config.clearanceDiaFactor,
    maxAggregateSizeMm: config.maxAggregateSizeMm,
  };
  const requiredTop = minBarClearanceMm(topDia, clearanceOptions);
  const requiredBottom = minBarClearanceMm(bottomDia, clearanceOptions);

  // 段位置（梁天端からの距離）。かぶりはあばら筋外面までとする。
  const layers = [];
  const pushLayer = (side, step, bar, required) => {
    const layer = layerOf(bar, step);
    if (!layer) return null;
    const outer = side === 'top' ? topOuter : bottomOuter;
    // 主筋中心 = かぶり + あばら筋の最大外径 + 主筋の最大外径/2。
    // 直交方向（内側）の梁は、交差する梁の主筋の上（下）に載るため
    // 主筋の最大外径ぶん内側へ寄る。
    const firstCenter =
      config.coverMm + stirrupOuter + outer / 2 + (config.isOrthogonalDirection ? outer : 0);
    const offset = step === 1 ? firstCenter : firstCenter + outer + required;
    const entry = {
      side,
      step,
      count: layer.count,
      dia: layer.dia,
      /** 梁天端からの中心位置 [mm] */
      centerFromTop: side === 'top' ? offset : depth - offset,
    };
    layers.push(entry);
    return entry;
  };

  const top1 = pushLayer('top', 1, position?.topBar, requiredTop);
  const top2 = pushLayer('top', 2, position?.topBar, requiredTop);
  const bottom1 = pushLayer('bottom', 1, position?.bottomBar, requiredBottom);
  const bottom2 = pushLayer('bottom', 2, position?.bottomBar, requiredBottom);

  // 腹筋（梁せいと梁種別から必要段数を決め、上端筋〜下端筋の間へ等間隔に配置する）
  const isFoundation = config.isFoundationBeam ?? Boolean(span.isFoundationBeam);
  const webBarRule = resolveWebBarRequirement(depth, isFoundation);
  const topMost = top1;
  const bottomMost = bottom1;
  const webBars = [];
  if (webBarRule.required && topMost && bottomMost) {
    const spanTop = topMost.centerFromTop;
    const spanBottom = bottomMost.centerFromTop;
    for (let i = 1; i <= webBarRule.layers; i++) {
      webBars.push({
        step: i,
        dia: barDiameterMm(webBarRule.dia, 10),
        centerFromTop: spanTop + ((spanBottom - spanTop) * i) / (webBarRule.layers + 1),
      });
    }
  }

  // スラブ（天端＝梁天端）。この範囲は貫通孔を通せない。
  // 基礎の耐圧版など梁せいを超える厚さが拾われることがあるため梁せいで頭打ちにする。
  const slabDepth = Math.min(Math.max(config.slabDepthMm ?? span.slab?.depth ?? 0, 0), depth);

  // 貫通孔
  const holeDiameter = config.holeDiameterMm ?? span.opening.maxDiameter;
  const hole = {
    diameter: holeDiameter,
    radius: holeDiameter / 2,
    centerFromTop: depth * config.holeCenterRatio,
  };

  const checks = [];

  // 断面内の水平あき（同一段の主筋どうし）
  const horizontalClearance = (layer) => {
    if (!layer || layer.count < 2) return null;
    const inner = width - 2 * (config.coverMm + stirrupOuter);
    const outer = layer.side === 'top' ? topOuter : bottomOuter;
    return (inner - layer.count * outer) / (layer.count - 1);
  };
  for (const [layer, required, name] of [
    [top1, requiredTop, '上端筋1段'],
    [top2, requiredTop, '上端筋2段'],
    [bottom1, requiredBottom, '下端筋1段'],
    [bottom2, requiredBottom, '下端筋2段'],
  ]) {
    const actual = horizontalClearance(layer);
    if (actual === null) continue;
    checks.push(
      makeCheck(
        `${name}の水平あき（${layer.count}-D${layer.dia}）`,
        actual,
        required,
        `必要あき = max(${config.clearanceDiaFactor}d, 1.25×粗骨材${config.maxAggregateSizeMm}, 25)`,
      ),
    );
  }

  // 上端筋と下端筋の重なり（最下段の上端筋と最上段の下端筋）
  const lowestTop = top2 || top1;
  const highestBottom = bottom2 || bottom1;
  if (lowestTop && highestBottom) {
    const actual =
      highestBottom.centerFromTop -
      highestBottom.dia / 2 -
      (lowestTop.centerFromTop + lowestTop.dia / 2);
    checks.push(
      makeCheck(
        '上端筋と下端筋のあき',
        actual,
        Math.max(requiredTop, requiredBottom),
        '段が梁せいに収まるか',
      ),
    );
  }

  // 貫通孔と主筋のあき
  if (lowestTop) {
    const actual = hole.centerFromTop - hole.radius - (lowestTop.centerFromTop + lowestTop.dia / 2);
    checks.push(
      makeCheck(
        `貫通孔(φ${Math.round(hole.diameter)})と上端筋のあき`,
        actual,
        requiredTop,
        '孔上端〜主筋下端',
      ),
    );
  }
  if (highestBottom) {
    const actual =
      highestBottom.centerFromTop - highestBottom.dia / 2 - (hole.centerFromTop + hole.radius);
    checks.push(
      makeCheck(
        `貫通孔(φ${Math.round(hole.diameter)})と下端筋のあき`,
        actual,
        requiredBottom,
        '孔下端〜主筋上端',
      ),
    );
  }

  // スラブがある場合、孔はスラブ下端より下に収まる必要がある
  if (slabDepth > 0) {
    checks.push(
      makeCheck(
        `貫通孔とスラブ下端のあき（スラブ厚${Math.round(slabDepth)}）`,
        hole.centerFromTop - hole.radius - slabDepth,
        0,
        'スラブ内には孔を通せない',
      ),
    );
  }

  // 腹筋の要否
  checks.push({
    label: '腹筋',
    actual: webBarRule.layers,
    required: webBarRule.layers,
    note:
      `${isFoundation ? '基礎梁' : '一般梁'} D=${Math.round(depth)} → ${webBarRule.text}` +
      `（幅止め筋 ${WEB_BAR_RULES.widthStopBar.dia}@${WEB_BAR_RULES.widthStopBar.maxPitchMm}以内）`,
    comparison: 'info',
    ok: true,
  });

  // 孔径の上限
  checks.push(
    makeMaxCheck(
      '孔径',
      hole.diameter,
      span.opening.maxDiameter,
      `H ≤ min(D/3, 750) = φ${Math.round(span.opening.maxDiameter)}`,
    ),
  );

  // 有効せい d: 引張縁（梁下端）から下端主筋重心までを差し引いた値
  const bottomLayers = [bottom1, bottom2].filter(Boolean);
  const bottomBarTotal = bottomLayers.reduce((sum, layer) => sum + layer.count, 0);
  const effectiveDepth = bottomBarTotal
    ? bottomLayers.reduce((sum, layer) => sum + layer.centerFromTop * layer.count, 0) /
      bottomBarTotal
    : depth;

  return {
    layers,
    webBars,
    webBarRule,
    slabDepth,
    isFoundationBeam: isFoundation,
    hole,
    checks,
    requiredClearance: { top: requiredTop, bottom: requiredBottom },
    stirrupDia,
    coverMm: config.coverMm,
    effectiveDepth,
    settings: config,
  };
}
