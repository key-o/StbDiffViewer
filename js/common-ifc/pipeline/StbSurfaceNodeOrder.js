/**
 * ST-Bridge 2.1 StbNodeIdOrder is a required positive-integer list with
 * xs:minLength=3. Reject unknown polygon topology instead of publishing an
 * invalid or fabricated one-node slab/wall.
 */
export function serializeSurfaceNodeOrder(element) {
  const kind = element?.stbType || 'STB surface';
  const id = element?.id ?? '(unknown)';
  const nodeIds = element?.nodeIds;
  if (!Array.isArray(nodeIds) || nodeIds.length < 3) {
    throw new Error(`${kind} ${id}: StbNodeIdOrder requires at least 3 measured nodes`);
  }
  const tokens = nodeIds.map((value) => {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`${kind} ${id}: invalid positive node ID`);
    }
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new Error(`${kind} ${id}: invalid positive node ID`);
    }
    const token = String(value).trim();
    if (!/^[+]?[0-9]+$/.test(token) || BigInt(token) === 0n) {
      throw new Error(`${kind} ${id}: invalid positive node ID`);
    }
    return token;
  });
  if (new Set(tokens.map((value) => BigInt(value).toString())).size < 3) {
    throw new Error(`${kind} ${id}: StbNodeIdOrder requires 3 distinct measured nodes`);
  }
  // Preserve input order and lexical node IDs; do not add or infer corners.
  return tokens.join(' ');
}

/**
 * Cross-check every referenced surface node against the measured StbNodes.
 * IDs with leading zeros or a leading plus have the same XSD integer identity.
 * Call after validateStbNodeRecords has validated and de-duplicated nodes.
 */
export function validateSurfaceNodeReferences(nodes, elements) {
  const known = new Set(nodes.map((node) => BigInt(String(node.id).trim()).toString()));
  for (const element of elements) {
    if (element.stbType !== 'StbSlab' && element.stbType !== 'StbWall') continue;
    const order = serializeSurfaceNodeOrder(element);
    for (const token of order.split(' ')) {
      if (!known.has(BigInt(token).toString())) {
        throw new Error(
          `${element.stbType} ${element.id}: StbNodeIdOrder references missing node ${token}`,
        );
      }
    }
  }
}
