/**
 * Private, lossless STB-origin surface metadata carried in IFC Description.
 * Not a generic IFC classification and never inferred for third-party IFC.
 */
const PREFIX = 'STBSURFACE_META:';
const SLAB_KINDS = new Set(['NORMAL', 'CANTI']);
const WALL_LAYOUTS = new Set(['ON_GIRDER', 'ON_BEAM', 'ON_SLAB']);

export function encodeSurfaceMetadata(kind, source) {
  const data = {};
  if (kind === 'slab') {
    if (SLAB_KINDS.has(source.kindSlab)) data.kindSlab = source.kindSlab;
    if (typeof source.isFoundation === 'boolean') data.isFoundation = source.isFoundation;
    if (['RC', 'DECK', 'PRECAST', 'LOAD'].includes(source.kindStructure))
      data.kindStructure = source.kindStructure;
  } else if (kind === 'wall') {
    if (WALL_LAYOUTS.has(source.kindLayout)) data.kindLayout = source.kindLayout;
    if (['RC', 'LOAD'].includes(source.kindStructure)) data.kindStructure = source.kindStructure;
  } else {
    return null;
  }
  return Object.keys(data).length ? PREFIX + JSON.stringify({ kind, ...data }) : null;
}

export function decodeSurfaceMetadata(description, expectedKind) {
  if (typeof description !== 'string' || !description.startsWith(PREFIX)) return null;
  // Ignore arbitrarily large or malformed IFC descriptions (untrusted input).
  if (description.length > 512) return null;
  try {
    const data = JSON.parse(description.slice(PREFIX.length));
    if (!data || Array.isArray(data) || data.kind !== expectedKind) return null;
    const value = {};
    if (expectedKind === 'slab') {
      if (SLAB_KINDS.has(data.kindSlab)) value.kindSlab = data.kindSlab;
      if (typeof data.isFoundation === 'boolean') value.isFoundation = data.isFoundation;
      if (['RC', 'DECK', 'PRECAST', 'LOAD'].includes(data.kindStructure))
        value.kindStructure = data.kindStructure;
    } else if (expectedKind === 'wall') {
      if (WALL_LAYOUTS.has(data.kindLayout)) value.kindLayout = data.kindLayout;
      if (['RC', 'LOAD'].includes(data.kindStructure)) value.kindStructure = data.kindStructure;
    } else return null;
    return Object.keys(value).length ? value : null;
  } catch {
    return null;
  }
}
