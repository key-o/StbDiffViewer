/**
 * @fileoverview Explicit, atomic STB-B -> Working STB-A Node adoption (initial slice).
 *
 * This does not merge models. Referenced members, sections, or unmapped story/axis
 * memberships must never be guessed from coordinates or same numeric IDs.
 */
import editingSession from './editingSession.js';
import { createAddElementCommand } from './addElementCommand.js';
import { collectNodeMemberships } from './nodeMembershipCommand.js';

const MAX_STB_INTEGER = 0xffffffff;
const OWNER_TAGS = new Set(['StbStory', 'StbParallelAxis', 'StbArcAxis', 'StbRadialAxis']);
const FRAME_ATTRIBUTES = [
  'global_offset_X',
  'global_offset_Y',
  'global_offset_Z',
  'global_rotation',
];

function elements(document, tagName) {
  return [...(document?.getElementsByTagName?.(tagName) || [])];
}

function findOne(document, tagName, id) {
  const matches = elements(document, tagName).filter(
    (element) => element.getAttribute('id') === String(id),
  );
  if (matches.length !== 1) throw new Error(`${tagName}#${id} を一意に解決できません。`);
  return matches[0];
}

function directChild(parent, tagName) {
  return [...(parent?.children || [])].find((element) => element.tagName === tagName) || null;
}

function assertStbDocument(document, label) {
  if (
    document?.documentElement?.tagName !== 'ST_BRIDGE' ||
    !elements(document, 'StbModel').length
  ) {
    throw new Error(`${label}は対応済みの非prefix ST-Bridge Documentでなければなりません。`);
  }
}

function frame(document) {
  const common = elements(document, 'StbCommon')[0];
  return FRAME_ATTRIBUTES.map((attr) => {
    const raw = common?.getAttribute(attr);
    const value = raw === null || raw === undefined ? 0 : Number(raw);
    if (!Number.isFinite(value)) throw new Error(`STB座標frameの${attr}が不正です。`);
    return value;
  });
}

function assertSameFrame(documentA, documentB) {
  const a = frame(documentA);
  const b = frame(documentB);
  if (a.some((value, index) => value !== b[index])) {
    throw new Error('A/BのSTBグローバル座標frameが異なります。座標変換契約が必要です。');
  }
}

function selectedNodeIds(nodeIds) {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0)
    throw new Error('BのNodeを選択してください。');
  const ids = nodeIds.map((id) => String(id ?? '').trim());
  if (ids.some((id) => !/^[1-9]\d*$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Node選択IDが不正または重複しています。');
  }
  return ids;
}

function allocateIds(document, count) {
  const ids = elements(document, 'StbNode').map((node) => node.getAttribute('id'));
  if (ids.some((id) => !/^[1-9]\d*$/.test(id))) throw new Error('AのNode IDが不正です。');
  if (new Set(ids).size !== ids.length) throw new Error('AのNode IDが重複しています。');
  const maxId = ids.reduce((max, id) => Math.max(max, Number(id)), 0);
  if (maxId + count > MAX_STB_INTEGER) throw new Error('Node IDの上限を超えます。');
  return Array.from({ length: count }, (_, index) => String(maxId + index + 1));
}

function createOwnerMappingIndex(ownerMappings) {
  if (!Array.isArray(ownerMappings)) throw new TypeError('ownerMappingsは配列です。');
  const index = new Map();
  for (const mapping of ownerMappings) {
    const source = mapping?.source;
    const target = mapping?.target;
    if (!OWNER_TAGS.has(source?.tagName) || target?.tagName !== source.tagName) {
      throw new Error('Story/Axisの対応には同種のsource/target ownerが必要です。');
    }
    const sourceId = String(source.id ?? '').trim();
    const targetId = String(target.id ?? '').trim();
    if (!sourceId || !targetId) throw new Error('Story/Axis対応のIDがありません。');
    const key = `${source.tagName}:${sourceId}`;
    if (index.has(key)) throw new Error(`重複したowner mappingです: ${key}`);
    index.set(key, { ownerTagName: target.tagName, ownerId: targetId });
  }
  return index;
}

