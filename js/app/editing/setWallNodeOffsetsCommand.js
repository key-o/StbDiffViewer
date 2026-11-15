/** @fileoverview 壁のStbWallOffsetListを可逆に変更するCommand（STB 2.1.x）。 */

function tag(node) {
  return node?.localName || node?.nodeName?.split(':').pop() || '';
}

function directChild(parent, name) {
  return Array.from(parent?.children || []).find((element) => tag(element) === name) || null;
}

function createChild(document, parent, name) {
  return parent.namespaceURI
    ? document.createElementNS(parent.namespaceURI, name)
    : document.createElement(name);
}

function resolveWall(document, wallId) {
  const walls = Array.from(
    document?.getElementsByTagNameNS?.('*', 'StbWall') ||
      document?.getElementsByTagName?.('StbWall') ||
      [],
  ).filter((wall) => wall.getAttribute('id') === String(wallId));
  if (walls.length !== 1) throw new Error(`StbWall:${wallId} が一意に見つかりません`);
  return walls[0];
}

function buildAfterSnapshot(document, wall, offsets) {
  const order = directChild(wall, 'StbNodeIdOrder');
  const members = new Set(order?.textContent?.trim().split(/\s+/).filter(Boolean) || []);
  const before = directChild(wall, 'StbWallOffsetList');
  const list = before ? before.cloneNode(true) : createChild(document, wall, 'StbWallOffsetList');
  const existing = new Map();
  for (const child of Array.from(list.children || [])) {
    if (tag(child) !== 'StbWallOffset') throw new Error('未対応の壁offset子要素があります');
    const nodeId = child.getAttribute('id_node');
    if (!nodeId || existing.has(nodeId)) throw new Error('壁offset節点が不正または重複しています');
    existing.set(nodeId, child);
  }
  for (const [nodeId, values] of Object.entries(offsets)) {
    if (!members.has(nodeId))
      throw new Error(`壁${wall.getAttribute('id')}に節点${nodeId}は存在しません`);
    let child = existing.get(nodeId);
    if (!child) {
      child = createChild(document, list, 'StbWallOffset');
      child.setAttribute('id_node', nodeId);
      list.appendChild(child);
    }
    for (const axis of ['X', 'Y', 'Z']) {
      const key = `offset_${axis}`;
      const value = values?.[key];
      if (!Number.isFinite(value)) throw new Error(`StbWallOffset.${key}は有限数が必要です`);
      child.setAttribute(key, String(value));
    }
  }
  return list;
}

export function createSetWallNodeOffsetsCommand(document, wallId, offsets) {
  if (!offsets || !Object.keys(offsets).length) throw new Error('壁offset指定が空です');
  const wall = resolveWall(document, wallId);
  const before = directChild(wall, 'StbWallOffsetList')?.cloneNode(true) || null;
  const after = buildAfterSnapshot(document, wall, offsets);
  return {
    type: 'setWallNodeOffsets',
    label: `壁 ${wallId} の取り合いoffsetを変更`,
    wallId: String(wallId),
    before,
    after,
    isNoop: before?.outerHTML === after.outerHTML,
    affectedElements: [{ elementType: 'Wall', elementId: String(wallId) }],
  };
}

export function applySetWallNodeOffsetsCommand(document, _nodeMap, command, direction = 'after') {
  if (command?.type !== 'setWallNodeOffsets' || !['before', 'after'].includes(direction)) {
    throw new Error('壁offset Commandが不正です');
  }
  const wall = resolveWall(document, command.wallId);
  const current = directChild(wall, 'StbWallOffsetList');
  const snapshot = command[direction];
  if (snapshot) {
    const clone = document.importNode
      ? document.importNode(snapshot, true)
      : snapshot.cloneNode(true);
    if (current) wall.replaceChild(clone, current);
    else wall.appendChild(clone);
  } else if (current) {
    wall.removeChild(current);
  }
  return command.affectedElements;
}
