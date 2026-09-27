/**
 * @fileoverview 配筋指針2010 付録A A2 隅柱接合部のactual bar-level定着path。
 *
 * 付図A2-5で示されるフック付きの抱え込み定着を、member端を原点とする
 * anchor-local RebarPathとして生成する。A2本文で直交鉄筋間を通すフック付き定着の
 * 折曲げ内法直径は原則4d以上とされるため、production candidateは最小値4dで生成する。
 *
 * U字形定着はA2本文で選択肢として明記される一方、付図A2-5から個々の主筋を
 * どの相手筋と連続U字化するかまでは一意に決められない。top/bottom bar pairingを
 * 推定するとSTBにない設計判断を作るため、本モジュールではfail-closedを維持する。
 */

import { CornerJointAnchorageMethod } from '../../../config/rebarDetailingChoice.js';
import { createArc, createLine, createRebarPath, validateRebarPath } from './rebarPath.js';
import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';

const EPS = 1e-8;
const INSIDE_DIAMETER_FACTOR = 4;
const A2_ANCHORAGE_RULE = rebarRuleTraceMetadata('APPENDIX-A2-CORNER-JOINT-ANCHORAGE-METHOD');
const A2_HOOK_RULE = rebarRuleTraceMetadata('APPENDIX-A2-CORNER-HOOK-INSIDE-DIA-4D');

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function gradeKey(value) {
  return (
    String(value || '')
      .trim()
      .toUpperCase() || null
  );
}

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    status: 'UNRESOLVED',
    generationStatus: 'UNRESOLVED',
    productionPathCandidate: false,
    productionConsumer: null,
    reason,
    paths: [],
    unresolved: [{ reason, ...extra }],
    appliedRules: [A2_ANCHORAGE_RULE, A2_HOOK_RULE],
    ...extra,
  };
}

