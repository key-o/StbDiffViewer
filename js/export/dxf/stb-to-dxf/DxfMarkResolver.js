/**
 * @fileoverview DXF図面用の部材符号解決
 *
 * Viewer上のラベル表示モードには依存せず、参照断面タイプのnameを優先して返す。
 */

const SECTION_MAP_KEYS = {
  Column: ['columnSections'],
  Post: ['postSections', 'columnSections'],
  Girder: ['girderSections', 'beamSections'],
  Beam: ['beamSections'],
  Brace: ['braceSections'],
  Wall: ['wallSections'],
  Slab: ['slabSections'],
  Parapet: ['parapetSections'],
  FoundationColumn: ['foundationColumnSections', 'foundationcolumnSections', 'columnSections'],
  Footing: ['footingSections'],
  StripFooting: ['footingSections'],
  Pile: ['pileSections'],
};

function getMapValue(sectionMap, sectionId) {
  if (!sectionMap || sectionId == null) return null;

  const raw = String(sectionId);
  const parsed = Number.parseInt(raw, 10);
  const candidates = Number.isNaN(parsed) ? [sectionId, raw] : [sectionId, raw, parsed];

  for (const key of candidates) {
    if (sectionMap?.has?.(key)) {
      return sectionMap.get(key);
    }
  }

  return null;
}

/**
 * DXF図面用の符号を解決する。
 *
 * 優先順位:
 * 1. mesh.userData.sectionDataOriginal.name
 * 2. sectionMaps 内の対応断面.name
 * 3. sectionId / id_section
 * 4. elementId / id
 *
 * @param {string} elementType - 要素タイプ
 * @param {Object} userData - THREE.Object3D.userData
 * @param {Object|null} sectionMaps - globalState models.sectionMaps
 * @returns {string}
 */
export function resolveDxfElementMark(elementType, userData = {}, sectionMaps = null) {
  const directName = userData.sectionDataOriginal?.name;
  if (typeof directName === 'string' && directName.trim() !== '') {
    return directName.trim();
  }

  const elementDataKey = `${String(elementType || '').toLowerCase()}Data`;
  const elementData = userData[elementDataKey] || null;
  const sectionId =
    userData.sectionId ??
    userData.id_section ??
    elementData?.id_section ??
    elementData?.idSection ??
    null;

  for (const mapKey of SECTION_MAP_KEYS[elementType] || []) {
    const sectionInfo = getMapValue(sectionMaps?.[mapKey], sectionId);
    const sectionName = sectionInfo?.name;
    if (typeof sectionName === 'string' && sectionName.trim() !== '') {
      return sectionName.trim();
    }
  }

  if (sectionId != null && String(sectionId).trim() !== '') {
    return String(sectionId);
  }

  const elementId = userData.elementId ?? userData.stbElementId ?? userData.id ?? elementData?.id;
  if (elementId != null && String(elementId).trim() !== '') {
    return String(elementId);
  }

  return elementType || '';
}

export { SECTION_MAP_KEYS };
