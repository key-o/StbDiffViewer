/** Coordinates used by the CAD edit property controls are semantic Working Document values. */
import { getSemanticGripsForSelections } from '../../../app/editing/semanticGripProvider.js';

export function cadNodePosition(document, nodeMap, nodeId) {
  if (!document || nodeId === null || nodeId === undefined || String(nodeId) === '') return null;
  const grip = getSemanticGripsForSelections(
    document,
    [{ elementType: 'Node', elementId: String(nodeId) }],
    { nodeMap },
  )[0];
  if (!grip) return null;
  const { x, y, z } = grip.position;
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

export function cadAbsoluteNodeMove(nodeId, currentPosition, inputs) {
  if (nodeId === null || nodeId === undefined || String(nodeId) === '' || !currentPosition)
    throw new Error('節点を選択してください。');
  const position = {};
  for (const axis of ['x', 'y', 'z']) {
    const raw = inputs?.[axis];
    if (raw === null || raw === undefined || String(raw).trim() === '')
      throw new Error(`${axis.toUpperCase()}座標を入力してください。`);
    const value = Number(raw);
    if (!Number.isFinite(value))
      throw new Error(`${axis.toUpperCase()}座標は有限の数値で入力してください。`);
    position[axis] = value;
  }
  return {
    changed: ['x', 'y', 'z'].some((axis) => position[axis] !== currentPosition[axis]),
    moves: [{ nodeId: String(nodeId), position }],
  };
}