function mappedMemberships(sourceB, targetA, nodeId, mappings) {
  const original = collectNodeMemberships(sourceB, nodeId);
  const used = new Set();
  const target = original.map(({ ownerTagName, ownerId }) => {
    const key = `${ownerTagName}:${ownerId}`;
    const mapped = mappings.get(key);
    if (!mapped) throw new Error(`Bの${key}についてAへの明示owner mappingがありません。`);
    const owner = findOne(targetA, mapped.ownerTagName, mapped.ownerId);
    if (!directChild(owner, 'StbNodeIdList')) {
      throw new Error(`Aの${mapped.ownerTagName}#${mapped.ownerId}にStbNodeIdListがありません。`);
    }
    const targetKey = `${mapped.ownerTagName}:${mapped.ownerId}`;
    if (used.has(targetKey))
      throw new Error(`Bの複数所属がAの同一owner ${targetKey}を参照します。`);
    used.add(targetKey);
    return mapped;
  });
  if (
    !original.some(({ ownerTagName }) => ownerTagName === 'StbStory') &&
    elements(targetA, 'StbStory').some((story) => directChild(story, 'StbNodeIdList'))
  ) {
    throw new Error(`B Node#${nodeId}のStory所属を解決できずAで明示listが利用されています。`);
  }
  return target;
}

function freshGuid(guidFactory, used) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const guid = String(guidFactory()).toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(guid))
      throw new Error('GUID factoryには32桁の16進文字列が必要です。');
    if (!used.has(guid)) {
      used.add(guid);
      return guid;
    }
  }
  throw new Error('一意なGUIDを確保できません。');
}

function defaultGuidFactory() {
  if (typeof globalThis.crypto?.randomUUID !== 'function')
    throw new Error('安全なGUID生成が利用できません。');
  return globalThis.crypto.randomUUID().replaceAll('-', '').toLowerCase();
}

/** Only an approved operation may mutate the Working Document via its command journal. */
export function createReferenceNodeAdoptionService(
  session = editingSession,
  { guidFactory = defaultGuidFactory } = {},
) {
  return {
    adoptNodes({ sourceDocumentB, nodeIds, ownerMappings = [], approved = false, validate } = {}) {
      if (approved !== true) throw new Error('B→A Node取り込みには明示承認が必要です。');
      if (session?.getState?.()?.active !== true) throw new Error('AのWorking Sessionが必要です。');
      const targetA = session.getWorkingDocument?.();
      if (!targetA || typeof session.runTransaction !== 'function')
        throw new Error('編集セッションが不正です。');
      assertStbDocument(targetA, 'A');
      assertStbDocument(sourceDocumentB, 'B');
      if (targetA === sourceDocumentB) throw new Error('AとBが同じDocumentです。');
      assertSameFrame(targetA, sourceDocumentB);

      const ids = selectedNodeIds(nodeIds);
      const newIds = allocateIds(targetA, ids.length);
      const mappingIndex = createOwnerMappingIndex(ownerMappings);
      const usedGuids = new Set(
        [...elements(targetA, '*'), targetA.documentElement]
          .map((item) => String(item?.getAttribute?.('guid') || '').toLowerCase())
          .filter(Boolean),
      );
      const commands = [];
      const adopted = [];
      for (const [index, sourceId] of ids.entries()) {
        const source = findOne(sourceDocumentB, 'StbNode', sourceId);
        if (
          source.hasAttribute('id_member') ||
          !['ON_GRID', 'OTHER'].includes(source.getAttribute('kind'))
        ) {
          throw new Error(
            `B Node#${sourceId}は単独Node取り込み対象外(kind/id_member)です。部材移行契約が必要です。`,
          );
        }
        const memberships = mappedMemberships(sourceDocumentB, targetA, sourceId, mappingIndex);
        const clone = source.cloneNode(true);
        const newId = newIds[index];
        clone.setAttribute('id', newId);
        const sourceGuid = source.getAttribute('guid');
        // A owns a new identity even when B has no optional STB GUID.
        clone.setAttribute('guid', freshGuid(guidFactory, usedGuids));
        commands.push(
          createAddElementCommand(targetA, clone, {
            parentPath: ['StbNodes'],
            elementType: 'Node',
            label: `B StbNode#${sourceId}をA StbNode#${newId}へ取り込み`,
          }),
        );
        if (memberships.length) {
          commands.push({
            type: 'copyNodeMembership',
            sourceNodeId: sourceId,
            targetNodeId: newId,
            memberships,
            affectedElements: [],
            isNoop: false,
            label: `B Node#${sourceId}の明示所属をAへ再関連付け`,
          });
        }
        adopted.push({
          sourceModel: 'B',
          sourceId,
          sourceGuid,
          targetModel: 'A',
          targetId: newId,
          targetGuid: clone.getAttribute('guid'),
          memberships,
        });
      }
      const result = session.runTransaction(commands, {
        label: `B→A Node取り込み ${ids.length}件`,
        reason: 'adoptReferenceNodes',
        validate,
      });
      return { ...result, adopted };
    },
  };
}
