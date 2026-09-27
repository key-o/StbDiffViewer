/**
 * @fileoverview Phase 6 semantic COPY core.
 *
 * COPY は Object3D / Three.js geometry を複製せず、Working Document 上の ST-Bridge 要素を
 * AddElementCommand の composite transaction として複製する。
 *
 * 初期契約:
 * - Node / Column / Post / Girder / Beam / Brace / Slab / Wall(ShearWall) を対象とする。
 * - 選択部材が参照する Node は自動的に複製し、選択要素間で共有される Node は1回だけ複製する。
 * - member -> Node 参照は新 Node ID へ remap する。
 * - source Node の StbStory / Axis に対する明示 StbNodeIdList membership を新 Node へ複製する。
 * - source member に属する Open / Penetration / Joint Arrangement は host と一緒に複製する。
 * - section / material 等、COPY 対象外の定義参照は元参照を維持する。
 * - source が guid を持つ場合は暗号学的乱数で新 GUID を発行し、GUID の重複を禁止する。
 * - StbNode.id_member は、その host member も同一 COPY に含まれる場合だけ新 member ID へ remap する。
 * - PanelZone / ConnectionArrangement のような node-attached topology は未対応のため fail-closed とする。
 */

import { createAddElementCommand } from './addElementCommand.js';
import { viewerElementTypeFromElement } from './attributeCommandUtils.js';
import editingSession from './editingSession.js';
import { createCopyNodeMembershipCommand } from './nodeMembershipCommand.js';

const MAX_STB_INTEGER = 0xffffffff;

const COPYABLE_TYPES = Object.freeze({
  Node: Object.freeze({ tagName: 'StbNode', parentPath: Object.freeze(['StbNodes']) }),
  Column: Object.freeze({
    tagName: 'StbColumn',
    parentPath: Object.freeze(['StbMembers', 'StbColumns']),
  }),
  Post: Object.freeze({
    tagName: 'StbPost',
    parentPath: Object.freeze(['StbMembers', 'StbPosts']),
  }),
  Girder: Object.freeze({
    tagName: 'StbGirder',
    parentPath: Object.freeze(['StbMembers', 'StbGirders']),
  }),
  Beam: Object.freeze({
    tagName: 'StbBeam',
    parentPath: Object.freeze(['StbMembers', 'StbBeams']),
  }),
  Brace: Object.freeze({
    tagName: 'StbBrace',
    parentPath: Object.freeze(['StbMembers', 'StbBraces']),
  }),
  Slab: Object.freeze({
    tagName: 'StbSlab',
    parentPath: Object.freeze(['StbMembers', 'StbSlabs']),
  }),
  Wall: Object.freeze({
    tagName: 'StbWall',
    parentPath: Object.freeze(['StbMembers', 'StbWalls']),
  }),
  ShearWall: Object.freeze({
    tagName: 'StbWall',
    parentPath: Object.freeze(['StbMembers', 'StbWalls']),
  }),
});

const MEMBER_KIND_BY_TAG = Object.freeze({
  StbColumn: 'COLUMN',
  StbPost: 'POST',
  StbGirder: 'GIRDER',
  StbBeam: 'BEAM',
  StbBrace: 'BRACE',
  StbSlab: 'SLAB',
  StbWall: 'WALL',
});

const MEMBER_TAG_BY_KIND = Object.freeze(
  Object.fromEntries(Object.entries(MEMBER_KIND_BY_TAG).map(([tagName, kind]) => [kind, tagName])),
);

const NODE_HOST_TAG_BY_KIND = Object.freeze({
  ON_GIRDER: 'StbGirder',
  ON_BEAM: 'StbBeam',
  ON_COLUMN: 'StbColumn',
  ON_POST: 'StbPost',
  ON_CANTI: 'StbGirder',
  ON_SLAB: 'StbSlab',
});

const HOSTED_ARRANGEMENTS = Object.freeze([
  Object.freeze({
    tagName: 'StbOpenArrangement',
    parentPath: Object.freeze(['StbMembers', 'StbOpenArrangements']),
    elementType: 'OpenArrangement',
    allowedKinds: Object.freeze(new Set(['WALL', 'SLAB'])),
    defaultKind: null,
  }),
  Object.freeze({
    tagName: 'StbPenetrationArrangement',
    parentPath: Object.freeze(['StbMembers', 'StbPenetrationArrangements']),
    elementType: 'PenetrationArrangement',
    allowedKinds: Object.freeze(new Set(['GIRDER', 'BEAM'])),
    defaultKind: 'GIRDER',
  }),
  Object.freeze({
    tagName: 'StbJointArrangement',
    parentPath: Object.freeze(['StbMembers', 'StbJointArrangements']),
    elementType: 'JointArrangement',
    allowedKinds: Object.freeze(new Set(['COLUMN', 'POST', 'GIRDER', 'BEAM', 'BRACE'])),
    defaultKind: null,
  }),
]);

