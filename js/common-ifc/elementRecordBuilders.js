import * as WebIFC from 'web-ifc';

/**
 * IFC 要素の解析結果から共通の STB 要素レコードを構築する。
 *
 * Node.js / ブラウザ固有の IFC API 呼び出しは呼び出し元に残し、
 * 解析済みの値だけを受け取ることで両コンバーターの挙動を揃える。
 */

/**
 * 単一節点で表現する要素レコードを構築する。
 *
 * @param {Object} params
 * @returns {Object}
 */
export function buildSimpleElementRecord({
  el,
  elementId,
  origin,
  unitFactor,
  nodeReconstructor,
  profileResult,
  storyId,
}) {
  const nodeStart = nodeReconstructor.addOrGet(
    origin.x * unitFactor,
    origin.y * unitFactor,
    origin.z * unitFactor,
  );

  return {
    id: String(elementId),
    stbType: el.stbType,
    stbCategory: el.stbCategory,
    name: el.name || `${el.stbType}-${elementId}`,
    nodeStart,
    nodeEnd: nodeStart,
    sectionId: profileResult?.sectionId || null,
    storyId,
  };
}

/**
 * IFC の押し出し矩形表現から壁寸法を抽出する。
 *
 * @param {Object} api web-ifc API
 * @param {number} modelID
 * @param {number} unitFactor IFC 単位から mm への変換係数
 * @param {number|null} representationRef
 * @returns {{ wallLength?: number, height?: number, thickness?: number }}
 */
export function extractWallDimensions(api, modelID, unitFactor, representationRef) {
  if (!representationRef) return {};
  const productShape = api.GetLine(modelID, representationRef);
  if (!productShape?.Representations) return {};

  for (const repRef of productShape.Representations) {
    const repId = repRef?.value ?? repRef;
    const rep = api.GetLine(modelID, repId);
    if (!rep?.Items) continue;

    for (const itemRef of rep.Items) {
      const itemId = itemRef?.value ?? itemRef;
      const item = api.GetLine(modelID, itemId);
      if (!item || item.type !== WebIFC.IFCEXTRUDEDAREASOLID) continue;

      const depth = item.Depth?.value ?? item.Depth ?? 0;
      const height = Math.round(depth * unitFactor * 100) / 100;
      const sweptAreaRef = item.SweptArea?.value ?? item.SweptArea;
      if (!sweptAreaRef) continue;

      const profile = api.GetLine(modelID, sweptAreaRef);
      if (!profile || profile.type !== WebIFC.IFCRECTANGLEPROFILEDEF) continue;

      const xDim = (profile.XDim?.value ?? profile.XDim ?? 0) * unitFactor;
      const yDim = (profile.YDim?.value ?? profile.YDim ?? 0) * unitFactor;
      return {
        wallLength: Math.round(xDim * 100) / 100,
        height,
        thickness: Math.round(yDim * 100) / 100,
      };
    }
  }
  return {};
}

/**
 * IFCRELVOIDSELEMENT を解析して壁IDごとの開口情報を構築する。
 *
 * @returns {Map<number, Array>}
 */
export function buildWallOpeningMap(api, modelID, unitFactor) {
  const map = new Map();
  let voidIds;
  try {
    voidIds = api.GetLineIDsWithType(modelID, WebIFC.IFCRELVOIDSELEMENT);
  } catch {
    return map;
  }

  for (let i = 0; i < voidIds.size(); i++) {
    const rel = api.GetLine(modelID, voidIds.get(i));
    if (!rel) continue;
    const wallRef = rel.RelatingBuildingElement?.value ?? rel.RelatingBuildingElement;
    const openingRef = rel.RelatedOpeningElement?.value ?? rel.RelatedOpeningElement;
    if (!wallRef || !openingRef) continue;

    const openingEl = api.GetLine(modelID, openingRef);
    const openingInfo = openingEl && extractOpeningInfo(api, modelID, unitFactor, openingEl);
    if (!openingInfo) continue;

    if (!map.has(wallRef)) map.set(wallRef, []);
    map.get(wallRef).push(openingInfo);
  }
  return map;
}

