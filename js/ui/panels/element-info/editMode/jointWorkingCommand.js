/**
 * @fileoverview ST-Bridge 2.0.2 継手定義・割当を Working Document Command へ接続する。
 *
 * Working Session 未開始時は既存 jointAdd.js の legacy mutation を維持する。
 * Working Session 中は Source Document を変更せず、継手定義追加を AddElementCommand、
 * joint_id_* / joint_* / kind_joint_* の割当を SetAttributeCommand の transaction として扱う。
 */

import { detectStbVersion } from '../../../../common-stb/import/parser/utils/stbVersionDetection.js';
import { createAddElementCommand } from '../../../../app/editing/addElementCommand.js';
import { createCompositeCommand } from '../../../../app/editing/editCommand.js';
import editingSession from '../../../../app/editing/editingSession.js';
import { createSetAttributeCommand } from '../../../../app/editing/setAttributeCommand.js';
import { setState } from '../../../../data/state/globalState.js';
import { showSuccess } from '../../../common/toast.js';
import { buildElementEditPath } from '../editPath.js';
import {
  addNewJointElement as addLegacyNewJointElement,
  assignJointDefinition202 as assignLegacyJointDefinition202,
  getCompatibleJointEndpoints202 as getLegacyCompatibleJointEndpoints202,
} from './jointAdd.js';

const JOINT_ORDER = Object.freeze([
  'StbJointBeamShapeH',
  'StbJointColumnShapeH',
  'StbJointColumnShapeT',
  'StbJointColumnShapeCross',
]);

const COLUMN_JOINT_TAGS = new Set([
  'StbJointColumnShapeH',
  'StbJointColumnShapeT',
  'StbJointColumnShapeCross',
]);
const COLUMN_MEMBER_TAGS = new Set(['StbColumn', 'StbPost']);
// 2.0.2 の StbJointBeamShapeH は S梁継手であり、legacy route と同様 Brace は対象外とする。
const BEAM_MEMBER_TAGS = new Set(['StbGirder', 'StbBeam']);
const JOINT_KINDS_202 = new Set(['BOLT', 'WBOLT', 'WELD']);

const SECTION_TARGETS_202 = Object.freeze({
  column: Object.freeze([
    { sectionTag: 'StbSecColumn_S', figureTag: 'StbSecSteelFigureColumn_S' },
    { sectionTag: 'StbSecColumn_SRC', figureTag: 'StbSecSteelFigureColumn_SRC' },
  ]),
  beam: Object.freeze([
    { sectionTag: 'StbSecBeam_S', figureTag: 'StbSecSteelFigureBeam_S' },
    { sectionTag: 'StbSecBeam_SRC', figureTag: 'StbSecSteelFigureBeam_SRC' },
  ]),
});

const MEMBER_SECTION_TARGET_202 = Object.freeze({
  StbColumn: Object.freeze({
    S: { sectionTag: 'StbSecColumn_S', figureTag: 'StbSecSteelFigureColumn_S' },
    SRC: { sectionTag: 'StbSecColumn_SRC', figureTag: 'StbSecSteelFigureColumn_SRC' },
  }),
  StbPost: Object.freeze({
    S: { sectionTag: 'StbSecColumn_S', figureTag: 'StbSecSteelFigureColumn_S' },
    SRC: { sectionTag: 'StbSecColumn_SRC', figureTag: 'StbSecSteelFigureColumn_SRC' },
  }),
  StbGirder: Object.freeze({
    S: { sectionTag: 'StbSecBeam_S', figureTag: 'StbSecSteelFigureBeam_S' },
    SRC: { sectionTag: 'StbSecBeam_SRC', figureTag: 'StbSecSteelFigureBeam_SRC' },
  }),
  StbBeam: Object.freeze({
    S: { sectionTag: 'StbSecBeam_S', figureTag: 'StbSecSteelFigureBeam_S' },
    SRC: { sectionTag: 'StbSecBeam_SRC', figureTag: 'StbSecSteelFigureBeam_SRC' },
  }),
});

