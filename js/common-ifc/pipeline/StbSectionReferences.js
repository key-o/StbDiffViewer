/**
 * Verify member section references against definitions actually serialized.
 * This checks a generated, unprefixed STB 2.1 XML document, not external XML.
 * Independent full XSD validation is still required.
 */
const FAMILIES = Object.freeze({
  StbColumn: ['StbSecColumn_RC', 'StbSecColumn_S', 'StbSecColumn_SRC', 'StbSecColumn_CFT'],
  StbPost: ['StbSecColumn_RC', 'StbSecColumn_S', 'StbSecColumn_SRC', 'StbSecColumn_CFT'],
  StbGirder: ['StbSecBeam_RC', 'StbSecBeam_S', 'StbSecBeam_SRC'],
  StbBeam: ['StbSecBeam_RC', 'StbSecBeam_S', 'StbSecBeam_SRC'],
  StbBrace: ['StbSecBrace_S'],
  StbSlab: ['StbSecSlab_RC', 'StbSecSlabDeck', 'StbSecSlabPrecast', 'StbSecSlabLoad'],
  StbWall: ['StbSecWall_RC', 'StbSecWallLoad'],
  StbFooting: ['StbSecFoundation_RC'],
  StbFoundationColumn: ['StbSecFoundation_RC'],
  StbPile: ['StbSecPile_RC', 'StbSecPile_S', 'StbSecPilePrecast'],
  StbOpenArrangement: ['StbSecOpen_RC'],
});
const KINDS = Object.freeze({
  StbColumn: { RC: '_RC', S: '_S', SRC: '_SRC', CFT: '_CFT' },
  StbPost: { RC: '_RC', S: '_S', SRC: '_SRC', CFT: '_CFT' },
  StbGirder: { RC: '_RC', S: '_S', SRC: '_SRC' },
  StbBeam: { RC: '_RC', S: '_S', SRC: '_SRC' },
  StbBrace: { S: '_S' },
  StbPile: { RC: '_RC', S: '_S', PC: 'Precast' },
});
const SECTION_TAGS = new Set(Object.values(FAMILIES).flat());
function attributes(value) {
  const result = Object.create(null);
  for (const match of value.matchAll(/\b([A-Za-z_][\w:.-]*)="([^"]*)"/g))
    result[match[1]] = match[2];
  return result;
}
function numericId(value) {
  if (typeof value !== 'string' || !/^\+?\d+$/.test(value)) return null;
  const id = BigInt(value);
  return id > 0n ? id.toString() : null;
}
export function validateSerializedSectionReferences(xml) {
  if (typeof xml !== 'string') throw new TypeError('Generated STB XML must be a string');
  const defined = new Set();
  const referenced = [];
  for (const match of xml.matchAll(/<([A-Za-z_][\w:.-]*)(\s[^<>]*?)?\s*\/?>/g)) {
    const tag = match[1];
    if (!SECTION_TAGS.has(tag) && !Object.hasOwn(FAMILIES, tag)) continue;
    const attrs = attributes(match[2] || '');
    if (SECTION_TAGS.has(tag)) {
      const id = numericId(attrs.id);
      if (!id) throw new Error('Invalid serialized section ID: ' + tag);
      const key = tag + ':' + id;
      if (defined.has(key)) throw new Error('Duplicate serialized section ' + key);
      defined.add(key);
    } else referenced.push({ tag, attrs });
  }
  for (const entry of referenced) {
    const label = entry.tag + ' ' + (entry.attrs.id || '(unknown)');
    const fields =
      entry.tag === 'StbFoundationColumn'
        ? ['id_section_FD', 'id_section_WR'].filter((field) => Object.hasOwn(entry.attrs, field))
        : ['id_section'];
    for (const field of fields) {
      const id = numericId(entry.attrs[field]);
      if (!id) throw new Error(label + ': missing/invalid ' + field);
      let allowed = FAMILIES[entry.tag];
      const kind = entry.attrs.kind_structure;
      if (KINDS[entry.tag] && kind && kind !== 'UNDEFINED') {
        const suffix = KINDS[entry.tag][kind];
        allowed = suffix ? allowed.filter((tag) => tag.endsWith(suffix)) : [];
      }
      if (!allowed.length) throw new Error(label + ': unsupported kind_structure ' + kind);
      const found = allowed.filter((tag) => defined.has(tag + ':' + id));
      if (found.length !== 1) {
        throw new Error(
          label +
            ': ' +
            field +
            '=' +
            entry.attrs[field] +
            (found.length ? ' is ambiguous' : ' has no serialized compatible section'),
        );
      }
    }
  }
}