function extractOpeningInfo(api, modelID, unitFactor, openingEl) {
  const name = openingEl.Name?.value || null;
  const repRef = openingEl.Representation?.value ?? openingEl.Representation;
  if (!repRef) return null;

  const productShape = api.GetLine(modelID, repRef);
  if (!productShape?.Representations) return null;

  for (const repItemRef of productShape.Representations) {
    const repId = repItemRef?.value ?? repItemRef;
    const rep = api.GetLine(modelID, repId);
    if (!rep?.Items) continue;

    for (const itemRef of rep.Items) {
      const itemId = itemRef?.value ?? itemRef;
      const item = api.GetLine(modelID, itemId);
      if (!item || item.type !== WebIFC.IFCEXTRUDEDAREASOLID) continue;

      const depth = item.Depth?.value ?? item.Depth ?? 0;
      const openingHeight = depth * unitFactor;
      const sweptAreaRef = item.SweptArea?.value ?? item.SweptArea;
      if (!sweptAreaRef) continue;
      const profile = api.GetLine(modelID, sweptAreaRef);
      if (!profile || profile.type !== WebIFC.IFCRECTANGLEPROFILEDEF) continue;

      const openingWidth = (profile.XDim?.value ?? profile.XDim ?? 0) * unitFactor;
      const placementRef = openingEl.ObjectPlacement?.value ?? openingEl.ObjectPlacement;
      let localX = 0;
      let localZ = 0;
      if (placementRef) {
        const placement = api.GetLine(modelID, placementRef);
        const relPlacement = placement?.RelativePlacement;
        if (relPlacement) {
          const axisId = relPlacement?.value ?? relPlacement;
          const axis = api.GetLine(modelID, axisId);
          const loc = axis?.Location;
          if (loc) {
            const locId = loc?.value ?? loc;
            const point = api.GetLine(modelID, locId);
            const coords = point?.Coordinates;
            if (coords) {
              localX = (coords[0]?.value ?? coords[0] ?? 0) * unitFactor;
              localZ = (coords[2]?.value ?? coords[2] ?? 0) * unitFactor;
            }
          }
        }
      }

      return {
        name,
        localX,
        positionY: localZ,
        width: Math.round(openingWidth * 100) / 100,
        height: Math.round(openingHeight * 100) / 100,
      };
    }
  }
  return null;
}

export function parsePileMetadata(description) {
  if (typeof description !== 'string' || !description.startsWith('STBPILE_META:')) return null;
  try {
    return JSON.parse(description.slice('STBPILE_META:'.length));
  } catch {
    return null;
  }
}

export function buildPileAttrs(startPt, endPt, nodeStart, nodeEnd, length, pileMeta = null) {
  const isStartTop = startPt.z >= endPt.z;
  const elementMeta = pileMeta?.element || null;
  const lengthAll = toFiniteNumber(elementMeta?.length_all) ?? Math.round(length * 100) / 100;
  const kindPile = elementMeta?.kind_pile || 'CAST_IN_PLACE';

  if (elementMeta?.format === '1node') {
    return {
      pileFormat: '1node',
      nodeSingle: isStartTop ? nodeStart : nodeEnd,
      levelTop: toFiniteNumber(elementMeta.level_top) ?? (isStartTop ? startPt.z : endPt.z),
      lengthAll,
      offsetX: toFiniteNumber(elementMeta.offset_X) ?? 0,
      offsetY: toFiniteNumber(elementMeta.offset_Y) ?? 0,
      kindPile,
    };
  }

  return {
    pileFormat: '2node',
    nodeBottom: isStartTop ? nodeEnd : nodeStart,
    nodeTop: isStartTop ? nodeStart : nodeEnd,
    lengthAll,
    kindPile,
  };
}