const EXPECTED_STEEL_KIND_202 = Object.freeze({
  StbJointBeamShapeH: 'H',
  StbJointColumnShapeH: 'H',
  StbJointColumnShapeT: 'T',
  StbJointColumnShapeCross: 'CROSS',
});

function selectorById(tagName, id) {
  return `${tagName}[id="${String(id).replace(/"/g, '\\"')}"]`;
}

function getWorking202Document(operationLabel) {
  const document = editingSession.getWorkingDocument();
  if (!document) return { document: null, error: 'Working Document がありません' };
  const version = detectStbVersion(document);
  if (version !== '2.0.2') {
    return {
      document: null,
      error: `Working Session 中の${operationLabel}は ST-Bridge 2.0.2 経路のみ対応しています。`,
    };
  }
  return { document, error: null };
}

function jointFamily202(jointTag) {
  if (jointTag === 'StbJointBeamShapeH') return 'beam';
  if (COLUMN_JOINT_TAGS.has(jointTag)) return 'column';
  return null;
}

function nextJointId(document, tagName) {
  const container = document.querySelector('StbModel > StbJoints');
  const tags = COLUMN_JOINT_TAGS.has(tagName) ? COLUMN_JOINT_TAGS : new Set([tagName]);
  let maxId = 0;
  for (const child of Array.from(container?.children || [])) {
    if (!tags.has(child.tagName)) continue;
    const id = Number(child.getAttribute('id'));
    if (Number.isInteger(id) && id > maxId) maxId = id;
  }
  return String(maxId + 1);
}

function validatePositiveDistance(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return `${label}は0より大きい数値で入力してください`;
  return null;
}

function resolveSectionFigure(document, sectionTag, sectionId, figureTag) {
  const section = document.querySelector(selectorById(sectionTag, sectionId));
  if (!section) return { section: null, figure: null };
  const figure =
    Array.from(section.children || []).find((child) => child.tagName === figureTag) || null;
  return { section, figure };
}

function findSteelDefinitionByName(document, shapeName) {
  const steel = document.querySelector('StbSections > StbSecSteel');
  if (!steel || !shapeName) return null;
  return (
    Array.from(steel.children || []).find(
      (child) => child.getAttribute('name') === String(shapeName),
    ) || null
  );
}

function steelDefinitionKind(definition) {
  if (!definition) return null;
  if (definition.tagName === 'StbSecRoll-H' || definition.tagName === 'StbSecBuild-H') return 'H';
  if (definition.tagName === 'StbSecRoll-T') return 'T';
  return 'OTHER';
}

function directFigureChildForEndpoint(figure, family, endpoint) {
  const children = Array.from(figure?.children || []);
  if (children.length === 0) return null;
  const pos = family === 'column' ? (endpoint === 'START' ? 'BOTTOM' : 'TOP') : endpoint;
  const exact = children.find((child) => child.getAttribute('pos') === pos);
  if (exact) return exact;
  const withoutPos = children.filter((child) => !child.hasAttribute('pos'));
  return withoutPos.length === 1 ? withoutPos[0] : null;
}

function srcColumnSteelKind(wrapper) {
  if (!wrapper) return null;
  for (const descendant of Array.from(wrapper.querySelectorAll('*'))) {
    const tagName = descendant.tagName || '';
    if (/ShapeH$/.test(tagName)) return 'H';
    if (/ShapeT$/.test(tagName)) return 'T';
    if (/ShapeCross$/.test(tagName)) return 'CROSS';
    if (/Shape(?:Box|Pipe)$/.test(tagName)) return 'OTHER';
  }
  return null;
}

