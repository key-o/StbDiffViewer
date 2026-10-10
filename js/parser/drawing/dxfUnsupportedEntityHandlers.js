/** @fileoverview Keep entities skipped by dxf-parser available for reference diagnostics. */

// Built-in handlers in the locked dxf-parser 1.1.2. Never replace their geometry parsing.
const PARSED_TYPES = new Set([
  '3DFACE',
  'ARC',
  'ATTDEF',
  'CIRCLE',
  'DIMENSION',
  'ELLIPSE',
  'INSERT',
  'LINE',
  'LWPOLYLINE',
  'MTEXT',
  'POINT',
  'POLYLINE',
  'SOLID',
  'SPLINE',
  'TEXT',
]);
const STRUCTURAL_RECORDS = new Set([
  'SECTION',
  'ENDSEC',
  'EOF',
  'TABLE',
  'ENDTAB',
  'BLOCK',
  'ENDBLK',
  'VERTEX',
  'SEQEND',
]);

function unsupportedHandler(type) {
  return class {
    constructor() {
      this.ForEntityName = type;
    }

    parseEntity(scanner, first) {
      const entity = { type: first.value };
      let group = scanner.next();
      while (!scanner.isEOF() && group.code !== 0) {
        if (group.code === 5) entity.handle = group.value;
        else if (group.code === 8) entity.layer = group.value;
        else if (group.code === 67) entity.inPaperSpace = group.value !== 0;
        group = scanner.next();
      }
      return entity;
    }
  };
}

/** Register via the parser's public extension API; the scanner owns entity order and BLOCKs. */
export function dxfUnsupportedEntityHandlers(content) {
  const lines = content.split(/\r\n|\r|\n/g);
  const types = new Set();
  for (let index = 0; index + 1 < lines.length; index += 2) {
    if (lines[index].trim() !== '0') continue;
    const type = lines[index + 1].trim();
    if (
      /^[A-Z][A-Z0-9_]*$/.test(type) &&
      !PARSED_TYPES.has(type) &&
      !STRUCTURAL_RECORDS.has(type)
    ) {
      types.add(type);
    }
  }
  return [...types].map(unsupportedHandler);
}
