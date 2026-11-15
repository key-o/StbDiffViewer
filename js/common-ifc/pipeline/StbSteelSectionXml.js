/**
 * ST-Bridge 2.1 steel profile serialization.
 *
 * IFC geometry may omit the rolling radius / fabrication process. This serializer
 * never invents a positive radius or silently reclassifies a rolled profile as built.
 * Such incomplete source profiles remain separately flagged by XSD validation.
 */

const XSD_ORDER = [
  'StbSecRoll-H',
  'StbSecBuild-H',
  'StbSecBuild-HAssymmetric',
  'StbSecRoll-BOX',
  'StbSecBuild-BOX',
  'StbSecPipe',
  'StbSecRoll-T',
  'StbSecBuild-T',
  'StbSecRoll-C',
  'StbSecRoll-2C',
  'StbSecRoll-L',
  'StbSecRoll-2L',
  'StbSecLipC',
  'StbSecLip2C',
  'StbSecFlatBar',
  'StbSecRoundBar',
];
const INDEX = new Map(XSD_ORDER.map((name, index) => [name, index]));

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function numeric(value, label) {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n) || n <= 0)
    throw new Error(`Missing positive steel profile dimension: ${label}`);
  return String(n);
}

/**
 * Keep exact IFC dimensions; add only required categorical XSD discriminator.
 * Radius=0 remains 0 (INVALID according to XSD) until original source information
 * can distinguish missing rolling radius from a sharp-corner welded profile.
 */
export function serializeSteelSection(section) {
  if (section.sourceSteel) {
    const source = section.sourceSteel;
    if (!INDEX.has(source.tag)) throw new Error(`Unsupported source steel tag: ${source.tag}`);
    // STB 2.0 SINGLE C/L profiles become the unpaired 2.1 tags, which have no type attribute.
    const legacySingle = ['StbSecRoll-C', 'StbSecRoll-L'].includes(source.tag);
    if (legacySingle && source.attrs.type != null && source.attrs.type !== 'SINGLE')
      throw new Error(`Unsupported compound source steel layout: ${source.attrs.type}`);
    const attributes = Object.entries(source.attrs)
      .filter(([key]) => !legacySingle || key !== 'type')
      .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
      .join(' ');
    return {
      tag: source.tag,
      xml: `<${source.tag} name="${escapeAttribute(source.name)}" ${attributes}/>`,
    };
  }
  const p = section.params || {};
  const name = section.name;
  if (typeof name !== 'string' || !name.trim()) throw new Error('Steel section without name');
  let tag;
  let attributes;
  switch (section.stbType) {
    case 'H':
      tag = 'StbSecRoll-H';
      attributes = {
        type: p.type === 'SH' ? 'SH' : 'H',
        A: p.A,
        B: p.B,
        t1: p.t1,
        t2: p.t2,
        r: p.r,
      };
      break;
    case 'BOX':
      tag = 'StbSecRoll-BOX';
      attributes = {
        type: ['BCP', 'BCR', 'STKR'].includes(p.type) ? p.type : 'ELSE',
        A: p.A,
        B: p.B,
        t: p.t,
        r: p.r,
      };
      break;
    case 'PIPE':
      tag = 'StbSecPipe';
      attributes = { D: p.D, t: p.t };
      break;
    case 'CIRCLE':
      tag = 'StbSecRoundBar';
      attributes = { R: p.R ?? (p.D == null ? undefined : Number(p.D) / 2) };
      break;
    case 'FB':
      tag = 'StbSecFlatBar';
      attributes = { B: p.B, t: p.t };
      break;
    case 'L':
      tag = 'StbSecRoll-L';
      attributes = p;
      break;
    case 'T':
      tag = 'StbSecRoll-T';
      attributes = { ...p, type: p.type === 'ST' ? 'ST' : 'T' };
      break;
    case 'C':
      tag = 'StbSecRoll-C';
      attributes = p;
      break;
    default:
      throw new Error(`Unsupported STB 2.1 steel shape: ${section.stbType}`);
  }
  // Required geometric dimensions of the unambiguous profile shapes only.
  const checked = ['PIPE', 'CIRCLE', 'FB'].includes(section.stbType);
  if (checked)
    for (const [key, value] of Object.entries(attributes)) numeric(value, `${name}.${key}`);
  const attr = Object.entries(attributes)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
    .join(' ');
  return { tag, xml: `<${tag} name="${escapeAttribute(name)}" ${attr}/>` };
}

/** XSD StbSecSteel is an ordered sequence, not an unordered choice. */
export function serializeSteelSections(sections) {
  return sections.map(serializeSteelSection).sort((a, b) => INDEX.get(a.tag) - INDEX.get(b.tag));
}
