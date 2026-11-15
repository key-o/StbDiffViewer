/**
 * Validate ST-Bridge 2.1 node attributes before serializing XML.
 * Invalid geometry must fail closed rather than becoming zero or nonfinite text.
 */
const NODE_KINDS = new Set([
  'ON_GIRDER',
  'ON_BEAM',
  'ON_COLUMN',
  'ON_POST',
  'ON_GRID',
  'ON_CANTI',
  'ON_SLAB',
  'OTHER',
]);
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function validateStbNodeRecords(nodes) {
  if (!Array.isArray(nodes)) throw new TypeError('STB nodes must be an array');
  const ids = new Set();
  for (const [index, node] of nodes.entries()) {
    if (!node || typeof node !== 'object' || Array.isArray(node))
      throw new TypeError(`STB node at index ${index} is invalid`);
    const id = node.id == null ? '' : String(node.id).trim();
    if (!/^\+?\d+$/.test(id) || /^\+?0+$/.test(id))
      throw new Error(`Invalid positive STB node id at index ${index}: ${id}`);
    const canonical = id.replace(/^\+?0*/, '');
    if (ids.has(canonical)) throw new Error(`Duplicate STB node id: ${id}`);
    ids.add(canonical);
    for (const axis of ['x', 'y', 'z']) {
      const value = node[axis];
      if (
        (typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'string' && !DECIMAL.test(value.trim())) ||
        !Number.isFinite(Number(value))
      )
        throw new Error(`Invalid STB node ${id} coordinate ${axis}`);
    }
    if (node.kind != null && !NODE_KINDS.has(node.kind))
      throw new Error(`Invalid STB node ${id} kind: ${node.kind}`);
  }
}