function endpointSteelKindForSection202(
  document,
  sectionTag,
  sectionId,
  figureTag,
  family,
  endpoint,
) {
  const { section, figure } = resolveSectionFigure(document, sectionTag, sectionId, figureTag);
  if (!section || !figure) return null;
  const child = directFigureChildForEndpoint(figure, family, endpoint);
  if (!child) return null;

  if (sectionTag === 'StbSecColumn_SRC') return srcColumnSteelKind(child);

  const shapeElement = child.hasAttribute('shape')
    ? child
    : Array.from(child.querySelectorAll('*')).find((descendant) =>
        descendant.hasAttribute('shape'),
      );
  return steelDefinitionKind(
    findSteelDefinitionByName(document, shapeElement?.getAttribute('shape')),
  );
}

function resolveMemberSectionTarget202(document, memberTag, memberId) {
  const member = document.querySelector(selectorById(memberTag, memberId));
  if (!member) return { member: null, sectionTarget: null };
  const structure = String(member.getAttribute('kind_structure') || '');
  const sectionTarget = MEMBER_SECTION_TARGET_202[memberTag]?.[structure] || null;
  if (!sectionTarget) return { member, sectionTarget: null };
  return {
    member,
    sectionTarget: {
      ...sectionTarget,
      sectionId: member.getAttribute('id_section'),
    },
  };
}

function getCompatibleEndpointsFromDocument(
  document,
  { jointTag, targetKind, targetTag, targetId, figureTag = '' },
) {
  const family = jointFamily202(jointTag);
  const expected = EXPECTED_STEEL_KIND_202[jointTag];
  if (!document || !family || !expected) return [];

  let sectionTag = targetTag;
  let sectionId = targetId;
  let resolvedFigureTag = figureTag;
  if (targetKind === 'member') {
    const allowed = family === 'column' ? COLUMN_MEMBER_TAGS : BEAM_MEMBER_TAGS;
    if (!allowed.has(targetTag)) return [];
    const { member, sectionTarget } = resolveMemberSectionTarget202(document, targetTag, targetId);
    if (!member || !sectionTarget) return [];
    sectionTag = sectionTarget.sectionTag;
    sectionId = sectionTarget.sectionId;
    resolvedFigureTag = sectionTarget.figureTag;
  } else if (targetKind === 'section') {
    const allowed = (SECTION_TARGETS_202[family] || []).some(
      (item) => item.sectionTag === targetTag && item.figureTag === figureTag,
    );
    if (!allowed) return [];
  } else {
    return [];
  }

  if (!sectionId || !resolvedFigureTag) return [];
  return ['START', 'END'].filter(
    (endpoint) =>
      endpointSteelKindForSection202(
        document,
        sectionTag,
        sectionId,
        resolvedFigureTag,
        family,
        endpoint,
      ) === expected,
  );
}

function createAttributeCommand(document, target, name, value, options = {}) {
  const command = createSetAttributeCommand(
    document,
    target.elementType,
    target.elementId,
    name,
    value,
    options,
  );
  return command.isNoop ? null : command;
}

function buildAssignmentCommands(document, target, family, jointId, endpoint, values) {
  const endpoints = endpoint === 'BOTH' ? ['START', 'END'] : [endpoint];
  const commands = [];
  for (const currentEndpoint of endpoints) {
    const suffix =
      family === 'column'
        ? currentEndpoint === 'START'
          ? 'bottom'
          : 'top'
        : currentEndpoint === 'START'
          ? 'start'
          : 'end';
    const commonOptions = target.editPath ? { editPath: target.editPath } : {};
    const idCommand = createAttributeCommand(
      document,
      target,
      `joint_id_${suffix}`,
      String(jointId),
      commonOptions,
    );
    if (idCommand) commands.push(idCommand);

    if (target.targetKind !== 'member') continue;
    const distance = currentEndpoint === 'START' ? values.distanceStart : values.distanceEnd;
    const kind = currentEndpoint === 'START' ? values.kindStart : values.kindEnd;
    if (distance !== undefined && distance !== null && String(distance).trim() !== '') {
      const distanceCommand = createAttributeCommand(document, target, `joint_${suffix}`, distance);
      if (distanceCommand) commands.push(distanceCommand);
    }
    if (kind !== undefined && kind !== null && String(kind).trim() !== '') {
      const kindCommand = createAttributeCommand(document, target, `kind_joint_${suffix}`, kind);
      if (kindCommand) commands.push(kindCommand);
    }
  }
  return commands;
}

