/**
 * @fileoverview 配筋指針2010 付録A A2の隅柱・仕口施工choiceをproduction gateへ接続する。
 *
 * 本モジュールは、最終鉄筋geometryと施工方法を分離する。
 * - 隅柱梁の定着方法: 抱え込みはA2-5のactual 4d arc path generatorへ接続する。
 *   U字形は個々のtop/bottom bar pairingがsourceから一意に定まらないためfail-closed。
 * - 混雑緩和: 梁突出し / 梁内寄せはコンクリート部材geometryを変更するため、
 *   標準図から寸法を推定しない。project EXPLICIT geometryはsidecarへ昇格するが、
 *   structural member consumer未接続の間はWorking Documentを変更しない。
 * - 仕口部帯筋施工: 落とし込み / 現場組立 / アコーディオンは施工順序のchoiceであり、
 *   完成時の帯筋geometryは同一としてmetadataへ接続する。
 */

import {
  CornerJointAnchorageMethod,
  CornerJointCongestionMethod,
  JointHoopConstructionMethod,
  normalizeRebarDetailingChoice,
} from '../../../config/rebarDetailingChoice.js';
import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';
import { resolveAppendixA2CornerCongestionGeometry } from './rebarAppendixA2CongestionGeometry.js';

const A2_ANCHORAGE_RULE = rebarRuleTraceMetadata('APPENDIX-A2-CORNER-JOINT-ANCHORAGE-METHOD');
const A2_CONGESTION_RULE = rebarRuleTraceMetadata('APPENDIX-A2-CORNER-JOINT-CONGESTION-METHOD');
const A2_HOOP_CONSTRUCTION_RULE = rebarRuleTraceMetadata(
  'APPENDIX-A2-JOINT-HOOP-CONSTRUCTION-METHOD',
);

function anchorageChoice(method) {
  if (method === CornerJointAnchorageMethod.EXPLICIT_REQUIRED) {
    return {
      method,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-corner-anchorage-method-explicit-required',
      geometryApplication: 'NOT_APPLIED',
    };
  }
  if (method === CornerJointAnchorageMethod.ENCLOSING_ANCHORAGE) {
    return {
      method,
      status: 'CHOICE_READY',
      reason: null,
      geometryApplication: 'ACTUAL_BAR_PATH_CONNECTED',
    };
  }
  if (method === CornerJointAnchorageMethod.U_SHAPE_ANCHORAGE) {
    return {
      method,
      status: 'CHOICE_READY',
      reason: 'appendix-a2-u-shape-bar-pairing-contract-unresolved',
      geometryApplication: 'PATH_GENERATOR_REQUIRED',
    };
  }
  return {
    method,
    status: 'UNRESOLVED',
    reason: `appendix-a2-corner-anchorage-method-unsupported:${method}`,
    geometryApplication: 'NOT_APPLIED',
  };
}

