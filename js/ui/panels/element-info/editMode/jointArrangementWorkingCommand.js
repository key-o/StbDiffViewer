/**
 * @fileoverview ST-Bridge 2.1.x StbJointArrangement を Working Document Command へ接続する。
 *
 * id_section は部材断面IDではなく、kind_member に応じて StbJoints 直下の
 * StbJointColumn* / StbJointBeam* の ID を参照する。Source Document は変更しない。
 */

import { detectStbVersion } from '../../../../common-stb/import/parser/utils/stbVersionDetection.js';
import { createAddElementCommand } from '../../../../app/editing/addElementCommand.js';
import { createDeleteElementCommand } from '../../../../app/editing/deleteElementCommand.js';
import { createSetAttributeCommand } from '../../../../app/editing/setAttributeCommand.js';
import editingSession from '../../../../app/editing/editingSession.js';
import { showSuccess } from '../../../common/toast.js';
import { generateNextId } from './domHelpers.js';

const MEMBER_KIND_BY_TAG = Object.freeze({
  StbColumn: 'COLUMN',
  StbPost: 'POST',
  StbGirder: 'GIRDER',
  StbBeam: 'BEAM',
  StbBrace: 'BRACE',
});

const MEMBER_TAG_BY_KIND = Object.freeze(
  Object.fromEntries(Object.entries(MEMBER_KIND_BY_TAG).map(([tagName, kind]) => [kind, tagName])),
);

function selectorById(tagName, id) {
  return `${tagName}[id="${String(id).replace(/"/g, '\\"')}"]`;
}

function is21(version) {
  return String(version || '').startsWith('2.1');
}

function getWorking21Document(operationLabel) {
  if (editingSession.getState()?.active !== true) {
    return { document: null, error: `${operationLabel}は Working Session 中のみ実行できます。` };
  }
  const document = editingSession.getWorkingDocument();
  if (!document) return { document: null, error: 'Working Document がありません。' };
  const version = detectStbVersion(document);
  if (!is21(version)) {
    return {
      document: null,
      error: `${operationLabel}は ST-Bridge 2.1.x の StbJointArrangement のみ対応しています。`,
    };
  }
  return { document, error: null };
}

function createDetachedElement(document, tagName, attrs) {
  const model = document?.querySelector?.('StbModel');
  if (!model) throw new Error('StbModel が見つかりません');
  const namespaceURI = model.namespaceURI;
  const element = namespaceURI
    ? document.createElementNS(namespaceURI, tagName)
    : document.createElement(tagName);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || String(value).trim() === '') continue;
    element.setAttribute(name, String(value));
  }
  return element;
}

function jointFamilyForMemberTag(memberTag) {
  if (memberTag === 'StbColumn' || memberTag === 'StbPost') return 'column';
  if (memberTag === 'StbGirder' || memberTag === 'StbBeam' || memberTag === 'StbBrace')
    return 'beam';
  return null;
}

function jointDefinitionPrefix(memberTag) {
  const family = jointFamilyForMemberTag(memberTag);
  if (family === 'column') return 'StbJointColumn';
  if (family === 'beam') return 'StbJointBeam';
  return null;
}

function getJointDefinitions(document, memberTag) {
  const prefix = jointDefinitionPrefix(memberTag);
  if (!prefix) return [];
  const container =
    document.querySelector('StbModel > StbJoints') || document.querySelector('StbJoints');
  return Array.from(container?.children || []).filter(
    (element) => element.tagName.startsWith(prefix) && element.getAttribute('id'),
  );
}

function resolveJointDefinition(document, memberTag, jointId) {
  const id = String(jointId ?? '').trim();
  if (!id) {
    return {
      definition: null,
      error: 'StbJointArrangement.id_section（継手ID）を指定してください。',
    };
  }
  const definition = getJointDefinitions(document, memberTag).find(
    (element) => String(element.getAttribute('id')) === id,
  );
  if (!definition) {
    const family = jointFamilyForMemberTag(memberTag);
    const expected =
      family === 'column' ? 'StbJointColumn*' : family === 'beam' ? 'StbJointBeam*' : '継手';
    return {
      definition: null,
      error: `${memberTag} に対応する ${expected} #${id} が StbJoints に見つかりません。`,
    };
  }
  return { definition, error: null };
}