function collapseCreationAndAssignmentHistory(jointTag, jointId, assignmentCommand) {
  const state = editingSession.getState();
  const history = state.history || [];
  if (history.length < 2) return false;
  const assignment = history[history.length - 1];
  const creation = history[history.length - 2];
  if (assignment !== assignmentCommand) return false;
  if (
    creation?.type !== 'addElement' ||
    creation.elementSnapshot?.tagName !== jointTag ||
    String(creation.elementId) !== String(jointId)
  ) {
    return false;
  }

  const combined = createCompositeCommand([creation, assignment], {
    label: `${jointTag} #${jointId} を作成して割当`,
  });
  setState('models.editing', {
    ...state,
    history: [...history.slice(0, -2), combined],
  });
  return true;
}

function addWorkingJointElement(builtElement) {
  const resolved = getWorking202Document('継手定義追加');
  if (!resolved.document) return { success: false, id: null, error: resolved.error };
  const document = resolved.document;
  const tagName = builtElement?.tagName;
  if (!tagName || !JOINT_ORDER.includes(tagName)) {
    return { success: false, id: null, error: '未対応の継手要素です' };
  }

  try {
    const id = nextJointId(document, tagName);
    builtElement.setAttribute('id', id);
    const command = createAddElementCommand(document, builtElement, {
      parentPath: ['StbJoints'],
      siblingOrder: JOINT_ORDER,
      elementType: tagName.replace(/^Stb/, ''),
      label: `${tagName} #${id} を追加`,
    });
    editingSession.executeCommand(command, { reason: 'addJointDefinition202' });
    showSuccess(`${tagName} #${id} を追加しました`);
    return { success: true, id, tagName };
  } catch (error) {
    return {
      success: false,
      id: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function assignWorkingJointDefinition202({
  jointTag,
  jointId,
  targetKind,
  targetTag,
  targetId,
  figureTag = '',
  endpoint = 'START',
  distanceStart = '',
  distanceEnd = '',
  kindStart = '',
  kindEnd = '',
  combineWithCreation = false,
}) {
  const resolved = getWorking202Document('継手割当');
  if (!resolved.document) return { success: false, error: resolved.error };
  const document = resolved.document;

  const family = jointFamily202(jointTag);
  if (!family) return { success: false, error: '未対応の2.0.2継手定義です' };
  const joint = document.querySelector(selectorById(jointTag, jointId));
  if (!joint) return { success: false, error: `${jointTag} #${jointId} が見つかりません` };
  if (!['START', 'END', 'BOTH'].includes(endpoint)) {
    return { success: false, error: '継手位置は START / END / BOTH を指定してください' };
  }

  let target;
  if (targetKind === 'member') {
    const allowed = family === 'column' ? COLUMN_MEMBER_TAGS : BEAM_MEMBER_TAGS;
    if (!allowed.has(targetTag)) {
      return { success: false, error: `${jointTag} は ${targetTag} へ割り当てできません` };
    }
    const member = document.querySelector(selectorById(targetTag, targetId));
    if (!member) return { success: false, error: `${targetTag} #${targetId} が見つかりません` };
    if (!['S', 'SRC'].includes(String(member.getAttribute('kind_structure')))) {
      return { success: false, error: '2.0.2継手定義は S / SRC 部材へ割り当ててください' };
    }
    target = {
      targetKind,
      elementType: targetTag,
      elementId: String(targetId),
      editPath: null,
    };
  } else if (targetKind === 'section') {
    const allowedTarget = (SECTION_TARGETS_202[family] || []).find(
      (item) => item.sectionTag === targetTag && item.figureTag === figureTag,
    );
    if (!allowedTarget) {
      return { success: false, error: `${jointTag} は指定断面へ割り当てできません` };
    }
    const { section, figure } = resolveSectionFigure(document, targetTag, targetId, figureTag);
    if (!section) return { success: false, error: `${targetTag} #${targetId} が見つかりません` };
    if (!figure) return { success: false, error: `${figureTag} が断面内にありません` };
    const editPath = buildElementEditPath(figure);
    if (!editPath) return { success: false, error: `${figureTag} の編集パスを解決できません` };
    target = {
      targetKind,
      elementType: targetTag,
      elementId: String(targetId),
      editPath,
    };
  } else {
    return { success: false, error: '割当先種別が不正です' };
  }

  const endpoints = endpoint === 'BOTH' ? ['START', 'END'] : [endpoint];
  const compatible = new Set(
    getCompatibleEndpointsFromDocument(document, {
      jointTag,
      targetKind,
      targetTag,
      targetId,
      figureTag,
    }),
  );
  const incompatible = endpoints.filter((item) => !compatible.has(item));
  if (incompatible.length > 0) {
    return {
      success: false,
      error: `${incompatible.join('/')} 側の鉄骨断面は ${EXPECTED_STEEL_KIND_202[jointTag]} 形継手と適合する形状として確認できません`,
    };
  }

  if (targetKind === 'member') {
    for (const currentEndpoint of endpoints) {
      const distance = currentEndpoint === 'START' ? distanceStart : distanceEnd;
      const distanceError = validatePositiveDistance(
        distance,
        family === 'column'
          ? currentEndpoint === 'START'
            ? '柱脚側継手距離'
            : '柱頭側継手距離'
          : currentEndpoint === 'START'
            ? '始端側継手距離'
            : '終端側継手距離',
      );
      if (distanceError) return { success: false, error: distanceError };
      const kind = currentEndpoint === 'START' ? kindStart : kindEnd;
      if (kind && !JOINT_KINDS_202.has(String(kind))) {
        return { success: false, error: '継手種別は BOLT / WBOLT / WELD を指定してください' };
      }
    }
  }

  try {
    const commands = buildAssignmentCommands(document, target, family, jointId, endpoint, {
      distanceStart,
      distanceEnd,
      kindStart,
      kindEnd,
    });
    if (commands.length === 0) {
      return { success: false, error: '選択した割当内容は既に設定済みです' };
    }

    const result = editingSession.runTransaction(commands, {
      reason: 'assignJointDefinition202',
      label: `${jointTag} #${jointId} を割当`,
    });
    const combinedWithCreation =
      combineWithCreation === true &&
      collapseCreationAndAssignmentHistory(jointTag, jointId, result.command);
    const changes = commands.map((command) => ({
      name: command.attributeName,
      oldValue: command.before,
      newValue: command.after,
    }));

    showSuccess(
      `${jointTag} #${jointId} を ${targetKind === 'member' ? `${targetTag} #${targetId}` : `${targetTag} #${targetId} の ${figureTag}`} へ割り当てました`,
    );
    return { success: true, jointId: String(jointId), changes, combinedWithCreation };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Working Session 中だけ Working Command を使用する public adapter。 */
export function addNewJointElement(builtElement) {
  if (editingSession.getState()?.active !== true) return addLegacyNewJointElement(builtElement);
  return addWorkingJointElement(builtElement);
}

/** Working Session 中は Working Document の断面状態を使って適合端を判定する。 */
export function getCompatibleJointEndpoints202(input) {
  if (editingSession.getState()?.active !== true)
    return getLegacyCompatibleJointEndpoints202(input);
  const resolved = getWorking202Document('継手適合判定');
  return resolved.document ? getCompatibleEndpointsFromDocument(resolved.document, input) : [];
}

/** Working Session 中だけ Working Command を使用する public adapter。 */
export function assignJointDefinition202(input) {
  if (editingSession.getState()?.active !== true) return assignLegacyJointDefinition202(input);
  return assignWorkingJointDefinition202(input);
}
