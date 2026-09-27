/**
 * @fileoverview 日建連・JSCA 2023標準図 §6-3 の段差DをST-Bridge実geometryから解決する。
 *
 * 図6-3の寸法線は、追加D16筋の上側定着L2・取合い部高さD・下側定着L2hを
 * 鉛直に連続して示している。このためDは「基礎天端から基礎梁下端まで」の鉛直差として扱う。
 * StbFootingの下端基準レベル + RC基礎断面厚 + 上ふかしと、基礎梁端の
 * 節点Z + member offset_Z + section vertical_offset - beam depthを比較する。
 *
 * このmoduleは鉛直geometryだけを解決する。平面内の取合い範囲や追加筋RebarPathは後段責務。
 */

import { findElementById } from '../columnSupportUtils.js';

const SOURCE = 'R13-foundation-beam-foundation-step-geometry-2023';
const CONSTANT_DEPTH_FOOTING_SHAPES = new Set([
  'StbSecFoundation_RC_Rect',
  'StbSecFoundation_RC_Triangle',
  'StbSecFoundation_RC_EquiTriangle',
  'StbSecFoundation_RC_Octagon',
]);

function outcome(status, reason, extra = {}) {
  return {
    status,
    resolved: status === 'READY',
    reason: reason || null,
    blockers: reason ? [reason] : [],
    source: SOURCE,
    geometryReady: status === 'READY',
    productionReady: false,
    ...extra,
  };
}

function ready(extra = {}) {
  return outcome('READY', null, extra);
}

function unresolved(reason, extra = {}) {
  return outcome('UNRESOLVED', reason, extra);
}

function invalid(reason, extra = {}) {
  return outcome('INVALID', reason, extra);
}

function finiteAttribute(element, name, fallback = null) {
  if (!element?.hasAttribute?.(name)) return fallback;
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : null;
}

function elementChildren(element, tagName) {
  return Array.from(element?.childNodes || []).filter(
    (child) =>
      child?.nodeType === 1 && (!tagName || (child.localName || child.tagName) === tagName),
  );
}

function firstElementChild(element) {
  return elementChildren(element)[0] || null;
}

function resolveBeamEndSection(scanTag, beamEl, side, index = null) {
  const sectionId = beamEl?.getAttribute?.('id_section');
  if (!sectionId) return unresolved('foundation-interaction-beam-section-id-missing');
  const section = findElementById(scanTag, 'StbSecBeam_RC', sectionId, index);
  if (!section)
    return unresolved('foundation-interaction-rc-beam-section-not-found', { sectionId });

  const figures = elementChildren(section, 'StbSecFigureBeam_RC')
    .map((figure) => ({ figure, order: Number(figure.getAttribute('order')) }))
    .filter((entry) => Number.isFinite(entry.order))
    .sort((left, right) => left.order - right.order);
  if (!figures.length)
    return unresolved('foundation-interaction-beam-figure-unresolved', { sectionId });

  const figure = side === 'end' ? figures[figures.length - 1].figure : figures[0].figure;
  const shape = firstElementChild(figure);
  const shapeName = shape?.localName || shape?.tagName || null;
  if (shapeName === 'StbSecBeamStraight') {
    const widthMm = finiteAttribute(shape, 'width');
    const depthMm = finiteAttribute(shape, 'depth');
    const verticalOffsetMm = finiteAttribute(shape, 'vertical_offset', 0);
    if (!(widthMm > 0) || !(depthMm > 0) || verticalOffsetMm === null) {
      return invalid('foundation-interaction-beam-end-shape-invalid', { sectionId, shapeName });
    }
    return ready({ sectionId, shapeName, widthMm, depthMm, verticalOffsetMm });
  }
  if (shapeName === 'StbSecBeamTaper') {
    const prefix = side === 'end' ? 'end' : 'start';
    const widthMm = finiteAttribute(shape, `${prefix}_width`);
    const depthMm = finiteAttribute(shape, `${prefix}_depth`);
    const verticalOffsetMm = finiteAttribute(shape, `${prefix}_vertical_offset`, 0);
    if (!(widthMm > 0) || !(depthMm > 0) || verticalOffsetMm === null) {
      return invalid('foundation-interaction-beam-end-shape-invalid', {
        sectionId,
        shapeName,
        prefix,
      });
    }
    return ready({ sectionId, shapeName, widthMm, depthMm, verticalOffsetMm, prefix });
  }
  return unresolved('foundation-interaction-beam-end-shape-unsupported', { sectionId, shapeName });
}

