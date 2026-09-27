/**
 * @fileoverview R13 基礎大梁端部のanchor-local定着pathについて、
 * StbFoundationColumn FDの鉛直範囲内に鉄筋外面まで収まるかをfail-closedで確認する。
 *
 * ST-Bridge 2.1のFoundationColumn定義に従い、FD基準点は節点 + offset_Z、
 * length_FDは基準点から下向き正として扱う。
 *
 * このsliceは水平・無回転のRC基礎梁だけを対象とする。梁の鉛直勾配や断面rotateは、
 * anchor-local yをglobal Zへ一意に写せないためproductionへ進めない。
 */

import { findElementById } from '../columnSupportUtils.js';
import { rebarPathToLineSegments, validateRebarPath } from './rebarPath.js';

const EPS_MM = 1e-6;
const SOURCE = 'R13-foundation-beam-anchorage-vertical-containment';

function outcome(status, reason, extra = {}) {
  return {
    status,
    resolved: status === 'READY' || status === 'BLOCKED',
    satisfied: status === 'READY' ? true : status === 'BLOCKED' ? false : null,
    verticalContainmentReady: status === 'READY',
    productionReady: false,
    reason: reason || null,
    blockers: reason ? [reason] : [],
    productionBlockers:
      status === 'READY'
        ? [
            'foundation-anchorage-support-plan-cover-unresolved',
            'foundation-anchorage-member-identity-world-continuity-unresolved',
          ]
        : [],
    source: SOURCE,
    ...extra,
  };
}

function unresolved(reason, extra = {}) {
  return outcome('UNRESOLVED', reason, extra);
}

function blocked(reason, extra = {}) {
  return outcome('BLOCKED', reason, extra);
}

function invalid(reason, extra = {}) {
  return outcome('INVALID', reason, extra);
}

function ready(extra = {}) {
  return outcome('READY', null, extra);
}

