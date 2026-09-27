/**
 * @fileoverview R13 基礎梁主筋の必要定着長とsupport内available projectionを比較する純粋gate。
 *
 * 必要定着長そのものはこのモジュールで決めない。requiredAnchorageMm が解決済みのbarだけを
 * 比較し、未解決値を0や標準既定値で補完しない。
 */

const EPS_MM = 1e-6;

function unresolved(reason, extra = {}) {
  return {
    status: 'UNRESOLVED',
    resolved: false,
    satisfied: null,
    reason,
    ...extra,
  };
}

function compareBar(bar, fallbackAvailableMm = null) {
  const requiredMm = Number(bar?.requiredAnchorageMm);
  const availableMm = Number.isFinite(bar?.availableProjectionMm)
    ? bar.availableProjectionMm
    : fallbackAvailableMm;

  if (bar?.anchorageRequirementResolved !== true || !(requiredMm > 0)) {
    return unresolved(
      bar?.anchorageRequirementReason || 'foundation-anchorage-required-length-unresolved',
      {
        barIndex: bar?.barIndex ?? null,
        role: bar?.role || null,
        requiredAnchorageMm: null,
        availableProjectionMm: Number.isFinite(availableMm) ? availableMm : null,
      },
    );
  }
  if (!Number.isFinite(availableMm) || !(availableMm >= 0)) {
    return unresolved('foundation-anchorage-available-projection-unresolved', {
      barIndex: bar?.barIndex ?? null,
      role: bar?.role || null,
      requiredAnchorageMm: requiredMm,
      availableProjectionMm: null,
    });
  }

  const marginMm = availableMm - requiredMm;
  const satisfied = marginMm >= -EPS_MM;
  return {
    status: satisfied ? 'PASS' : 'INSUFFICIENT',
    resolved: true,
    satisfied,
    reason: satisfied ? null : 'foundation-anchorage-projection-insufficient',
    barIndex: bar?.barIndex ?? null,
    role: bar?.role || null,
    requiredAnchorageMm: requiredMm,
    availableProjectionMm: availableMm,
    marginMm,
  };
}

/**
 * endpointの全主筋について必要長とavailable projectionを比較する。
 *
 * @param {Object} endpoint foundationBeamEndpointFactsの1端
 * @returns {{status:string,resolved:boolean,satisfied:boolean|null,reason:string|null,bars:Array<Object>}}
 */
export function evaluateFoundationBeamAnchorageAvailability(endpoint) {
  if (!endpoint?.resolved) {
    return unresolved('foundation-beam-endpoint-facts-unresolved', {
      bars: [],
      blockers: [...(endpoint?.reasons || [])],
    });
  }
  const bars = endpoint.mainBars || [];
  if (!bars.length) {
    return unresolved('foundation-beam-main-bars-missing', { bars: [] });
  }

  const fallbackAvailableMm = Number.isFinite(endpoint.availableProjectionMm)
    ? endpoint.availableProjectionMm
    : null;
  const results = bars.map((bar) => compareBar(bar, fallbackAvailableMm));
  const unresolvedBars = results.filter((result) => !result.resolved);
  if (unresolvedBars.length) {
    return {
      status: 'UNRESOLVED',
      resolved: false,
      satisfied: null,
      reason: 'foundation-anchorage-bar-requirement-unresolved',
      bars: results,
      blockers: [...new Set(unresolvedBars.map((item) => item.reason).filter(Boolean))],
    };
  }

  const insufficient = results.filter((result) => !result.satisfied);
  return {
    status: insufficient.length ? 'INSUFFICIENT' : 'PASS',
    resolved: true,
    satisfied: insufficient.length === 0,
    reason: insufficient.length ? 'foundation-anchorage-projection-insufficient' : null,
    bars: results,
    blockers: insufficient.length ? ['foundation-anchorage-projection-insufficient'] : [],
  };
}

export const _foundationBeamAnchorageAvailabilityInternals = Object.freeze({
  compareBar,
});