function resolveBeamVerticalExtent(scanTag, beamEl, endFact, index = null) {
  const side = endFact?.side;
  if (!['start', 'end'].includes(side)) {
    return invalid('foundation-interaction-end-side-invalid', { side: side ?? null });
  }
  const nodeZ = Number(endFact?.node?.Z);
  if (!Number.isFinite(nodeZ)) {
    return unresolved('foundation-interaction-end-node-elevation-unresolved', {
      nodeId: endFact?.nodeId || null,
    });
  }
  const offsetAttr = side === 'end' ? 'offset_end_Z' : 'offset_start_Z';
  const memberOffsetZ = finiteAttribute(beamEl, offsetAttr, 0);
  if (memberOffsetZ === null) {
    return invalid('foundation-interaction-beam-offset-z-invalid', { side, offsetAttr });
  }
  const section = resolveBeamEndSection(scanTag, beamEl, side, index);
  if (section.status !== 'READY') return section;
  const referenceZ = nodeZ + memberOffsetZ;
  const beamTopZ = referenceZ + section.verticalOffsetMm;
  const beamBottomZ = beamTopZ - section.depthMm;
  return ready({
    side,
    nodeId: endFact.nodeId || null,
    referenceZ,
    beamTopZ,
    beamBottomZ,
    beamWidthMm: section.widthMm,
    beamDepthMm: section.depthMm,
    beamSectionId: section.sectionId,
    beamShapeName: section.shapeName,
    beamVerticalOffsetMm: section.verticalOffsetMm,
    memberOffsetZ,
  });
}

function resolveFootingConstantDepth(scanTag, footingEl, index = null) {
  const sectionId = footingEl?.getAttribute?.('id_section');
  if (!sectionId) return unresolved('foundation-interaction-footing-section-id-missing');
  const section = findElementById(scanTag, 'StbSecFoundation_RC', sectionId, index);
  if (!section)
    return unresolved('foundation-interaction-footing-section-not-found', { sectionId });
  const figure = section.getElementsByTagName?.('StbSecFigureFoundation_RC')?.[0] || null;
  const shape = firstElementChild(figure);
  const shapeName = shape?.localName || shape?.tagName || null;
  if (!CONSTANT_DEPTH_FOOTING_SHAPES.has(shapeName)) {
    return unresolved('foundation-interaction-footing-top-profile-not-constant', {
      sectionId,
      shapeName,
    });
  }
  const depthMm = finiteAttribute(shape, 'depth');
  if (!(depthMm > 0)) {
    return invalid('foundation-interaction-footing-depth-invalid', { sectionId, shapeName });
  }
  return ready({ sectionId, shapeName, depthMm });
}