function finite(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function elementChildren(element, tagName) {
  return Array.from(element?.childNodes || []).filter(
    (child) => child?.nodeType === 1 && (child.localName || child.tagName) === tagName,
  );
}

function firstElementChild(element) {
  return Array.from(element?.childNodes || []).find((child) => child?.nodeType === 1) || null;
}

function numericAttribute(element, name, fallback = 0) {
  const raw = element?.getAttribute?.(name);
  if (raw === null || raw === undefined || String(raw).trim() === '') return fallback;
  return finite(raw);
}

function normalizedZeroAngle(value) {
  if (value === null || value === undefined || String(value).trim() === '') return 0;
  const angle = finite(value);
  if (angle === null) return null;
  const normalized = ((angle % 360) + 360) % 360;
  return Math.min(normalized, Math.abs(360 - normalized)) <= 1e-9 ? 0 : normalized;
}

function resolveEndpointSectionVerticalOffset(scanTag, beamEl, side, index = null) {
  const sectionId = beamEl?.getAttribute?.('id_section');
  if (!sectionId) return unresolved('foundation-anchorage-beam-section-id-missing');
  const section = findElementById(scanTag, 'StbSecBeam_RC', sectionId, index);
  if (!section) {
    return unresolved('foundation-anchorage-rc-beam-section-not-found', { sectionId });
  }

  const figures = elementChildren(section, 'StbSecFigureBeam_RC')
    .map((figure) => ({ figure, order: Number(figure.getAttribute('order')) }))
    .filter((entry) => Number.isFinite(entry.order))
    .sort((left, right) => left.order - right.order);
  if (!figures.length) {
    return unresolved('foundation-anchorage-beam-figure-unresolved', { sectionId });
  }
  const selected = side === 'end' ? figures[figures.length - 1].figure : figures[0].figure;
  const shape = firstElementChild(selected);
  const shapeName = shape?.localName || shape?.tagName || null;
  if (shapeName === 'StbSecBeamStraight') {
    const value = numericAttribute(shape, 'vertical_offset', 0);
    return value === null
      ? invalid('foundation-anchorage-beam-vertical-offset-invalid', { sectionId })
      : ready({ sectionId, verticalOffsetMm: value, shapeName });
  }
  if (shapeName === 'StbSecBeamTaper') {
    const attribute = side === 'end' ? 'end_vertical_offset' : 'start_vertical_offset';
    const value = numericAttribute(shape, attribute, 0);
    return value === null
      ? invalid('foundation-anchorage-beam-vertical-offset-invalid', {
          sectionId,
          attribute,
        })
      : ready({ sectionId, verticalOffsetMm: value, shapeName, attribute });
  }
  return unresolved('foundation-anchorage-beam-end-shape-unsupported', {
    sectionId,
    shapeName,
  });
}

function resolveBeamReferenceElevation(scanTag, beamEl, side, index = null) {
  const startNodeId = beamEl?.getAttribute?.('id_node_start');
  const endNodeId = beamEl?.getAttribute?.('id_node_end');
  const startNode = startNodeId ? findElementById(scanTag, 'StbNode', startNodeId, index) : null;
  const endNode = endNodeId ? findElementById(scanTag, 'StbNode', endNodeId, index) : null;
  if (!startNode || !endNode) {
    return unresolved('foundation-anchorage-beam-node-unresolved', { startNodeId, endNodeId });
  }

  const startNodeZ = finite(startNode.getAttribute('Z'));
  const endNodeZ = finite(endNode.getAttribute('Z'));
  const startOffsetZ = numericAttribute(beamEl, 'offset_start_Z', 0);
  const endOffsetZ = numericAttribute(beamEl, 'offset_end_Z', 0);
  if ([startNodeZ, endNodeZ, startOffsetZ, endOffsetZ].some((value) => value === null)) {
    return invalid('foundation-anchorage-beam-elevation-input-invalid');
  }
  const startReferenceZ = startNodeZ + startOffsetZ;
  const endReferenceZ = endNodeZ + endOffsetZ;
  if (Math.abs(endReferenceZ - startReferenceZ) > EPS_MM) {
    return unresolved('foundation-anchorage-sloped-beam-unsupported', {
      startReferenceZ,
      endReferenceZ,
    });
  }

  const rotate = normalizedZeroAngle(beamEl.getAttribute('rotate'));
  if (rotate === null) return invalid('foundation-anchorage-beam-rotate-invalid');
  if (rotate !== 0) {
    return unresolved('foundation-anchorage-rotated-beam-section-unsupported', {
      rotateDeg: rotate,
    });
  }

  const sectionOffset = resolveEndpointSectionVerticalOffset(scanTag, beamEl, side, index);
  if (sectionOffset?.status !== 'READY') return sectionOffset;
  const endpointReferenceZ = side === 'end' ? endReferenceZ : startReferenceZ;
  return ready({
    startReferenceZ,
    endReferenceZ,
    endpointReferenceZ,
    beamTopZ: endpointReferenceZ + sectionOffset.verticalOffsetMm,
    sectionVerticalOffsetMm: sectionOffset.verticalOffsetMm,
    sectionShapeName: sectionOffset.shapeName,
  });
}

function pathVerticalRange(path, barV) {
  const lines = rebarPathToLineSegments(path, { maxArcAngleRad: Math.PI / 180 });
  if (!lines.length) return null;
  const values = [];
  for (const line of lines) {
    for (const point of [line.start, line.end]) {
      const y = finite(point?.y);
      if (y === null) return null;
      values.push(y - barV);
    }
  }
  return values.length ? { minDeltaZ: Math.min(...values), maxDeltaZ: Math.max(...values) } : null;
}

/**
 * FoundationColumn FD鉛直範囲と定着path候補の鉄筋外面を比較する。
 */
export function resolveFoundationBeamAnchorageVerticalContainment2023({
  scanTag,
  beamEl,
  endFact,
  bar,
  candidate,
  index = null,
} = {}) {
  if (typeof scanTag !== 'function') return invalid('foundation-anchorage-scan-tag-missing');
  if (!beamEl) return unresolved('foundation-anchorage-beam-element-missing');
  if (!['start', 'end'].includes(endFact?.side)) {
    return invalid('foundation-anchorage-end-side-invalid', { side: endFact?.side ?? null });
  }
  if (!endFact?.resolved || !endFact?.foundationColumn || !endFact?.node) {
    return unresolved('foundation-anchorage-foundation-column-context-unresolved');
  }
  if (
    candidate?.geometryReady !== true ||
    !candidate.path ||
    !validateRebarPath(candidate.path).ok
  ) {
    return unresolved(candidate?.reason || 'foundation-anchorage-path-candidate-unresolved');
  }

  const diaMm = finite(bar?.diaMm);
  const barV = finite(bar?.v);
  const centerFromTopMm = finite(bar?.centerFromTopMm);
  if (!(diaMm > 0) || barV === null || centerFromTopMm === null || centerFromTopMm < 0) {
    return unresolved('foundation-anchorage-bar-vertical-position-unresolved', {
      diaMm: diaMm > 0 ? diaMm : null,
      barV,
      centerFromTopMm,
    });
  }

  const beamElevation = resolveBeamReferenceElevation(scanTag, beamEl, endFact.side, index);
  if (beamElevation?.status !== 'READY') return beamElevation;

  const nodeZ = finite(endFact.node.Z);
  const foundationOffsetZ = finite(endFact.foundationColumn.offsetZMm ?? 0);
  const foundationLengthFdMm = finite(endFact.foundationColumn.lengthFdMm);
  if (nodeZ === null || foundationOffsetZ === null || !(foundationLengthFdMm > 0)) {
    return unresolved('foundation-anchorage-foundation-column-vertical-extent-unresolved', {
      nodeZ,
      foundationOffsetZ,
      foundationLengthFdMm,
    });
  }

  const foundationTopZ = nodeZ + foundationOffsetZ;
  const foundationBottomZ = foundationTopZ - foundationLengthFdMm;
  const barCenterAtBeamEndZ = beamElevation.beamTopZ - centerFromTopMm;
  const range = pathVerticalRange(candidate.path, barV);
  if (!range) return invalid('foundation-anchorage-path-vertical-range-invalid');

  const minCenterZ = barCenterAtBeamEndZ + range.minDeltaZ;
  const maxCenterZ = barCenterAtBeamEndZ + range.maxDeltaZ;
  const radiusMm = diaMm / 2;
  const minOuterZ = minCenterZ - radiusMm;
  const maxOuterZ = maxCenterZ + radiusMm;
  const bottomMarginMm = minOuterZ - foundationBottomZ;
  const topMarginMm = foundationTopZ - maxOuterZ;
  const satisfied = bottomMarginMm >= -EPS_MM && topMarginMm >= -EPS_MM;

  const common = {
    side: endFact.side,
    nodeId: endFact.nodeId || null,
    foundationColumnId: endFact.foundationColumn.id || null,
    foundationTopZ,
    foundationBottomZ,
    foundationLengthFdMm,
    foundationOffsetZ,
    beamTopZ: beamElevation.beamTopZ,
    beamEndpointReferenceZ: beamElevation.endpointReferenceZ,
    sectionVerticalOffsetMm: beamElevation.sectionVerticalOffsetMm,
    centerFromTopMm,
    barCenterAtBeamEndZ,
    diaMm,
    pathCenterMinZ: minCenterZ,
    pathCenterMaxZ: maxCenterZ,
    pathOuterMinZ: minOuterZ,
    pathOuterMaxZ: maxOuterZ,
    bottomMarginMm,
    topMarginMm,
    candidate,
  };

  return satisfied
    ? ready(common)
    : blocked('foundation-anchorage-foundation-column-vertical-containment-insufficient', common);
}

export const _foundationBeamAnchorageVerticalContainment2023Internals = Object.freeze({
  resolveEndpointSectionVerticalOffset,
  resolveBeamReferenceElevation,
  pathVerticalRange,
  normalizedZeroAngle,
});
