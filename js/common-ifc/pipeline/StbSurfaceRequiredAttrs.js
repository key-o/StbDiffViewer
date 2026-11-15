/**
 * Verify attributes required by ST-Bridge 2.1 before emitting a surface.
 * IFC does not necessarily carry all STB layout classifications: never
 * manufacture a default solely to satisfy the schema.
 */
const SURFACE_KINDS = {
  slab: {
    kindStructure: ['RC', 'DECK', 'PRECAST', 'LOAD'],
    kindSlab: ['NORMAL', 'CANTI'],
  },
  wall: {
    kindStructure: ['RC', 'LOAD'],
    kindLayout: ['ON_GIRDER', 'ON_BEAM', 'ON_SLAB'],
  },
};

function positiveStbId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return false;
  const token = String(value).trim();
  return /^[+]?[0-9]+$/.test(token) && BigInt(token) > 0n;
}

export function validateSurfaceRequiredAttrs(el, category) {
  const allowed = SURFACE_KINDS[category];
  if (!allowed) throw new TypeError(`Unsupported STB surface category: ${category}`);
  const tag = category === 'slab' ? 'StbSlab' : 'StbWall';
  const key = `${tag} ${el?.id ?? '(unknown)'}`;
  if (!positiveStbId(el?.id)) throw new Error(`${key}: missing or invalid id`);
  if (!positiveStbId(el?.sectionId))
    throw new Error(`${key}: missing or invalid id_section (measured section required)`);
  for (const [field, values] of Object.entries(allowed)) {
    if (!values.includes(el?.[field])) {
      const attr = {
        kindStructure: 'kind_structure',
        kindSlab: 'kind_slab',
        kindLayout: 'kind_layout',
      }[field];
      throw new Error(`${key}: missing or unsupported ${attr} (IFC source evidence required)`);
    }
  }
  if (category === 'slab' && typeof el.isFoundation !== 'boolean')
    throw new Error(`${key}: missing isFoundation (IFC source evidence required)`);
}