const NODE_TOPOLOGY_BLOCKERS = Object.freeze([
  Object.freeze({ tagName: 'StbPanelZoneArrangement', label: 'PanelZoneArrangement' }),
  Object.freeze({ tagName: 'StbConnectionArrangement', label: 'ConnectionArrangement' }),
]);

function defaultGuidFactory() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID().replaceAll('-', '').toLowerCase();
  }
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('COPY 用 GUID を安全に生成できる crypto API がありません。');
}

function toFiniteNumber(value, label) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    throw new Error(`${label}は有限値で指定してください。`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}は有限値で指定してください。`);
  return number;
}

function normalizeVector(vector = {}) {
  return {
    x: toFiniteNumber(vector.x ?? 0, 'COPY ΔX'),
    y: toFiniteNumber(vector.y ?? 0, 'COPY ΔY'),
    z: toFiniteNumber(vector.z ?? 0, 'COPY ΔZ'),
  };
}

function normalizeKind(value) {
  const kind = String(value ?? '')
    .trim()
    .toUpperCase();
  return kind || null;
}

function selectionKey(tagName, elementId) {
  return `${tagName}:${String(elementId)}`;
}

function normalizeSelections(selections) {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new Error('COPY には1件以上の semantic selection が必要です。');
  }

  const result = [];
  const seen = new Set();
  for (const selection of selections) {
    if (
      !selection?.elementType ||
      selection.elementId === undefined ||
      selection.elementId === null
    ) {
      throw new Error('COPY 対象の semantic identity が不正です。');
    }
    if (['B', 'onlyB'].includes(selection.modelSource)) {
      throw new Error('Model B の要素は COPY できません。');
    }

    const definition = COPYABLE_TYPES[String(selection.elementType)];
    if (!definition) throw new Error(`COPY 未対応の要素種別です: ${selection.elementType}`);
    const normalized = {
      elementType: String(selection.elementType),
      elementId: String(selection.elementId),
      definition,
    };
    const key = selectionKey(definition.tagName, normalized.elementId);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function findElement(document, tagName, elementId) {
  const targetId = String(elementId);
  for (const element of document?.getElementsByTagName?.(tagName) || []) {
    if (String(element.getAttribute('id')) === targetId) return element;
  }
  return null;
}

function maxNumericId(document, tagName) {
  let max = 0;
  for (const element of document?.getElementsByTagName?.(tagName) || []) {
    const id = Number.parseInt(element.getAttribute('id'), 10);
    if (Number.isInteger(id) && id > max) max = id;
  }
  return max;
}

function allocateIdMaps(document, sourceElements) {
  const grouped = new Map();
  for (const item of sourceElements) {
    if (!grouped.has(item.tagName)) grouped.set(item.tagName, []);
    grouped.get(item.tagName).push(item);
  }

  const maps = new Map();
  for (const [tagName, items] of grouped.entries()) {
    let nextId = maxNumericId(document, tagName) + 1;
    const map = new Map();
    for (const item of items) {
      if (nextId > MAX_STB_INTEGER) {
        throw new Error(`${tagName} の COPY 用 ID が ST-Bridge integer 上限を超えます。`);
      }
      map.set(String(item.elementId), String(nextId));
      nextId += 1;
    }
    maps.set(tagName, map);
  }
  return maps;
}

function directAndDescendants(root) {
  return [root, ...Array.from(root?.getElementsByTagName?.('*') || [])];
}

function referencedNodeIds(element) {
  const result = [];
  const seen = new Set();
  const append = (value) => {
    const id = String(value ?? '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push(id);
  };

  for (const current of directAndDescendants(element)) {
    for (const attribute of Array.from(current.attributes || [])) {
      if (attribute.name === 'id_node' || attribute.name.startsWith('id_node_'))
        append(attribute.value);
    }
    if (current.tagName === 'StbNodeIdOrder') {
      for (const token of String(current.textContent || '')
        .trim()
        .split(/\s+/))
        append(token);
    }
  }
  return result;
}

function collectSourceElements(document, selections) {
  const selectedElements = [];
  const requiredNodeIds = [];
  const nodeIdSeen = new Set();
  const addNodeId = (nodeId) => {
    const normalized = String(nodeId);
    if (nodeIdSeen.has(normalized)) return;
    nodeIdSeen.add(normalized);
    requiredNodeIds.push(normalized);
  };

  for (const selection of selections) {
    const element = findElement(document, selection.definition.tagName, selection.elementId);
    if (!element) {
      throw new Error(
        `${selection.definition.tagName}#${selection.elementId} が Working Document に見つかりません。`,
      );
    }
    if (selection.definition.tagName === 'StbNode') {
      addNodeId(selection.elementId);
      continue;
    }
    selectedElements.push({ ...selection, tagName: selection.definition.tagName, element });
    for (const nodeId of referencedNodeIds(element)) addNodeId(nodeId);
  }

  const nodes = requiredNodeIds.map((nodeId) => {
    const element = findElement(document, 'StbNode', nodeId);
    if (!element) throw new Error(`COPY 元が参照する StbNode#${nodeId} が見つかりません。`);
    return {
      elementType: 'Node',
      elementId: nodeId,
      tagName: 'StbNode',
      definition: COPYABLE_TYPES.Node,
      element,
    };
  });
  return { nodes, selectedElements };
}

