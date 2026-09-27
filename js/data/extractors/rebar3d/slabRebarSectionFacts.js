/**
 * @fileoverview RCスラブ断面・配筋・節点情報をST-Bridgeから正規化する。
 *
 * @module data/extractors/rebar3d/slabRebarSectionFacts
 */

const PATTERN_TAGS = Object.freeze([
  ['STANDARD', ['StbSecBarSlab_RC_ConventionalStandard', 'StbSecBarSlab_RC_Standard']],
  ['2WAY', ['StbSecBarSlab_RC_Conventional2Way', 'StbSecBarSlab_RC_2Way']],
  ['1WAY1', ['StbSecBarSlab_RC_Conventional1Way1', 'StbSecBarSlab_RC_1Way1']],
  ['1WAY2', ['StbSecBarSlab_RC_Conventional1Way2', 'StbSecBarSlab_RC_1Way2']],
]);

function numberAttr(element, name) {
  if (!element?.hasAttribute?.(name)) return null;
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : null;
}

function firstDescendant(element, tagNames) {
  for (const tagName of tagNames) {
    const found = element?.getElementsByTagName?.(tagName)?.[0];
    if (found) return found;
  }
  return null;
}

function descendants(element, tagNames) {
  const result = [];
  for (const tagName of tagNames) {
    for (const found of Array.from(element?.getElementsByTagName?.(tagName) || [])) {
      result.push(found);
    }
  }
  return result;
}

function parseBarDiameters(raw) {
  const text = String(raw || '').toUpperCase();
  const values = [];
  const labels = [];
  for (const match of text.matchAll(/[DR](\d+(?:\.\d+)?)/g)) {
    const value = Number(match[1]);
    if (!(value > 0) || !Number.isFinite(value)) continue;
    values.push(value);
    labels.push(`${match[0][0]}${match[1]}`);
  }
  return { values, labels };
}

function parseBarElement(element) {
  const pitchMm = numberAttr(element, 'pitch');
  const diameters = parseBarDiameters(element.getAttribute('D'));
  if (!(pitchMm > 0) || diameters.values.length === 0) return null;
  return {
    pos: element.getAttribute('pos') || '',
    pitchMm,
    diametersMm: diameters.values,
    designations: diameters.labels,
    strength: element.getAttribute('strength') || null,
  };
}

function parseShape(section) {
  const straight = firstDescendant(section, [
    'StbSecSlab_RC_ConventionalStraight',
    'StbSecSlab_RC_Straight',
  ]);
  if (straight) {
    const depthMm = numberAttr(straight, 'depth');
    return depthMm > 0 ? { type: 'STRAIGHT', depthMm } : null;
  }

  const taper = firstDescendant(section, [
    'StbSecSlab_RC_ConventionalTaper',
    'StbSecSlab_RC_Taper',
  ]);
  if (taper) {
    const baseDepthMm = numberAttr(taper, 'base_depth');
    const tipDepthMm = numberAttr(taper, 'tip_depth');
    const tipOffsetMm = numberAttr(taper, 'tip_offset') || 0;
    if (baseDepthMm > 0 && tipDepthMm > 0) {
      return { type: 'TAPER', baseDepthMm, tipDepthMm, tipOffsetMm };
    }
  }

  const haunch = firstDescendant(section, [
    'StbSecSlab_RC_ConventionalHaunch',
    'StbSecSlab_RC_Haunch',
  ]);
  if (haunch) {
    const baseDepthMm = numberAttr(haunch, 'base_depth');
    const tipDepthMm = numberAttr(haunch, 'tip_depth');
    const haunchLengthMm = numberAttr(haunch, 'haunch_length');
    const tipOffsetMm = numberAttr(haunch, 'tip_offset') || 0;
    if (baseDepthMm > 0 && tipDepthMm > 0 && haunchLengthMm > 0) {
      return {
        type: 'HAUNCH',
        baseDepthMm,
        tipDepthMm,
        haunchLengthMm,
        tipOffsetMm,
      };
    }
  }

  return null;
}

function resolveApplyConditionCover(xmlDoc) {
  for (const tagName of ['StbApply_RC_Slab', 'StbSlab_RC_BarPositionApply']) {
    const element = xmlDoc?.getElementsByTagName?.(tagName)?.[0];
    const value = numberAttr(element, 'depth_cover');
    if (value >= 0) return value;
  }
  return null;
}

function parseSectionMap(xmlDoc, options = {}) {
  const result = new Map();
  const commonCoverMm = resolveApplyConditionCover(xmlDoc);
  const coverOverrideMm = Number(options.coverMm);
  const sections = Array.from(xmlDoc?.getElementsByTagName?.('StbSecSlab_RC') || []);

  for (const section of sections) {
    const id = section.getAttribute('id');
    if (!id) continue;
    const shape = parseShape(section);
    const arrangement = firstDescendant(section, [
      'StbSecBarArrangementSlab_RC_Conventional',
      'StbSecBarArrangementSlab_RC',
    ]);
    if (!shape || !arrangement) continue;

    let pattern = null;
    let rawBars = [];
    for (const [patternName, tags] of PATTERN_TAGS) {
      const found = descendants(arrangement, tags);
      if (found.length === 0) continue;
      if (pattern) {
        pattern = 'AMBIGUOUS';
        rawBars = [];
        break;
      }
      pattern = patternName;
      rawBars = found;
    }
    if (!pattern || pattern === 'AMBIGUOUS') continue;

    const explicitTop = numberAttr(arrangement, 'depth_cover_top');
    const explicitBottom = numberAttr(arrangement, 'depth_cover_bottom');
    const useOverride = Number.isFinite(coverOverrideMm) && coverOverrideMm >= 0;
    const coverTopMm = useOverride ? coverOverrideMm : (explicitTop ?? commonCoverMm);
    const coverBottomMm = useOverride ? coverOverrideMm : (explicitBottom ?? commonCoverMm);
    const bars = rawBars.map(parseBarElement).filter(Boolean);

    result.set(String(id), {
      id: String(id),
      name: section.getAttribute('name') || '',
      pattern,
      shape,
      coverTopMm,
      coverBottomMm,
      bars,
    });
  }
  return result;
}

function readNodeMap(xmlDoc) {
  const nodes = new Map();
  for (const element of Array.from(xmlDoc?.getElementsByTagName?.('StbNode') || [])) {
    const id = element.getAttribute('id');
    const x = numberAttr(element, 'X');
    const y = numberAttr(element, 'Y');
    const z = numberAttr(element, 'Z');
    if (!id || ![x, y, z].every(Number.isFinite)) continue;
    nodes.set(String(id), {
      id: String(id),
      x,
      y,
      z,
      kind: element.getAttribute('kind') || '',
    });
  }
  return nodes;
}

function getNodeIds(slabEl) {
  const order = slabEl.getElementsByTagName('StbNodeIdOrder')?.[0];
  return String(order?.textContent || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function getOffsets(slabEl) {
  const map = new Map();
  const list = slabEl.getElementsByTagName('StbSlabOffsetList')?.[0];
  for (const offset of Array.from(list?.getElementsByTagName?.('StbSlabOffset') || [])) {
    const id = offset.getAttribute('id_node');
    if (!id) continue;
    map.set(String(id), {
      x: numberAttr(offset, 'offset_X') || 0,
      y: numberAttr(offset, 'offset_Y') || 0,
      z: numberAttr(offset, 'offset_Z') || 0,
    });
  }
  return map;
}

export { numberAttr, parseBarDiameters, parseSectionMap, readNodeMap, getNodeIds, getOffsets };
