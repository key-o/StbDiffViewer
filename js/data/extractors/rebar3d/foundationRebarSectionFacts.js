/**
 * @fileoverview RC独立基礎の断面・配筋・省略時かぶりをST-Bridgeから正規化する。
 *
 * R13では矩形・八角形のRect配筋、直角三角形のTriangle配筋、正三角形のThreeWay配筋を段階対応する。
 * 連続基礎は情報を保持したまま placement 側で fail-closed とする。
 *
 * @module data/extractors/rebar3d/foundationRebarSectionFacts
 */

export function numberAttr(element, name) {
  if (!element?.hasAttribute?.(name)) return null;
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : null;
}

function booleanAttr(element, name, fallback = false) {
  if (!element?.hasAttribute?.(name)) return fallback;
  return String(element.getAttribute(name)).toLowerCase() === 'true';
}

function firstDescendant(element, tagName) {
  return element?.getElementsByTagName?.(tagName)?.[0] || null;
}

export function parseBarDiameter(raw) {
  const match = String(raw || '')
    .toUpperCase()
    .match(/[DR](\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return value > 0 && Number.isFinite(value) ? value : null;
}

function resolveLegacyFoundationCover(xmlDoc) {
  const apply = firstDescendant(xmlDoc, 'StbFoundation_RC_BarPositionApply');
  if (!apply) return null;
  const setDefault = String(apply.getAttribute('set_default') || '').toLowerCase() === 'true';
  if (!setDefault) return null;
  const depthCover = numberAttr(apply, 'depth_cover');
  return depthCover >= 0 ? depthCover : null;
}

function parseShape(section) {
  const rect = firstDescendant(section, 'StbSecFoundation_RC_Rect');
  if (rect) {
    const widthXmm = numberAttr(rect, 'width_X');
    const widthYmm = numberAttr(rect, 'width_Y');
    const depthMm = numberAttr(rect, 'depth');
    if (widthXmm > 0 && widthYmm > 0 && depthMm > 0) {
      return { type: 'RECT', widthXmm, widthYmm, depthMm };
    }
    return { type: 'RECT_INVALID', widthXmm, widthYmm, depthMm };
  }

  const octagon = firstDescendant(section, 'StbSecFoundation_RC_Octagon');
  if (octagon) {
    const widthXmm = numberAttr(octagon, 'width_X');
    const widthYmm = numberAttr(octagon, 'width_Y');
    const depthMm = numberAttr(octagon, 'depth');
    const chamfers = [1, 2, 3, 4].map((index) => ({
      x: numberAttr(octagon, `width_chamfer${index}_X`),
      y: numberAttr(octagon, `width_chamfer${index}_Y`),
    }));
    const finite = [widthXmm, widthYmm, depthMm, ...chamfers.flatMap((c) => [c.x, c.y])].every(
      Number.isFinite,
    );
    const nonNegative = chamfers.every((c) => c.x >= 0 && c.y >= 0);
    const edgesValid =
      widthXmm > 0 &&
      widthYmm > 0 &&
      depthMm > 0 &&
      chamfers[0].x + chamfers[1].x <= widthXmm &&
      chamfers[3].x + chamfers[2].x <= widthXmm &&
      chamfers[0].y + chamfers[3].y <= widthYmm &&
      chamfers[1].y + chamfers[2].y <= widthYmm;
    if (finite && nonNegative && edgesValid) {
      return { type: 'OCTAGON', widthXmm, widthYmm, depthMm, chamfers };
    }
    return { type: 'OCTAGON_INVALID', widthXmm, widthYmm, depthMm, chamfers };
  }

  const triangle = firstDescendant(section, 'StbSecFoundation_RC_Triangle');
  if (triangle) {
    const widthXmm = numberAttr(triangle, 'width_X');
    const widthYmm = numberAttr(triangle, 'width_Y');
    const depthMm = numberAttr(triangle, 'depth');
    const chamferXmm = numberAttr(triangle, 'width_chamfer_X') ?? 0;
    const chamferYmm = numberAttr(triangle, 'width_chamfer_Y') ?? 0;
    const valid =
      widthXmm > 0 &&
      widthYmm > 0 &&
      depthMm > 0 &&
      chamferXmm >= 0 &&
      chamferYmm >= 0 &&
      chamferXmm < widthXmm &&
      chamferYmm < widthYmm;
    if (valid) {
      return { type: 'TRIANGLE', widthXmm, widthYmm, depthMm, chamferXmm, chamferYmm };
    }
    return {
      type: 'TRIANGLE_INVALID',
      widthXmm,
      widthYmm,
      depthMm,
      chamferXmm,
      chamferYmm,
    };
  }

  const equiTriangle = firstDescendant(section, 'StbSecFoundation_RC_EquiTriangle');
  if (equiTriangle) {
    const widthBaseMm = numberAttr(equiTriangle, 'width_base');
    const widthChamferMm = numberAttr(equiTriangle, 'width_chamfer');
    const depthMm = numberAttr(equiTriangle, 'depth');
    if (widthBaseMm > 0 && widthChamferMm >= 0 && depthMm > 0) {
      return { type: 'EQUI_TRIANGLE', widthBaseMm, widthChamferMm, depthMm };
    }
    return { type: 'EQUI_TRIANGLE_INVALID', widthBaseMm, widthChamferMm, depthMm };
  }

  const unsupportedTags = [
    ['TAPERED_RECT', 'StbSecFoundation_RC_TaperedRect'],
    ['CONTINUOUS', 'StbSecFoundation_RC_Continuous'],
  ];
  for (const [type, tagName] of unsupportedTags) {
    if (firstDescendant(section, tagName)) return { type };
  }
  return null;
}

function parseBar(element) {
  const diaMm = parseBarDiameter(element.getAttribute('D'));
  const count = numberAttr(element, 'N');
  const pos = String(element.getAttribute('pos') || '').toUpperCase();
  const hasIsVertical = element.hasAttribute('isVertical');
  const hasLengthVertical = element.hasAttribute('length_vertical');
  const isVertical = booleanAttr(element, 'isVertical', false);
  const lengthVerticalMm = numberAttr(element, 'length_vertical');
  const verticalAttributesValid =
    pos === 'HORIZONTAL'
      ? !hasIsVertical && !hasLengthVertical
      : !hasLengthVertical || (isVertical && lengthVerticalMm > 0);
  if (!(diaMm > 0) || !(count > 0) || !Number.isInteger(count) || !verticalAttributesValid) {
    return null;
  }
  return {
    pos,
    diaMm,
    designation: element.getAttribute('D') || '',
    strength: element.getAttribute('strength') || null,
    count,
    isVertical,
    lengthVerticalMm,
  };
}

export function parseFoundationSectionMap(xmlDoc) {
  const result = new Map();
  const defaultCoverMm = resolveLegacyFoundationCover(xmlDoc);

  for (const section of Array.from(xmlDoc?.getElementsByTagName?.('StbSecFoundation_RC') || [])) {
    const id = section.getAttribute('id');
    if (!id) continue;
    const shape = parseShape(section);
    const arrangement = firstDescendant(section, 'StbSecBarArrangementFoundation_RC');
    if (!shape || !arrangement) continue;

    const barGroups = [
      ['RECT', 'StbSecBarFoundation_RC_Rect'],
      ['TRIANGLE', 'StbSecBarFoundation_RC_Triangle'],
      ['THREE_WAY', 'StbSecBarFoundation_RC_ThreeWay'],
      ['CONTINUOUS', 'StbSecBarFoundation_RC_Continuous'],
    ].map(([type, tagName]) => ({
      type,
      tagName,
      elements: Array.from(arrangement.getElementsByTagName(tagName) || []),
    }));
    const presentGroups = barGroups.filter((group) => group.elements.length > 0);
    const selectedGroup = presentGroups.length === 1 ? presentGroups[0] : null;
    const parsedBars = selectedGroup?.elements.map(parseBar) || [];
    const bars = parsedBars.filter(Boolean);
    const totalBarCount = barGroups.reduce((count, group) => count + group.elements.length, 0);
    const supportedBarType =
      selectedGroup && ['RECT', 'TRIANGLE', 'THREE_WAY'].includes(selectedGroup.type);

    result.set(String(id), {
      id: String(id),
      name: section.getAttribute('name') || '',
      shape,
      barType: selectedGroup?.type || (presentGroups.length > 1 ? 'MIXED' : null),
      coverTopMm: numberAttr(arrangement, 'depth_cover_top') ?? defaultCoverMm,
      coverBottomMm: numberAttr(arrangement, 'depth_cover_bottom') ?? defaultCoverMm,
      coverSideMm: numberAttr(arrangement, 'depth_cover_side') ?? defaultCoverMm,
      bars,
      hasAnyBars: totalBarCount > 0,
      invalidBarCount: selectedGroup ? selectedGroup.elements.length - bars.length : 0,
      hasUnsupportedBarType: totalBarCount > 0 && !supportedBarType,
      hasMixedBarTypes: presentGroups.length > 1,
      hasHorizontal: bars.some((bar) => bar.pos === 'HORIZONTAL'),
    });
  }
  return result;
}

export function readFoundationNodeMap(xmlDoc) {
  const result = new Map();
  for (const node of Array.from(xmlDoc?.getElementsByTagName?.('StbNode') || [])) {
    const id = node.getAttribute('id');
    const x = numberAttr(node, 'X');
    const y = numberAttr(node, 'Y');
    const z = numberAttr(node, 'Z');
    if (!id || ![x, y, z].every(Number.isFinite)) continue;
    result.set(String(id), { x, y, z });
  }
  return result;
}