function congestionChoice(method, geometryFeasibility, context = {}) {
  if (method === CornerJointCongestionMethod.STANDARD) {
    const cornerStatus = geometryFeasibility?.cornerHookInsertion?.status || null;
    if (cornerStatus === 'ALTERNATIVE_DETAIL_REQUIRED') {
      return {
        method,
        status: 'DETAIL_ALTERNATIVE_REQUIRED',
        reason: 'appendix-a2-standard-corner-detail-insufficient',
        geometryApplication: 'NOT_APPLIED',
      };
    }
    return {
      method,
      status: 'READY',
      reason: null,
      geometryApplication: 'EXISTING_MEMBER_GEOMETRY',
    };
  }

  if (
    [
      CornerJointCongestionMethod.BEAM_PROJECTION,
      CornerJointCongestionMethod.BEAM_INNER_SETBACK,
    ].includes(method)
  ) {
    const structuralGeometry = resolveAppendixA2CornerCongestionGeometry({
      nodeId: context.nodeId,
      method,
      beams: context.beams || [],
      projectDetailing: context.projectDetailing,
      // The production choice sidecar may be surfaced before the optional
      // STB concrete-switch consumer has enough data to split the member.
      // The representation planner keeps the zone-length gate fail-closed.
      allowUnspecifiedZoneLength: true,
    });
    if (structuralGeometry.status === 'STRUCTURAL_GEOMETRY_READY') {
      return {
        method,
        status: 'STRUCTURAL_GEOMETRY_READY',
        reason: structuralGeometry.reason,
        geometryApplication: structuralGeometry.geometryApplication,
        structuralGeometry,
        requirements: structuralGeometry.requirements,
      };
    }
    return {
      method,
      status: 'STRUCTURAL_GEOMETRY_REQUIRED',
      reason:
        structuralGeometry.reason ||
        (method === CornerJointCongestionMethod.BEAM_PROJECTION
          ? 'appendix-a2-beam-projection-requires-member-geometry'
          : 'appendix-a2-beam-inner-setback-requires-member-geometry'),
      geometryApplication: 'MEMBER_GEOMETRY_NOT_MUTATED',
      structuralGeometry,
      requirements: structuralGeometry.requirements || null,
    };
  }

  return {
    method,
    status: 'UNRESOLVED',
    reason: `appendix-a2-corner-congestion-method-unsupported:${method}`,
    geometryApplication: 'NOT_APPLIED',
  };
}

export function resolveAppendixA2JointHoopConstructionChoice(method) {
  if (method === JointHoopConstructionMethod.EXPLICIT_REQUIRED) {
    return {
      method,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-joint-hoop-construction-method-explicit-required',
      installedGeometry: 'UNCHANGED_FINAL_HOOP_GEOMETRY',
      constructionSequence: null,
      temporaryBundledPreinstallation: false,
      spreadAfterPlacement: false,
      preferredStableClosure: false,
    };
  }

  if (method === JointHoopConstructionMethod.DROP_IN) {
    return {
      method,
      status: 'READY',
      reason: null,
      installedGeometry: 'UNCHANGED_FINAL_HOOP_GEOMETRY',
      constructionSequence: 'DROP_IN',
      temporaryBundledPreinstallation: false,
      spreadAfterPlacement: false,
      preferredStableClosure: false,
    };
  }

  if (method === JointHoopConstructionMethod.IN_PLACE_ASSEMBLY) {
    return {
      method,
      status: 'READY',
      reason: null,
      installedGeometry: 'UNCHANGED_FINAL_HOOP_GEOMETRY',
      constructionSequence: 'IN_PLACE_ASSEMBLY',
      temporaryBundledPreinstallation: false,
      spreadAfterPlacement: false,
      preferredStableClosure: false,
    };
  }

  if (method === JointHoopConstructionMethod.ACCORDION_DROP_IN) {
    return {
      method,
      status: 'READY',
      reason: null,
      installedGeometry: 'UNCHANGED_FINAL_HOOP_GEOMETRY',
      constructionSequence: 'ACCORDION_DROP_IN',
      temporaryBundledPreinstallation: true,
      spreadAfterPlacement: true,
      preferredStableClosure: true,
    };
  }

  return {
    method,
    status: 'UNRESOLVED',
    reason: `appendix-a2-joint-hoop-construction-method-unsupported:${method}`,
    installedGeometry: 'UNCHANGED_FINAL_HOOP_GEOMETRY',
    constructionSequence: null,
    temporaryBundledPreinstallation: false,
    spreadAfterPlacement: false,
    preferredStableClosure: false,
  };
}

