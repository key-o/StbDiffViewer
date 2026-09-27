/**
 * @fileoverview Phase 6 CAD 操作を Working Document の semantic Command へ集約する。
 *
 * UI ごとに mutation を持たせず、数値 MOVE / 2点 ALIGN / 軸 ALIGN / COPY / Grip commit を
 * EditingSession の共通 Command 契約へ正規化する。MOVE は Working Session の設定に応じて
 * semantic Node 移動または member offset 平行移動へ解決し、COPY は AddElementCommand の
 * composite transaction を使用する。section edit は既存の専用 semantic Command を引き続き使用する。
 */

import { createCopyElementsService } from './copyElementsService.js';
import editingSession from './editingSession.js';
import { createMoveNodeCommand } from './moveNodeCommand.js';
import { getSemanticGripsForSelections } from './semanticGripProvider.js';
import { createTranslateMemberCommand } from './translateMemberCommand.js';

const AXIS_KEYS = Object.freeze({ X: 'x', Y: 'y', Z: 'z' });

function toFiniteNumber(value, label) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    throw new Error(`${label}は有限値で指定してください。`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}は有限値で指定してください。`);
  return number;
}

function normalizePoint(point, label = '座標') {
  if (!point || typeof point !== 'object') throw new Error(`${label}が指定されていません。`);
  return {
    x: toFiniteNumber(point.x, `${label}.x`),
    y: toFiniteNumber(point.y, `${label}.y`),
    z: toFiniteNumber(point.z, `${label}.z`),
  };
}

function normalizeVector(vector) {
  return normalizePoint(vector, '移動量');
}

const NODE_FIXED_MEMBER_TYPES = new Set([
  'Column',
  'Post',
  'Girder',
  'Beam',
  'Brace',
  'Slab',
  'Wall',
  'ShearWall',
]);

function normalizeSelections(selections) {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new Error('MOVE には1件以上の semantic selection が必要です。');
  }

  const result = [];
  const seen = new Set();
  for (const selection of selections) {
    const elementType = String(selection?.elementType ?? '').trim();
    const elementId = String(selection?.elementId ?? '').trim();
    if (!elementType || !elementId) {
      throw new Error('MOVE の semantic selection に elementType / elementId が必要です。');
    }
    if (['B', 'onlyB'].includes(selection?.modelSource)) {
      throw new Error('Model B を含む選択は MOVE 編集できません。');
    }
    const key = `${elementType}:${elementId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...selection, elementType, elementId });
  }
  return result;
}

function resolveSelectionNodeIds(session, selections) {
  const document = session?.getWorkingDocument?.();
  if (!document) throw new Error('Working Document を取得できません。');
  const nodeMap = session?.getWorkingNodeMap?.();
  const nodeIds = [];
  const seen = new Set();
  for (const grip of getSemanticGripsForSelections(document, selections, { nodeMap })) {
    if (grip?.behavior !== 'moveNode' || grip?.target?.elementType !== 'Node') continue;
    const nodeId = String(grip.target.elementId ?? '').trim();
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    nodeIds.push(nodeId);
  }
  if (nodeIds.length === 0) {
    throw new Error('選択要素には移動可能な semantic Node がありません。');
  }
  return nodeIds;
}

function shouldFollowRelatedNodes(session, options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'followRelatedNodes')) {
    return options.followRelatedNodes !== false;
  }
  if (typeof session?.getMoveFollowRelatedNodes === 'function') {
    return session.getMoveFollowRelatedNodes() !== false;
  }
  return session?.getState?.()?.moveFollowRelatedNodes !== false;
}

