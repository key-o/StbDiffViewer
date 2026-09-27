/**
 * @fileoverview R13 基礎梁endpointをproduction geometryへ進める直前のfail-closed gate。
 *
 * 定着必要長やあばら筋取合い規則そのものは決めない。既に解決済みのrequirement/check結果を
 * 集約し、全て満足する場合だけREADYとする。
 */

import { evaluateFoundationBeamAnchorageAvailability } from './foundationBeamAnchorageAvailability.js';

export const FOUNDATION_BEAM_ENDPOINT_GATE_STATUS = Object.freeze({
  READY: 'READY',
  UNRESOLVED: 'UNRESOLVED',
  BLOCKED: 'BLOCKED',
  INVALID: 'INVALID',
});

function result(status, blockers = [], extra = {}) {
  return {
    status,
    ready: status === FOUNDATION_BEAM_ENDPOINT_GATE_STATUS.READY,
    blockers: [...new Set(blockers.filter(Boolean))],
    ...extra,
  };
}

function resolveStirrupInteraction(endpoint) {
  if (endpoint?.stirrupInteractionRequirementResolved !== true) {
    return result(FOUNDATION_BEAM_ENDPOINT_GATE_STATUS.UNRESOLVED, [
      endpoint?.stirrupInteractionRequirementReason ||
        'foundation-beam-stirrup-interaction-requirement-unresolved',
    ]);
  }
  if (typeof endpoint?.stirrupInteractionSatisfied !== 'boolean') {
    return result(FOUNDATION_BEAM_ENDPOINT_GATE_STATUS.INVALID, [
      'foundation-beam-stirrup-interaction-result-missing',
    ]);
  }
  if (!endpoint.stirrupInteractionSatisfied) {
    return result(FOUNDATION_BEAM_ENDPOINT_GATE_STATUS.BLOCKED, [
      endpoint?.stirrupInteractionFailureReason ||
        'foundation-beam-stirrup-interaction-unsatisfied',
    ]);
  }
  return result(FOUNDATION_BEAM_ENDPOINT_GATE_STATUS.READY);
}

/**
 * @param {Object} endpoint foundationBeamEndpointFactsの1端
 * @param {Object} [options]
 * @param {Object|null} [options.anchorageAvailability] 既計算available gate結果
 * @returns {{status:string,ready:boolean,blockers:string[],anchorage:Object|null,stirrupInteraction:Object|null}}
 */
export function resolveFoundationBeamEndpointProductionGate(endpoint, options = {}) {
  if (!endpoint || endpoint.resolved !== true) {
    return result(
      FOUNDATION_BEAM_ENDPOINT_GATE_STATUS.UNRESOLVED,
      ['foundation-beam-endpoint-facts-unresolved', ...(endpoint?.reasons || [])],
      { anchorage: null, stirrupInteraction: null },
    );
  }

  const anchorage =
    options.anchorageAvailability || evaluateFoundationBeamAnchorageAvailability(endpoint);
  if (!anchorage || anchorage.resolved !== true) {
    return result(
      FOUNDATION_BEAM_ENDPOINT_GATE_STATUS.UNRESOLVED,
      [
        anchorage?.reason || 'foundation-anchorage-availability-unresolved',
        ...(anchorage?.blockers || []),
      ],
      { anchorage: anchorage || null, stirrupInteraction: null },
    );
  }
  if (anchorage.satisfied !== true) {
    return result(
      FOUNDATION_BEAM_ENDPOINT_GATE_STATUS.BLOCKED,
      [
        anchorage.reason || 'foundation-anchorage-projection-insufficient',
        ...(anchorage.blockers || []),
      ],
      { anchorage, stirrupInteraction: null },
    );
  }

  const stirrupInteraction = resolveStirrupInteraction(endpoint);
  if (!stirrupInteraction.ready) {
    return result(stirrupInteraction.status, stirrupInteraction.blockers, {
      anchorage,
      stirrupInteraction,
    });
  }

  return result(FOUNDATION_BEAM_ENDPOINT_GATE_STATUS.READY, [], {
    anchorage,
    stirrupInteraction,
  });
}

export const _foundationBeamEndpointProductionGateInternals = Object.freeze({
  resolveStirrupInteraction,
});