function cross(left, right) {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function scale(value, factor) {
  return { x: value.x * factor, y: value.y * factor, z: value.z * factor };
}

function add(left, right) {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(left, right) {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

/**
 * sharp-corner表現の90°定着を、4d内法径のactual centerline arcへ置換する。
 * bendFromBeamEndMmは従来pieceのsharp bend位置を引き継ぐ。
 */
export function buildAppendixA2EnclosingAnchorageBarPath({
  end,
  bar,
  barIndex = null,
  insideDiameterFactor = INSIDE_DIAMETER_FACTOR,
} = {}) {
  const u = finite(bar?.u);
  const v = finite(bar?.v);
  const dia = positive(bar?.dia);
  const cornerAxialMm = finite(end?.bendFromBeamEndMm);
  const tailLengthMm = positive(bar?.tailLengthMm);
  const tailSign = Math.sign(Number(bar?.tailDir));
  const factor = positive(insideDiameterFactor);
  const anchor = end?.side;

  if (
    u === null ||
    v === null ||
    dia === null ||
    cornerAxialMm === null ||
    tailLengthMm === null ||
    ![-1, 1].includes(tailSign) ||
    factor === null ||
    !['start', 'end'].includes(anchor)
  ) {
    return {
      ok: false,
      reason: 'appendix-a2-enclosing-anchorage-bar-input-unresolved',
      path: null,
    };
  }

  const axialSign = Math.sign(cornerAxialMm);
  if (![-1, 1].includes(axialSign)) {
    return {
      ok: false,
      reason: 'appendix-a2-enclosing-anchorage-bend-at-member-end',
      path: null,
    };
  }

  const insideDiameterMm = factor * dia;
  const centerlineRadiusMm = insideDiameterMm / 2 + dia / 2;
  if (!(Math.abs(cornerAxialMm) + EPS > centerlineRadiusMm)) {
    return {
      ok: false,
      reason: 'appendix-a2-enclosing-anchorage-run-too-short-for-4d-bend',
      path: null,
      insideDiameterMm,
      centerlineRadiusMm,
      availableRunMm: Math.abs(cornerAxialMm),
    };
  }

  const sharpCorner = { x: u, y: v, z: cornerAxialMm };
  const incoming = { x: 0, y: 0, z: axialSign };
  const outgoing = { x: 0, y: tailSign, z: 0 };
  const incomingTangent = subtract(sharpCorner, scale(incoming, centerlineRadiusMm));
  const outgoingTangent = add(sharpCorner, scale(outgoing, centerlineRadiusMm));
  const center = add(incomingTangent, scale(outgoing, centerlineRadiusMm));
  const startDirection = scale(outgoing, -1);
  const planeNormal = cross(startDirection, incoming);
  const tailEnd = add(outgoingTangent, scale(outgoing, tailLengthMm));

  const primitives = [];
  const memberEnd = { x: u, y: v, z: 0 };
  if (Math.abs(incomingTangent.z) > EPS) {
    primitives.push(createLine(memberEnd, incomingTangent));
  }
  primitives.push(
    createArc({
      center,
      radius: centerlineRadiusMm,
      planeNormal,
      startDirection,
      sweepAngleRad: Math.PI / 2,
    }),
    createLine(outgoingTangent, tailEnd),
  );

  const path = createRebarPath(primitives, {
    coordinateSpace: 'anchor-local',
    anchor,
    endpoint: anchor,
    role: bar?.role || null,
    layer: bar?.layer ?? null,
    dia,
    diaName: bar?.diaName || null,
    grade: gradeKey(bar?.grade),
    identityKey: bar?.identityKey || null,
    barIndex: Number.isInteger(barIndex) ? barIndex : null,
    source: 'RC_DETAILING_GUIDE_2010_APPENDIX_A2',
    ruleId: 'APPENDIX-A2-CORNER-JOINT-ANCHORAGE-METHOD',
    anchorageMethod: CornerJointAnchorageMethod.ENCLOSING_ANCHORAGE,
    bendGeometry: 'actual-arc',
    bendAngleDeg: 90,
    insideDiameterFactor: factor,
    insideDiameterMm,
    centerlineRadiusMm,
    sharpCornerAxialMm: cornerAxialMm,
    tailLengthMm,
    generationStatus: 'CENTERLINE_READY',
    productionPathCandidate: true,
    productionConsumer: 'appendix-a2-corner-anchor-local-path',
  });
  const validation = validateRebarPath(path);
  if (!validation.ok) {
    return {
      ok: false,
      reason: 'appendix-a2-enclosing-anchorage-path-invalid',
      path: null,
      validation,
    };
  }

  return {
    ok: true,
    reason: null,
    path,
    validation,
    insideDiameterMm,
    centerlineRadiusMm,
  };
}

/**
 * A2 corner gateに応じ、1 beam-end分のactual path candidateを生成する。
 */
export function buildAppendixA2CornerAnchoragePaths({ end, gate } = {}) {
  if (!gate || !end) {
    return unresolved('appendix-a2-corner-anchorage-path-input-missing');
  }
  if (gate.method === CornerJointAnchorageMethod.EXPLICIT_REQUIRED || !gate.method) {
    return unresolved('appendix-a2-corner-anchorage-method-explicit-required', {
      method: gate.method || null,
    });
  }
  if (gate.method === CornerJointAnchorageMethod.U_SHAPE_ANCHORAGE) {
    return unresolved('appendix-a2-u-shape-bar-pairing-contract-unresolved', {
      method: gate.method,
      sourceBoundary:
        'Appendix A2 names U-shape anchorage but does not uniquely define individual top/bottom bar pairing',
    });
  }
  if (gate.method !== CornerJointAnchorageMethod.ENCLOSING_ANCHORAGE) {
    return unresolved(`appendix-a2-corner-anchorage-method-unsupported:${gate.method}`, {
      method: gate.method,
    });
  }
  if (end.projectionResolved === false || !Number.isFinite(Number(end.bendFromBeamEndMm))) {
    return unresolved('appendix-a2-enclosing-anchorage-support-projection-unresolved', {
      method: gate.method,
      unresolvedReasons: end.unresolvedReasons || [],
    });
  }

  const paths = [];
  const failed = [];
  for (const [barIndex, bar] of (end.bars || []).entries()) {
    if (bar?.anchorageMode !== undefined && !['L2H', 'L2_FALLBACK'].includes(bar.anchorageMode)) {
      failed.push({
        barIndex,
        role: bar?.role || null,
        dia: bar?.dia || null,
        reason: `appendix-a2-enclosing-anchorage-hard-constraint-not-ready:${bar?.anchorageMode || 'UNRESOLVED'}`,
      });
      continue;
    }
    const built = buildAppendixA2EnclosingAnchorageBarPath({ end, bar, barIndex });
    if (built.ok) paths.push(built.path);
    else
      failed.push({
        barIndex,
        role: bar?.role || null,
        dia: bar?.dia || null,
        reason: built.reason,
      });
  }
  if (!paths.length || failed.length > 0) {
    return unresolved(failed[0]?.reason || 'appendix-a2-enclosing-anchorage-bars-unresolved', {
      method: gate.method,
      failedBars: failed,
      generatedPathCount: paths.length,
    });
  }

  return {
    resolved: true,
    status: 'CENTERLINE_READY',
    generationStatus: 'CENTERLINE_READY',
    productionPathCandidate: true,
    productionConsumer: 'appendix-a2-corner-anchor-local-path',
    reason: null,
    method: gate.method,
    paths,
    unresolved: [],
    source: 'RC_DETAILING_GUIDE_2010_APPENDIX_A2',
    sourceFigure: 'A2-5',
    hookInsideDiameterFactor: INSIDE_DIAMETER_FACTOR,
    appliedRules: [A2_ANCHORAGE_RULE, A2_HOOK_RULE],
  };
}
