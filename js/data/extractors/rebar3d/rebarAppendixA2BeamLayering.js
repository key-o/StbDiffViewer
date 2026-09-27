/**
 * @fileoverview 配筋指針2010 付録A A2の直交梁主筋レイヤリング純関数。
 *
 * 組立順が決まると、直交梁主筋が上下に重なるため上端・下端の実かぶりが方向ごとに
 * 変わる。ここではその依存関係だけを解決し、3D geometryやSTB断面値は変更しない。
 */

import { barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';
import { OrthogonalBeamAssemblyOrder } from '../../../config/rebarDetailingChoice.js';
import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';

const A2_LAYERING_RULE = rebarRuleTraceMetadata('APPENDIX-A2-ORTHOGONAL-BEAM-COVER-STACKING');

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function resolveOuterDiameter(designation, explicitMm) {
  const explicit = positiveNumber(explicitMm);
  if (explicit !== null) return explicit;
  const normalized = String(designation || '')
    .trim()
    .toUpperCase();
  if (!/^D\d+$/.test(normalized)) return null;
  const outer = barOuterDiameterMm(normalized, NaN);
  return positiveNumber(outer);
}

function ceilTo(value, increment) {
  const step = positiveNumber(increment) ?? 1;
  return Math.ceil(value / step - 1e-12) * step;
}

/**
 * 組立順 A -> B のとき:
 * - 上端: 後組みBが上側、先組みAはBの最大外径分だけ下がる
 * - 下端: 先組みAが下側、後組みBはAの最大外径分だけ上がる
 */
export function resolveAppendixA2OrthogonalBeamCoverStacking({
  assemblyOrder,
  baseCoverMm = 40,
  xMainBarDia,
  yMainBarDia,
  xMainBarOuterDiameterMm = null,
  yMainBarOuterDiameterMm = null,
  coverRoundUpMm = 5,
} = {}) {
  const baseCover = positiveNumber(baseCoverMm);
  const xOuter = resolveOuterDiameter(xMainBarDia, xMainBarOuterDiameterMm);
  const yOuter = resolveOuterDiameter(yMainBarDia, yMainBarOuterDiameterMm);

  if (baseCover === null) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-base-cover-unresolved',
    };
  }
  if (xOuter === null || yOuter === null) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-main-bar-outer-diameter-unresolved',
      xMainBarOuterDiameterMm: xOuter,
      yMainBarOuterDiameterMm: yOuter,
    };
  }
  if (
    ![OrthogonalBeamAssemblyOrder.X_THEN_Y, OrthogonalBeamAssemblyOrder.Y_THEN_X].includes(
      assemblyOrder,
    )
  ) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-orthogonal-beam-assembly-order-explicit-required',
      assemblyOrder,
      xMainBarOuterDiameterMm: xOuter,
      yMainBarOuterDiameterMm: yOuter,
    };
  }

  const raw = {
    X: { top: baseCover, bottom: baseCover },
    Y: { top: baseCover, bottom: baseCover },
  };

  if (assemblyOrder === OrthogonalBeamAssemblyOrder.X_THEN_Y) {
    raw.X.top += yOuter;
    raw.Y.bottom += xOuter;
  } else {
    raw.Y.top += xOuter;
    raw.X.bottom += yOuter;
  }

  const rounded = {
    X: {
      top: ceilTo(raw.X.top, coverRoundUpMm),
      bottom: ceilTo(raw.X.bottom, coverRoundUpMm),
    },
    Y: {
      top: ceilTo(raw.Y.top, coverRoundUpMm),
      bottom: ceilTo(raw.Y.bottom, coverRoundUpMm),
    },
  };

  return {
    ok: true,
    status: 'RESOLVED',
    assemblyOrder,
    baseCoverMm: baseCover,
    xMainBarOuterDiameterMm: xOuter,
    yMainBarOuterDiameterMm: yOuter,
    coverRoundUpMm: positiveNumber(coverRoundUpMm) ?? 1,
    rawCoverMm: raw,
    roundedCoverMm: rounded,
    geometryApplication: 'NOT_CONNECTED',
    appliedRules: [A2_LAYERING_RULE],
  };
}