function selectedMemberKeySet(selectedElements) {
  return new Set(
    selectedElements.map((item) => selectionKey(item.tagName, String(item.elementId))),
  );
}

function resolveArrangementHost(arrangement, definition) {
  const hostId = String(arrangement.getAttribute('id_member') || '').trim();
  if (!hostId) {
    throw new Error(
      `${definition.tagName}#${arrangement.getAttribute('id') || '?'} に id_member がありません。`,
    );
  }
  const kind = normalizeKind(arrangement.getAttribute('kind_member')) || definition.defaultKind;
  if (!kind || !definition.allowedKinds.has(kind)) {
    throw new Error(
      `${definition.tagName}#${arrangement.getAttribute('id') || '?'} の kind_member=${kind || '(empty)'} を解釈できません。`,
    );
  }
  const hostTagName = MEMBER_TAG_BY_KIND[kind];
  if (!hostTagName) {
    throw new Error(`${definition.tagName} の host member kind=${kind} を解決できません。`);
  }
  return { hostId, hostTagName, kind };
}

function collectHostedArrangements(document, selectedElements) {
  const selectedKeys = selectedMemberKeySet(selectedElements);
  const result = [];

  for (const definition of HOSTED_ARRANGEMENTS) {
    for (const arrangement of document?.getElementsByTagName?.(definition.tagName) || []) {
      const arrangementId = String(arrangement.getAttribute('id') || '').trim();
      if (!arrangementId) {
        throw new Error(`${definition.tagName} の COPY には id 属性が必要です。`);
      }
      const host = resolveArrangementHost(arrangement, definition);
      if (!selectedKeys.has(selectionKey(host.hostTagName, host.hostId))) continue;
      result.push({
        tagName: definition.tagName,
        elementId: arrangementId,
        elementType: definition.elementType,
        definition,
        element: arrangement,
        host,
      });
    }
  }
  return result;
}

function assertNoUnsupportedNodeTopology(document, nodes) {
  const copiedNodeIds = new Set(nodes.map((item) => String(item.elementId)));
  if (copiedNodeIds.size === 0) return;

  for (const blocker of NODE_TOPOLOGY_BLOCKERS) {
    for (const arrangement of document?.getElementsByTagName?.(blocker.tagName) || []) {
      const nodeId = String(arrangement.getAttribute('id_node') || '').trim();
      if (!copiedNodeIds.has(nodeId)) continue;
      throw new Error(
        `StbNode#${nodeId} は ${blocker.label} から参照されています。Phase 6 COPY では topology の自動複製契約が未確定のため COPY できません。`,
      );
    }
  }
}

function collectUsedGuids(document) {
  const result = new Set();
  const elements = [
    document?.documentElement,
    ...Array.from(document?.getElementsByTagName?.('*') || []),
  ];
  for (const element of elements) {
    const guid = String(element?.getAttribute?.('guid') || '')
      .trim()
      .toLowerCase();
    if (guid) result.add(guid);
  }
  return result;
}

function nextUniqueGuid(guidFactory, usedGuids) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const guid = String(guidFactory()).trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(guid)) {
      throw new Error('COPY GUID factory は32桁の16進小文字文字列を返す必要があります。');
    }
    if (usedGuids.has(guid)) continue;
    usedGuids.add(guid);
    return guid;
  }
  throw new Error('COPY 用の一意な GUID を生成できませんでした。');
}