export function resolveAppendixA2JointProductionChoices({
  topology,
  choice,
  geometryFeasibility = null,
  nodeId = null,
  beams = [],
  projectDetailing,
} = {}) {
  const normalized = normalizeRebarDetailingChoice(choice);
  const hoop = resolveAppendixA2JointHoopConstructionChoice(
    normalized.joint.hoopConstructionMethod,
  );

  if (topology?.kind !== 'CORNER') {
    return {
      topology: topology?.kind || 'UNRESOLVED',
      status: hoop.status === 'READY' ? 'READY' : 'PARTIAL',
      anchorage: null,
      congestion: null,
      hoopConstruction: hoop,
      appliedRules: [A2_HOOP_CONSTRUCTION_RULE],
    };
  }

  const anchorage = anchorageChoice(normalized.joint.cornerAnchorageMethod);
  const congestion = congestionChoice(
    normalized.joint.cornerCongestionMethod,
    geometryFeasibility,
    { nodeId, beams, projectDetailing },
  );

  const blocking = [anchorage.status, congestion.status, hoop.status].some((status) =>
    [
      'UNRESOLVED',
      'DETAIL_ALTERNATIVE_REQUIRED',
      'STRUCTURAL_GEOMETRY_REQUIRED',
      'STRUCTURAL_GEOMETRY_READY',
    ].includes(status),
  );
  const pathRequired = anchorage.geometryApplication !== 'NOT_APPLIED';

  return {
    topology: 'CORNER',
    status: blocking ? 'UNRESOLVED' : pathRequired ? 'PATH_REQUIRED' : 'READY',
    anchorage,
    congestion,
    hoopConstruction: hoop,
    appliedRules: [A2_ANCHORAGE_RULE, A2_CONGESTION_RULE, A2_HOOP_CONSTRUCTION_RULE],
  };
}

export function buildAppendixA2CornerAnchorageGateMap(checks = []) {
  const gates = new Map();

  for (const check of checks || []) {
    if (check?.jointTopology?.kind !== 'CORNER') continue;
    const anchorage = check?.productionChoices?.anchorage;
    const method = anchorage?.method || null;
    const reason = anchorage
      ? anchorage.reason
      : 'appendix-a2-corner-anchorage-production-path-unresolved';

    for (const beam of [...(check.xBeams || []), ...(check.yBeams || [])]) {
      if (!beam?.id || !['start', 'end'].includes(beam.endpoint)) continue;
      const key = `${beam.id}|${beam.endpoint}`;
      gates.set(key, {
        memberId: String(beam.id),
        endpoint: beam.endpoint,
        nodeId: check.nodeId || null,
        method,
        status: 'SUPPRESS_GENERIC_ANCHORAGE',
        reason,
        genericAnchorageSuppressed: true,
        requiredProductionGeometry: anchorage?.geometryApplication || 'PATH_GENERATOR_REQUIRED',
        appliedRules: [A2_ANCHORAGE_RULE],
      });
    }
  }

  return gates;
}

/**
 * column-hoop member layoutへ施工choice metadataを付加する。
 * final hoop geometryやpitchは変更しない。
 */
export function applyAppendixA2JointHoopConstructionToLayout(layout, choice) {
  if (!layout) return layout;
  const normalized = normalizeRebarDetailingChoice(choice);
  const construction = resolveAppendixA2JointHoopConstructionChoice(
    normalized.joint.hoopConstructionMethod,
  );

  let jointSegmentCount = 0;
  const segments = (layout.segments || []).map((segment) => {
    if (segment?.zoneKind !== 'joint') return segment;
    jointSegmentCount += 1;
    return {
      ...segment,
      appendixA2JointHoopConstruction: {
        method: construction.method,
        status: construction.status,
        constructionSequence: construction.constructionSequence,
        temporaryBundledPreinstallation: construction.temporaryBundledPreinstallation,
        spreadAfterPlacement: construction.spreadAfterPlacement,
        preferredStableClosure: construction.preferredStableClosure,
      },
    };
  });

  return {
    ...layout,
    segments,
    appendixA2JointHoopConstruction: {
      ...construction,
      jointSegmentCount,
      source: 'RC_DETAILING_GUIDE_2010_APPENDIX_A2',
    },
  };
}