function resolveMember(document, memberTag, memberId) {
  const kindMember = MEMBER_KIND_BY_TAG[memberTag];
  if (!kindMember) {
    return { member: null, kindMember: null, error: '継手を配置できない部材種別です。' };
  }
  const member = document.querySelector(selectorById(memberTag, memberId));
  if (!member) {
    return {
      member: null,
      kindMember,
      error: `${memberTag} #${memberId} が Working Document に見つかりません。`,
    };
  }
  return { member, kindMember, error: null };
}

function memberAffectedElement(memberTag, member) {
  const elementId = member?.getAttribute?.('id');
  if (!elementId || !MEMBER_KIND_BY_TAG[memberTag]) return null;
  return { elementType: memberTag.replace(/^Stb/, ''), elementId: String(elementId) };
}

function dedupeAffectedElements(elements) {
  const map = new Map();
  for (const element of elements || []) {
    if (!element?.elementType || element.elementId === undefined || element.elementId === null)
      continue;
    const normalized = {
      elementType: String(element.elementType),
      elementId: String(element.elementId),
    };
    map.set(`${normalized.elementType}:${normalized.elementId}`, normalized);
  }
  return [...map.values()];
}

function affectedForArrangement(document, arrangement) {
  const memberTag = MEMBER_TAG_BY_KIND[String(arrangement?.getAttribute?.('kind_member') || '')];
  const memberId = arrangement?.getAttribute?.('id_member');
  if (!memberTag || !memberId) return [];
  const member = document.querySelector(selectorById(memberTag, memberId));
  return dedupeAffectedElements([memberAffectedElement(memberTag, member)]);
}

function createAffectedAttributeCommand(
  document,
  arrangementId,
  attributeName,
  nextValue,
  affectedElements,
) {
  const command = createSetAttributeCommand(
    document,
    'JointArrangement',
    arrangementId,
    attributeName,
    nextValue,
  );
  command.affectedElements = dedupeAffectedElements(affectedElements);
  return command;
}

function validateStartingPoint(value) {
  const startingPoint = String(value || '').trim();
  return ['START', 'END'].includes(startingPoint)
    ? { value: startingPoint, error: null }
    : { value: '', error: 'starting_point は START または END を指定してください。' };
}

function validateDistance(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { value: '', error: 'distance を指定してください。' };
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? { value: String(value), error: null }
    : { value: '', error: 'distance は0より大きい有限な数値で指定してください。' };
}