export function buildPileProfileResult(profileAnalyzer, pileMeta, analyzedProfile) {
  const sectionMeta = pileMeta?.section;
  if (!sectionMeta) return analyzedProfile;

  const sectionInfo = {
    stbType: sectionMeta.stbType || analyzedProfile?.sectionInfo?.stbType || 'PILE_RC',
    name: sectionMeta.name || 'Pile',
    pileTagName: sectionMeta.pileTagName || null,
    pileType: sectionMeta.pileType || null,
    params: { ...(sectionMeta.params || {}) },
    segments: Array.isArray(sectionMeta.segments) ? [...sectionMeta.segments] : null,
    sectionKey: JSON.stringify({
      stbType: sectionMeta.stbType || 'PILE_RC',
      name: sectionMeta.name || 'Pile',
      pileTagName: sectionMeta.pileTagName || null,
      params: Object.fromEntries(
        Object.entries(sectionMeta.params || {}).sort(([a], [b]) => a.localeCompare(b)),
      ),
      segments: Array.isArray(sectionMeta.segments)
        ? sectionMeta.segments.map((segment) =>
            Object.fromEntries(
              Object.entries(segment)
                .filter(([, value]) => value !== undefined)
                .sort(([a], [b]) => a.localeCompare(b)),
            ),
          )
        : null,
    }),
  };

  const registered = profileAnalyzer.registerSection(sectionInfo);
  return {
    sectionId: registered?.id || null,
    sectionInfo: registered || sectionInfo,
    length: analyzedProfile?.length || 0,
  };
}

export function countElementsByType(elements) {
  const counts = {};
  for (const el of elements) counts[el.stbType] = (counts[el.stbType] || 0) + 1;
  return counts;
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * 壁の配置・寸法・開口情報から壁要素レコードを構築する。
 *
 * @param {Object} params
 * @returns {Object}
 */
export function buildWallElementRecord({
  el,
  elementId,
  origin,
  worldMatrix,
  unitFactor,
  dimensions,
  nodeReconstructor,
  storyId,
  wallOpenings = [],
}) {
  const { wallLength, height } = dimensions;

  if (!wallLength || !height) {
    const nodeId = nodeReconstructor.addOrGet(
      origin.x * unitFactor,
      origin.y * unitFactor,
      origin.z * unitFactor,
    );
    return {
      id: String(elementId),
      stbType: el.stbType,
      stbCategory: el.stbCategory,
      name: el.name || `${el.stbType}-${elementId}`,
      nodeIds: [nodeId],
      sectionId: null,
      storyId,
      kindStructure: el.kindStructure || 'RC',
      openings: [],
    };
  }

  const refDirX = worldMatrix[0];
  const refDirY = worldMatrix[1];
  const refLen = Math.sqrt(refDirX * refDirX + refDirY * refDirY) || 1;
  const dirX = refDirX / refLen;
  const dirY = refDirY / refLen;
  const cx = origin.x * unitFactor;
  const cy = origin.y * unitFactor;
  const cz = origin.z * unitFactor;
  const halfLen = wallLength / 2;

  const startX = cx - dirX * halfLen;
  const startY = cy - dirY * halfLen;
  const endX = cx + dirX * halfLen;
  const endY = cy + dirY * halfLen;

  const n1 = nodeReconstructor.addOrGet(startX, startY, cz);
  const n2 = nodeReconstructor.addOrGet(endX, endY, cz);
  const n3 = nodeReconstructor.addOrGet(endX, endY, cz + height);
  const n4 = nodeReconstructor.addOrGet(startX, startY, cz + height);

  const openings = wallOpenings.map((op, idx) => ({
    id: String(elementId * 1000 + idx + 1),
    name: op.name || `Opening_${elementId}_${idx + 1}`,
    wallId: String(elementId),
    positionX: Math.round((op.localX - op.width / 2 + wallLength / 2) * 100) / 100,
    positionY: Math.round(op.positionY * 100) / 100,
    width: Math.round(op.width * 100) / 100,
    height: Math.round(op.height * 100) / 100,
    rotate: 0,
  }));

  return {
    id: String(elementId),
    stbType: el.stbType,
    stbCategory: el.stbCategory,
    name: el.name || `${el.stbType}-${elementId}`,
    nodeIds: [n1, n2, n3, n4],
    sectionId: null,
    storyId,
    kindStructure: el.kindStructure || 'RC',
    openings,
  };
}