function renewGuids(root, guidFactory, usedGuids) {
  for (const element of directAndDescendants(root)) {
    if (!element.hasAttribute?.('guid')) continue;
    element.setAttribute('guid', nextUniqueGuid(guidFactory, usedGuids));
  }
}

function resolveNodeMapPosition(nodeMap, nodeId) {
  if (!(nodeMap instanceof Map)) return null;
  const targetId = String(nodeId);
  let value = nodeMap.get(targetId);
  if (value === undefined) {
    for (const [key, candidate] of nodeMap.entries()) {
      if (String(key) === targetId) {
        value = candidate;
        break;
      }
    }
  }
  if (!value || typeof value !== 'object') return null;
  const position = { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
  return Object.values(position).every(Number.isFinite) ? position : null;
}

function translateNode(node, nodeMap, vector) {
  const mapped = resolveNodeMapPosition(nodeMap, node.getAttribute('id'));
  const position = mapped || {
    x: toFiniteNumber(node.getAttribute('X'), 'StbNode.X'),
    y: toFiniteNumber(node.getAttribute('Y'), 'StbNode.Y'),
    z: toFiniteNumber(node.getAttribute('Z'), 'StbNode.Z'),
  };
  node.setAttribute('X', String(position.x + vector.x));
  node.setAttribute('Y', String(position.y + vector.y));
  node.setAttribute('Z', String(position.z + vector.z));
}

function remapNodeReferences(root, nodeIdMap) {
  for (const element of directAndDescendants(root)) {
    for (const attribute of Array.from(element.attributes || [])) {
      if (attribute.name !== 'id_node' && !attribute.name.startsWith('id_node_')) continue;
      const mapped = nodeIdMap.get(String(attribute.value));
      if (!mapped) {
        throw new Error(
          `${root.tagName}#${root.getAttribute('id') || '?'} の Node 参照 ${attribute.name}=${attribute.value} を COPY ID へ remap できません。`,
        );
      }
      element.setAttribute(attribute.name, mapped);
    }
    if (element.tagName === 'StbNodeIdOrder') {
      const ids = String(element.textContent || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      element.textContent = ids
        .map((id) => {
          const mapped = nodeIdMap.get(String(id));
          if (!mapped)
            throw new Error(`StbNodeIdOrder の Node #${id} を COPY ID へ remap できません。`);
          return mapped;
        })
        .join(' ');
    }
  }
}

function remapNodeHostReference(sourceNodeId, nodeClone, memberIdMaps) {
  const hostId = String(nodeClone.getAttribute('id_member') || '').trim();
  if (!hostId) return;
  const hostTag = NODE_HOST_TAG_BY_KIND[String(nodeClone.getAttribute('kind') || '')];
  const hostMap = hostTag ? memberIdMaps.get(hostTag) : null;
  const mappedHostId = hostMap?.get(hostId) || null;
  if (!mappedHostId) {
    throw new Error(
      `StbNode#${sourceNodeId} の id_member=${hostId} は COPY 対象 host へ remap できません。host member も同時に選択してください。`,
    );
  }
  nodeClone.setAttribute('id_member', mappedHostId);
}

function sourceViewerElementType(item) {
  return viewerElementTypeFromElement(item.element) || item.elementType;
}

function hostViewerElementType(document, hostTagName, hostId) {
  const host = findElement(document, hostTagName, hostId);
  return viewerElementTypeFromElement(host) || hostTagName.replace(/^Stb/, '');
}

function makeCopyCommands(document, nodeMap, source, idMaps, vector, guidFactory) {
  const commands = [];
  const usedGuids = collectUsedGuids(document);
  const nodeIdMap = idMaps.get('StbNode') || new Map();
  const memberIdMaps = new Map(
    Object.keys(MEMBER_KIND_BY_TAG)
      .map((tagName) => [tagName, idMaps.get(tagName)])
      .filter(([, map]) => map instanceof Map),
  );

  for (const item of source.nodes) {
    const newId = nodeIdMap.get(item.elementId);
    if (!newId) throw new Error(`StbNode#${item.elementId} の COPY ID を確保できませんでした。`);
    const clone = item.element.cloneNode(true);
    clone.setAttribute('id', newId);
    renewGuids(clone, guidFactory, usedGuids);
    translateNode(clone, nodeMap, vector);
    remapNodeHostReference(item.elementId, clone, memberIdMaps);
    commands.push(
      createAddElementCommand(document, clone, {
        parentPath: item.definition.parentPath,
        elementType: 'Node',
        affectedElements: [],
        label: `StbNode #${item.elementId} を #${newId} へ COPY`,
      }),
    );
    const membershipCommand = createCopyNodeMembershipCommand(document, item.elementId, newId);
    if (membershipCommand.isNoop !== true) commands.push(membershipCommand);
  }

  for (const item of source.selectedElements) {
    const tagIdMap = idMaps.get(item.tagName);
    const newId = tagIdMap?.get(item.elementId);
    if (!newId)
      throw new Error(`${item.tagName}#${item.elementId} の COPY ID を確保できませんでした。`);
    const clone = item.element.cloneNode(true);
    clone.setAttribute('id', newId);
    renewGuids(clone, guidFactory, usedGuids);
    remapNodeReferences(clone, nodeIdMap);
    const elementType = sourceViewerElementType(item);
    commands.push(
      createAddElementCommand(document, clone, {
        parentPath: item.definition.parentPath,
        elementType,
        affectedElements: [{ elementType, elementId: newId }],
        label: `${item.tagName} #${item.elementId} を #${newId} へ COPY`,
      }),
    );
  }

  for (const item of source.hostedArrangements) {
    const arrangementIdMap = idMaps.get(item.tagName);
    const newId = arrangementIdMap?.get(item.elementId);
    const hostIdMap = idMaps.get(item.host.hostTagName);
    const newHostId = hostIdMap?.get(item.host.hostId);
    if (!newId || !newHostId) {
      throw new Error(
        `${item.tagName}#${item.elementId} の COPY host/identity を解決できませんでした。`,
      );
    }

    const clone = item.element.cloneNode(true);
    clone.setAttribute('id', newId);
    clone.setAttribute('id_member', newHostId);
    renewGuids(clone, guidFactory, usedGuids);
    const hostElementType = hostViewerElementType(
      document,
      item.host.hostTagName,
      item.host.hostId,
    );
    commands.push(
      createAddElementCommand(document, clone, {
        parentPath: item.definition.parentPath,
        elementType: item.elementType,
        affectedElements: [{ elementType: hostElementType, elementId: newHostId }],
        label: `${item.tagName} #${item.elementId} を #${newId} へ COPY`,
      }),
    );
  }

  return commands;
}

function mappingSnapshot(idMaps) {
  const result = {};
  for (const [tagName, map] of idMaps.entries()) {
    result[tagName] = Object.fromEntries(map.entries());
  }
  return result;
}

export function createCopyElementsService(
  session = editingSession,
  { guidFactory = defaultGuidFactory } = {},
) {
  return {
    copySelections(selections, vector = { x: 0, y: 0, z: 0 }, options = {}) {
      const state = session?.getState?.();
      if (state && state.active !== true) throw new Error('COPY には Working Session が必要です。');
      const document = session?.getWorkingDocument?.();
      const nodeMap = session?.getWorkingNodeMap?.();
      if (!document) throw new Error('COPY 対象の Working Document がありません。');
      if (typeof session?.runTransaction !== 'function') {
        throw new Error('COPY には EditingSession.runTransaction() が必要です。');
      }

      const normalizedSelections = normalizeSelections(selections);
      const delta = normalizeVector(vector);
      const source = collectSourceElements(document, normalizedSelections);
      assertNoUnsupportedNodeTopology(document, source.nodes);
      source.hostedArrangements = collectHostedArrangements(document, source.selectedElements);

      const idMaps = allocateIdMaps(document, [
        ...source.nodes,
        ...source.selectedElements,
        ...source.hostedArrangements,
      ]);
      const commands = makeCopyCommands(document, nodeMap, source, idMaps, delta, guidFactory);
      if (commands.length === 0) throw new Error('COPY 対象を解決できませんでした。');

      const result = session.runTransaction(commands, {
        label: options.label || `COPY ${normalizedSelections.length}要素`,
        reason: options.reason || 'cadCopy',
        validate: options.validate,
      });
      return {
        ...result,
        copyMapping: mappingSnapshot(idMaps),
        copiedNodeCount: source.nodes.length,
        copiedElementCount: normalizedSelections.length,
        copiedArrangementCount: source.hostedArrangements.length,
      };
    },
  };
}

const copyElementsService = createCopyElementsService();
export default copyElementsService;