function resolveFootingTopElevation(scanTag, endFact, index = null) {
  const footingFact = endFact?.footing;
  if (!footingFact?.id) {
    return unresolved('foundation-interaction-footing-context-unresolved', {
      nodeId: endFact?.nodeId || null,
    });
  }
  const footingEl = findElementById(scanTag, 'StbFooting', footingFact.id, index);
  if (!footingEl) {
    return unresolved('foundation-interaction-footing-element-not-found', {
      footingId: footingFact.id,
    });
  }
  const nodeId = String(footingEl.getAttribute('id_node') || '');
  if (!nodeId || nodeId !== String(endFact?.nodeId || '')) {
    return invalid('foundation-interaction-footing-node-mismatch', {
      footingId: footingFact.id,
      footingNodeId: nodeId || null,
      beamEndNodeId: endFact?.nodeId || null,
    });
  }
  const nodeZ = Number(endFact?.node?.Z);
  if (!Number.isFinite(nodeZ)) {
    return unresolved('foundation-interaction-footing-node-elevation-unresolved', {
      footingId: footingFact.id,
      nodeId,
    });
  }
  const section = resolveFootingConstantDepth(scanTag, footingEl, index);
  if (section.status !== 'READY') return section;
  const levelBottomMm = finiteAttribute(footingEl, 'level_bottom', 0);
  const thicknessAddTopMm = finiteAttribute(footingEl, 'thickness_add_top', 0);
  if (levelBottomMm === null || thicknessAddTopMm === null || thicknessAddTopMm < 0) {
    return invalid('foundation-interaction-footing-vertical-attribute-invalid', {
      footingId: footingFact.id,
      levelBottomMm,
      thicknessAddTopMm,
    });
  }
  const footingBottomReferenceZ = nodeZ + levelBottomMm;
  const footingTopZ = footingBottomReferenceZ + section.depthMm + thicknessAddTopMm;
  return ready({
    footingId: String(footingFact.id),
    footingSectionId: section.sectionId,
    footingShapeName: section.shapeName,
    footingDepthMm: section.depthMm,
    levelBottomMm,
    thicknessAddTopMm,
    footingBottomReferenceZ,
    footingTopZ,
  });
}

/**
 * §6-3 図6-3のDを解決する。
 * D = 基礎梁下端Z - 基礎天端Z。D<=0は図6-3の適用範囲外としてfail-closed。
 */
export function resolveFoundationBeamFoundationStepGeometry2023({
  scanTag,
  beamEl,
  endFact,
  index = null,
} = {}) {
  if (typeof scanTag !== 'function') return invalid('foundation-interaction-scan-tag-missing');
  if (!beamEl) return unresolved('foundation-interaction-beam-element-missing');
  if (!endFact?.resolved) {
    return unresolved('foundation-interaction-end-topology-unresolved', {
      reasons: [...(endFact?.reasons || [])],
    });
  }

  const beam = resolveBeamVerticalExtent(scanTag, beamEl, endFact, index);
  if (beam.status !== 'READY') return beam;
  const footing = resolveFootingTopElevation(scanTag, endFact, index);
  if (footing.status !== 'READY') return footing;

  const stepHeightMm = beam.beamBottomZ - footing.footingTopZ;
  const common = {
    side: endFact.side,
    nodeId: endFact.nodeId || null,
    stepHeightMm,
    beamTopZ: beam.beamTopZ,
    beamBottomZ: beam.beamBottomZ,
    footingTopZ: footing.footingTopZ,
    beamWidthMm: beam.beamWidthMm,
    beamDepthMm: beam.beamDepthMm,
    beamSectionId: beam.beamSectionId,
    footingId: footing.footingId,
    footingSectionId: footing.footingSectionId,
    footingDepthMm: footing.footingDepthMm,
    footingThicknessAddTopMm: footing.thicknessAddTopMm,
    footingLevelBottomMm: footing.levelBottomMm,
    basis: 'FIG_6_3_D_EQUALS_FOUNDATION_BEAM_BOTTOM_MINUS_FOOTING_TOP',
    planInteractionResolved: false,
  };
  if (!(stepHeightMm > 0)) {
    return unresolved('foundation-interaction-step-height-nonpositive', common);
  }
  return ready(common);
}

export const _foundationBeamFoundationStepGeometry2023Internals = Object.freeze({
  resolveBeamEndSection,
  resolveBeamVerticalExtent,
  resolveFootingConstantDepth,
  resolveFootingTopElevation,
});