function normalizeNodeIds(nodeIds) {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
    throw new Error('CAD 操作には1件以上の Node ID が必要です。');
  }

  const result = [];
  const seen = new Set();
  for (const nodeId of nodeIds) {
    const normalized = String(nodeId ?? '').trim();
    if (!normalized) throw new Error('CAD 操作の Node ID が空です。');
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function resolveNodeMapEntry(nodeMap, nodeId) {
  if (!(nodeMap instanceof Map)) return null;
  const targetId = String(nodeId);
  if (nodeMap.has(targetId)) return nodeMap.get(targetId);
  for (const [key, value] of nodeMap.entries()) {
    if (String(key) === targetId) return value;
  }
  return null;
}

function findNode(document, nodeId) {
  const targetId = String(nodeId);
  for (const node of document?.getElementsByTagName?.('StbNode') || []) {
    if (String(node.getAttribute('id')) === targetId) return node;
  }
  return null;
}

function readNodePosition(session, nodeId) {
  const fromMap = resolveNodeMapEntry(session?.getWorkingNodeMap?.(), nodeId);
  if (fromMap && typeof fromMap === 'object') {
    const position = {
      x: Number(fromMap.x),
      y: Number(fromMap.y),
      z: Number(fromMap.z),
    };
    if (Object.values(position).every(Number.isFinite)) return position;
  }

  const node = findNode(session?.getWorkingDocument?.(), nodeId);
  if (!node) throw new Error(`Node ${nodeId} が Working Document に見つかりません。`);
  return {
    x: toFiniteNumber(node.getAttribute('X'), `Node ${nodeId}.X`),
    y: toFiniteNumber(node.getAttribute('Y'), `Node ${nodeId}.Y`),
    z: toFiniteNumber(node.getAttribute('Z'), `Node ${nodeId}.Z`),
  };
}

function normalizeMoves(moves) {
  if (!Array.isArray(moves) || moves.length === 0) {
    throw new Error('MOVE には1件以上の移動先が必要です。');
  }

  const seen = new Set();
  return moves.map((move) => {
    const nodeId = String(move?.nodeId ?? '').trim();
    if (!nodeId) throw new Error('MOVE の nodeId が空です。');
    if (seen.has(nodeId)) throw new Error(`同一 MOVE 内で Node ${nodeId} を複数回指定できません。`);
    seen.add(nodeId);
    return {
      nodeId,
      position: normalizePoint(move?.position, `Node ${nodeId} の移動先`),
    };
  });
}

function executeMoves(session, moves, options = {}) {
  const normalized = normalizeMoves(moves);

  if (typeof session?.moveNodes === 'function') {
    return session.moveNodes(normalized, {
      label: options.label,
      reason: options.reason,
      validate: options.validate,
    });
  }

  // Phase 2 の単一 Node mock / 互換 adapter でも Grip 経路を検証できるようにする。
  // production EditingSession は moveNodes() を持つため、複数 Node は常に transaction となる。
  if (normalized.length === 1 && typeof session?.moveNode === 'function') {
    return session.moveNode(normalized[0].nodeId, normalized[0].position);
  }

  throw new Error('EditingSession.moveNodes() が利用できません。');
}

function axisKey(axis) {
  const normalized = String(axis || '')
    .trim()
    .toUpperCase();
  const key = AXIS_KEYS[normalized];
  if (!key) throw new Error(`ALIGN 軸は X / Y / Z のいずれかで指定してください: ${axis}`);
  return { axis: normalized, key };
}

/**
 * Working Document の CAD 操作を共通 Command 基盤へ載せる service を生成する。
 * @param {object} session EditingSession compatible object
 * @param {{copyService?:object,guidFactory?:()=>string}} dependencies
 */
export function createCadOperationService(session = editingSession, dependencies = {}) {
  const copyService =
    dependencies.copyService ||
    createCopyElementsService(session, {
      guidFactory: dependencies.guidFactory,
    });

  const moveNodesToPositions = (moves, options = {}) => {
    const normalized = normalizeMoves(moves);
    return executeMoves(session, normalized, {
      ...options,
      label: options.label || `MOVE Node ${normalized.length}件`,
      reason: options.reason || 'cadMove',
    });
  };

  const moveNodesByVector = (nodeIds, vector, options = {}) => {
    const ids = normalizeNodeIds(nodeIds);
    const delta = normalizeVector(vector);
    const moves = ids.map((nodeId) => {
      const position = readNodePosition(session, nodeId);
      return {
        nodeId,
        position: {
          x: position.x + delta.x,
          y: position.y + delta.y,
          z: position.z + delta.z,
        },
      };
    });
    return executeMoves(session, moves, {
      ...options,
      label: options.label || `MOVE Node ${ids.length}件`,
      reason: options.reason || 'cadMove',
    });
  };

  const moveSelectionsByVector = (selections, vector, options = {}) => {
    const normalizedSelections = normalizeSelections(selections);
    const delta = normalizeVector(vector);
    if (delta.x === 0 && delta.y === 0 && delta.z === 0) {
      return {
        changed: false,
        revision: session?.getState?.()?.workingRevision ?? 0,
        affectedElements: [],
      };
    }

    if (shouldFollowRelatedNodes(session, options)) {
      return moveNodesByVector(resolveSelectionNodeIds(session, normalizedSelections), delta, {
        ...options,
        label: options.label || 'MOVE (関連節点を追従)',
        reason: options.reason || 'cadMove',
      });
    }

    const document = session?.getWorkingDocument?.();
    if (!document) throw new Error('Working Document を取得できません。');
    if (typeof session?.runTransaction !== 'function') {
      throw new Error('EditingSession.runTransaction() が利用できません。');
    }

    const explicitNodeIds = [
      ...new Set(
        normalizedSelections
          .filter((selection) => selection.elementType === 'Node')
          .map((selection) => String(selection.elementId)),
      ),
    ];
    const movingNodeIds = new Set(explicitNodeIds);
    const commands = [];

    for (const nodeId of explicitNodeIds) {
      const position = readNodePosition(session, nodeId);
      commands.push(
        createMoveNodeCommand(document, nodeId, {
          x: position.x + delta.x,
          y: position.y + delta.y,
          z: position.z + delta.z,
        }),
      );
    }

    const seenMembers = new Set();
    for (const selection of normalizedSelections) {
      if (selection.elementType === 'Node') continue;
      if (!NODE_FIXED_MEMBER_TYPES.has(selection.elementType)) {
        throw new Error(
          `${selection.elementType} は「関連節点を追従しない」MOVE の対象ではありません。`,
        );
      }
      const memberKey =
        selection.elementType === 'ShearWall'
          ? `Wall:${selection.elementId}`
          : `${selection.elementType}:${selection.elementId}`;
      if (seenMembers.has(memberKey)) continue;
      seenMembers.add(memberKey);
      const command = createTranslateMemberCommand(
        document,
        selection.elementType,
        selection.elementId,
        delta,
        {
          movingNodeIds: [...movingNodeIds],
        },
      );
      if (command.isNoop !== true) commands.push(command);
    }

    if (commands.length === 0) {
      return {
        changed: false,
        revision: session?.getState?.()?.workingRevision ?? 0,
        affectedElements: [],
      };
    }

    return session.runTransaction(commands, {
      label: options.label || `MOVE (節点固定) ${normalizedSelections.length}要素`,
      reason: options.reason || 'cadMoveNodeFixed',
      validate: options.validate,
    });
  };

  const alignNodesByPoints = (nodeIds, sourcePoint, targetPoint, options = {}) => {
    const source = normalizePoint(sourcePoint, 'ALIGN 始点');
    const target = normalizePoint(targetPoint, 'ALIGN 終点');
    return moveNodesByVector(
      nodeIds,
      {
        x: target.x - source.x,
        y: target.y - source.y,
        z: target.z - source.z,
      },
      {
        ...options,
        label: options.label || 'ALIGN 2点',
        reason: options.reason || 'cadAlign',
      },
    );
  };

  const alignNodesToAxis = (nodeIds, axis, valueOrOptions, options = {}) => {
    const ids = normalizeNodeIds(nodeIds);
    const resolvedAxis = axisKey(axis);
    let targetValue;
    let localOptions = options;

    if (valueOrOptions && typeof valueOrOptions === 'object' && !Array.isArray(valueOrOptions)) {
      localOptions = { ...valueOrOptions, ...options };
      if (valueOrOptions.referenceNodeId !== undefined) {
        targetValue = readNodePosition(session, valueOrOptions.referenceNodeId)[resolvedAxis.key];
      } else {
        targetValue = toFiniteNumber(valueOrOptions.value, `ALIGN ${resolvedAxis.axis} 座標`);
      }
    } else {
      targetValue = toFiniteNumber(valueOrOptions, `ALIGN ${resolvedAxis.axis} 座標`);
    }

    const moves = ids.map((nodeId) => {
      const position = readNodePosition(session, nodeId);
      return {
        nodeId,
        position: { ...position, [resolvedAxis.key]: targetValue },
      };
    });
    return executeMoves(session, moves, {
      ...localOptions,
      label: localOptions.label || `ALIGN ${resolvedAxis.axis}=${targetValue}`,
      reason: localOptions.reason || 'cadAlign',
    });
  };

  const copySelectionsByVector = (selections, vector, options = {}) => {
    const delta = normalizeVector(vector);
    return copyService.copySelections(selections, delta, {
      ...options,
      reason: options.reason || 'cadCopy',
    });
  };

  return {
    moveNodesToPositions,
    moveNodesByVector,
    moveSelectionsByVector,
    alignNodesByPoints,
    alignNodesToAxis,
    copySelectionsByVector,
  };
}

const cadOperationService = createCadOperationService();
export default cadOperationService;