function addWorkingJointArrangement({ memberTag, memberId, attrs = {} }) {
  const resolved = getWorking21Document('継手配置追加');
  if (!resolved.document) return { success: false, id: null, error: resolved.error };
  const document = resolved.document;

  const memberResult = resolveMember(document, memberTag, memberId);
  if (memberResult.error) return { success: false, id: null, error: memberResult.error };
  const jointId = String(attrs.id_section ?? attrs.jointId ?? '').trim();
  const jointResult = resolveJointDefinition(document, memberTag, jointId);
  if (jointResult.error) return { success: false, id: null, error: jointResult.error };
  const pointResult = validateStartingPoint(attrs.starting_point);
  if (pointResult.error) return { success: false, id: null, error: pointResult.error };
  const distanceResult = validateDistance(attrs.distance);
  if (distanceResult.error) return { success: false, id: null, error: distanceResult.error };

  try {
    const id = generateNextId(document, 'StbJointArrangement');
    const arrangement = createDetachedElement(document, 'StbJointArrangement', {
      id,
      name: attrs.name,
      id_section: jointId,
      kind_member: memberResult.kindMember,
      id_member: String(memberId),
      starting_point: pointResult.value,
      distance: distanceResult.value,
    });
    const affectedElements = dedupeAffectedElements([
      memberAffectedElement(memberTag, memberResult.member),
    ]);
    const command = createAddElementCommand(document, arrangement, {
      parentPath: ['StbMembers', 'StbJointArrangements'],
      elementType: 'JointArrangement',
      affectedElements,
      label: `StbJointArrangement #${id} を追加`,
    });
    editingSession.executeCommand(command, { reason: 'addJointArrangement' });
    showSuccess(
      `StbJointArrangement #${id}（継手 #${jointId}）を ${memberTag} #${memberId} に追加しました`,
    );
    return {
      success: true,
      id,
      tagName: 'StbJointArrangement',
      jointId,
      jointTagName: jointResult.definition.tagName,
    };
  } catch (error) {
    return {
      success: false,
      id: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function reassignWorkingJointArrangement({ arrangementId, memberTag, memberId, jointId = null }) {
  const resolved = getWorking21Document('継手配置の再割当');
  if (!resolved.document) return { success: false, error: resolved.error };
  const document = resolved.document;
  const id = String(arrangementId ?? '').trim();
  const arrangement = id ? document.querySelector(selectorById('StbJointArrangement', id)) : null;
  if (!arrangement) {
    return { success: false, error: `StbJointArrangement #${id || '?'} が見つかりません。` };
  }

  const memberResult = resolveMember(document, memberTag, memberId);
  if (memberResult.error) return { success: false, error: memberResult.error };
  const targetJointId = String(jointId ?? arrangement.getAttribute('id_section') ?? '').trim();
  const jointResult = resolveJointDefinition(document, memberTag, targetJointId);
  if (jointResult.error) return { success: false, error: jointResult.error };

  const affectedElements = dedupeAffectedElements([
    ...affectedForArrangement(document, arrangement),
    memberAffectedElement(memberTag, memberResult.member),
  ]);
  const commands = [
    createAffectedAttributeCommand(
      document,
      id,
      'kind_member',
      memberResult.kindMember,
      affectedElements,
    ),
    createAffectedAttributeCommand(document, id, 'id_member', String(memberId), affectedElements),
    createAffectedAttributeCommand(document, id, 'id_section', targetJointId, affectedElements),
  ].filter((command) => !command.isNoop);

  if (commands.length === 0) {
    return { success: false, error: '選択した部材・継手には既に割り当て済みです。' };
  }

  try {
    editingSession.runTransaction(commands, {
      reason: 'reassignJointArrangement',
      label: `StbJointArrangement #${id} を再割当`,
    });
    showSuccess(
      `StbJointArrangement #${id} を ${memberTag} #${memberId} / 継手 #${targetJointId} へ再割当しました`,
    );
    return {
      success: true,
      id,
      jointId: targetJointId,
      jointTagName: jointResult.definition.tagName,
      affectedElements,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function deleteWorkingJointArrangement({ arrangementId }) {
  const resolved = getWorking21Document('継手配置の削除');
  if (!resolved.document) return { success: false, error: resolved.error };
  const document = resolved.document;
  const id = String(arrangementId ?? '').trim();
  const arrangement = id ? document.querySelector(selectorById('StbJointArrangement', id)) : null;
  if (!arrangement) {
    return { success: false, error: `StbJointArrangement #${id || '?'} が見つかりません。` };
  }

  const affectedElements = affectedForArrangement(document, arrangement);
  try {
    const command = createDeleteElementCommand(document, 'JointArrangement', id, {
      tagName: 'StbJointArrangement',
      affectedElements,
      structuralChange: false,
      label: `StbJointArrangement #${id} を削除`,
    });
    editingSession.executeCommand(command, { reason: 'deleteJointArrangement' });
    showSuccess(`StbJointArrangement #${id} を削除しました`);
    return { success: true, id, affectedElements };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Working Session 中だけ StbJointArrangement を追加する。 */
export function addJointArrangement(input) {
  return addWorkingJointArrangement(input || {});
}

/** 2.1.x の既存継手配置を別部材・別継手定義へ atomic に再割当する。 */
export function reassignJointArrangement(input) {
  return reassignWorkingJointArrangement(input || {});
}

/** 2.1.x の既存継手配置を Working history へ載せて削除する。 */
export function deleteJointArrangement(input) {
  return deleteWorkingJointArrangement(input || {});
}

export function getCompatibleJointDefinitions21(document, memberTag) {
  return getJointDefinitions(document, memberTag).map((element) => ({
    id: String(element.getAttribute('id')),
    tagName: element.tagName,
    name: element.getAttribute('joint_name') || element.getAttribute('name') || '',
  }));
}
