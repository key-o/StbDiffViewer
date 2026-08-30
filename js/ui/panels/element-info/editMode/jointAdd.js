/**
 * @fileoverview 継手の新規追加・割当
 *
 * ST-Bridge 2.0.2:
 * - StbJoints 直下の梁H形・柱H/T/Cross継手定義を追加
 * - 生成/既存継手を S/SRC 部材の joint_id_* へ割当
 * - または StbSecSteelFigure* の joint_id_* へ断面既定値として割当
 * - 継手形状と割当端部の鉄骨形状（H/T/Cross）を照合し、既知の不整合を拒否
 *
 * ST-Bridge 2.1.x:
 * - StbMembers > StbJointArrangements > StbJointArrangement を対象部材へ配置
 */

import { getState } from '../../../../data/state/globalState.js';
import { showSuccess } from '../../../common/toast.js';
import { ensureContainer, findDirectChild, generateNextId, emitStructuralChange } from './domHelpers.js';
import { updateEditingSummary } from './editHistory.js';
import { getModifications } from './editState.js';

const JOINT_ORDER = [
  'StbJointBeamShapeH',
  'StbJointColumnShapeH',
  'StbJointColumnShapeT',
  'StbJointColumnShapeCross',
];
const COLUMN_JOINT_TAGS = new Set([
  'StbJointColumnShapeH',
  'StbJointColumnShapeT',
  'StbJointColumnShapeCross',
]);
const MEMBER_KIND_BY_TAG = {
  StbColumn: 'COLUMN',
  StbPost: 'POST',
  StbGirder: 'GIRDER',
  StbBeam: 'BEAM',
  StbBrace: 'BRACE',
};
const COLUMN_MEMBER_TAGS = new Set(['StbColumn', 'StbPost']);
// 2.0.2 の継手仕様で StbJointBeamShapeH は「S梁継手・H形」と定義されるため、
// joint_id_* 属性を持つ StbBrace はここでは候補に含めない。
const BEAM_MEMBER_TAGS = new Set(['StbGirder', 'StbBeam']);
const JOINT_KINDS_202 = new Set(['BOLT', 'WBOLT', 'WELD']);

const SECTION_TARGETS_202 = {
  column: [
    { sectionTag: 'StbSecColumn_S', figureTag: 'StbSecSteelFigureColumn_S' },
    { sectionTag: 'StbSecColumn_SRC', figureTag: 'StbSecSteelFigureColumn_SRC' },
  ],
  beam: [
    { sectionTag: 'StbSecBeam_S', figureTag: 'StbSecSteelFigureBeam_S' },
    { sectionTag: 'StbSecBeam_SRC', figureTag: 'StbSecSteelFigureBeam_SRC' },
  ],
};

const MEMBER_SECTION_TARGET_202 = {
  StbColumn: {
    S: { sectionTag: 'StbSecColumn_S', figureTag: 'StbSecSteelFigureColumn_S' },
    SRC: { sectionTag: 'StbSecColumn_SRC', figureTag: 'StbSecSteelFigureColumn_SRC' },
  },
  StbPost: {
    S: { sectionTag: 'StbSecColumn_S', figureTag: 'StbSecSteelFigureColumn_S' },
    SRC: { sectionTag: 'StbSecColumn_SRC', figureTag: 'StbSecSteelFigureColumn_SRC' },
  },
  StbGirder: {
    S: { sectionTag: 'StbSecBeam_S', figureTag: 'StbSecSteelFigureBeam_S' },
    SRC: { sectionTag: 'StbSecBeam_SRC', figureTag: 'StbSecSteelFigureBeam_SRC' },
  },
  StbBeam: {
    S: { sectionTag: 'StbSecBeam_S', figureTag: 'StbSecSteelFigureBeam_S' },
    SRC: { sectionTag: 'StbSecBeam_SRC', figureTag: 'StbSecSteelFigureBeam_SRC' },
  },
};

const EXPECTED_STEEL_KIND_202 = {
  StbJointBeamShapeH: 'H',
  StbJointColumnShapeH: 'H',
  StbJointColumnShapeT: 'T',
  StbJointColumnShapeCross: 'CROSS',
};

function selectorById(tagName, id) {
  return `${tagName}[id="${String(id).replace(/"/g, '\\"')}"]`;
}

function nextJointId(container, tagName) {
  const tags = COLUMN_JOINT_TAGS.has(tagName) ? COLUMN_JOINT_TAGS : new Set([tagName]);
  let maxId = 0;
  for (const child of Array.from(container.children || [])) {
    if (!tags.has(child.tagName)) continue;
    const id = Number(child.getAttribute('id'));
    if (Number.isInteger(id) && id > maxId) maxId = id;
  }
  return String(maxId + 1);
}

function insertInSchemaOrder(container, element) {
  const order = JOINT_ORDER.indexOf(element.tagName);
  const before = Array.from(container.children || []).find(
    (child) => JOINT_ORDER.indexOf(child.tagName) > order,
  );
  if (before) container.insertBefore(element, before);
  else container.appendChild(element);
}

function jointFamily202(jointTag) {
  if (jointTag === 'StbJointBeamShapeH') return 'beam';
  if (COLUMN_JOINT_TAGS.has(jointTag)) return 'column';
  return null;
}

function endpointSuffix202(family, endpoint) {
  if (family === 'column') return endpoint === 'START' ? 'bottom' : 'top';
  return endpoint === 'START' ? 'start' : 'end';
}

function validatePositiveDistance(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return `${label}は0より大きい数値で入力してください`;
  return null;
}

function setTrackedAttribute(element, name, value, changes, { skipBlank = false } = {}) {
  if (skipBlank && (value === undefined || value === null || String(value).trim() === '')) return;
  const oldValue = element.hasAttribute(name) ? element.getAttribute(name) : null;
  const normalized = value === undefined || value === null || String(value).trim() === '' ? null : String(value);
  if (oldValue === normalized) return;
  if (normalized === null) element.removeAttribute(name);
  else element.setAttribute(name, normalized);
  changes.push({ name, oldValue, newValue: normalized });
}

function resolveSectionFigure(doc, sectionTag, sectionId, figureTag) {
  const section = doc.querySelector(selectorById(sectionTag, sectionId));
  if (!section) return { section: null, figure: null };
  const figure = Array.from(section.children || []).find((child) => child.tagName === figureTag) || null;
  return { section, figure };
}

function findSteelDefinitionByName(doc, shapeName) {
  const steel = doc.querySelector('StbSections > StbSecSteel');
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
  const pos = family === 'column'
    ? endpoint === 'START' ? 'BOTTOM' : 'TOP'
    : endpoint;
  const exact = children.find((child) => child.getAttribute('pos') === pos);
  if (exact) return exact;
  // Same / Straight は位置属性を持たず、両端に同じ形状を適用する。
  const withoutPos = children.filter((child) => !child.hasAttribute('pos'));
  if (withoutPos.length === 1) return withoutPos[0];
  return null;
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

function endpointSteelKindForSection202(doc, sectionTag, sectionId, figureTag, family, endpoint) {
  const { section, figure } = resolveSectionFigure(doc, sectionTag, sectionId, figureTag);
  if (!section || !figure) return null;
  const child = directFigureChildForEndpoint(figure, family, endpoint);
  if (!child) return null;

  if (sectionTag === 'StbSecColumn_SRC') return srcColumnSteelKind(child);

  const shapeElement = child.hasAttribute('shape')
    ? child
    : Array.from(child.querySelectorAll('*')).find((descendant) => descendant.hasAttribute('shape'));
  const shape = shapeElement?.getAttribute('shape');
  return steelDefinitionKind(findSteelDefinitionByName(doc, shape));
}

function resolveMemberSectionTarget202(doc, memberTag, memberId) {
  const member = doc.querySelector(selectorById(memberTag, memberId));
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

/**
 * 2.0.2継手と割当先断面について、形状が確認できる端部だけを返す。
 * 不明な形状を推測では許可せず、StbSecSteel定義またはSRC柱のShape*要素で確認できる場合のみ候補とする。
 * @returns {Array<'START'|'END'>}
 */
export function getCompatibleJointEndpoints202({
  jointTag,
  targetKind,
  targetTag,
  targetId,
  figureTag = '',
}) {
  const doc = getState('models.documentA');
  if (!doc) return [];
  const family = jointFamily202(jointTag);
  const expected = EXPECTED_STEEL_KIND_202[jointTag];
  if (!family || !expected) return [];

  let sectionTag = targetTag;
  let sectionId = targetId;
  let resolvedFigureTag = figureTag;
  if (targetKind === 'member') {
    const allowed = family === 'column' ? COLUMN_MEMBER_TAGS : BEAM_MEMBER_TAGS;
    if (!allowed.has(targetTag)) return [];
    const { member, sectionTarget } = resolveMemberSectionTarget202(doc, targetTag, targetId);
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
        doc,
        sectionTag,
        sectionId,
        resolvedFigureTag,
        family,
        endpoint,
      ) === expected,
  );
}

/** XSD駆動ビルダーで作成した2.0.2継手要素を StbJoints に追加する。 */
export function addNewJointElement(builtElement) {
  const doc = getState('models.documentA');
  if (!doc) return { success: false, id: null, error: 'モデルAが読み込まれていません' };
  if (!builtElement?.tagName || !JOINT_ORDER.includes(builtElement.tagName)) {
    return { success: false, id: null, error: '未対応の継手要素です' };
  }

  const container = ensureContainer(doc, ['StbJoints']);
  if (!container) return { success: false, id: null, error: 'StbModel が見つかりません' };

  const tagName = builtElement.tagName;
  const id = nextJointId(container, tagName);
  builtElement.setAttribute('id', id);
  insertInSchemaOrder(container, builtElement);

  const elementType = tagName.startsWith('Stb') ? tagName.slice(3) : tagName;
  getModifications().push({ op: 'add', elementType, id, tagName });
  emitStructuralChange(elementType, id);
  updateEditingSummary();
  showSuccess(`${tagName} #${id} を追加しました`);
  return { success: true, id, tagName };
}

/**
 * ST-Bridge 2.0.2 の StbJoints 継手定義を、部材または断面鉄骨図形へ割り当てる。
 *
 * targetKind='member':
 *   - 柱/間柱: joint_id_bottom/top + joint_bottom/top + kind_joint_bottom/top
 *   - 大梁/小梁: joint_id_start/end + joint_start/end + kind_joint_start/end
 * targetKind='section':
 *   - StbSecSteelFigureColumn/Beam_* の joint_id_* のみを設定
 */
export function assignJointDefinition202({
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
  const doc = getState('models.documentA');
  if (!doc) return { success: false, error: 'モデルAが読み込まれていません' };

  const family = jointFamily202(jointTag);
  if (!family) return { success: false, error: '未対応の2.0.2継手定義です' };
  const joint = doc.querySelector(selectorById(jointTag, jointId));
  if (!joint) return { success: false, error: `${jointTag} #${jointId} が見つかりません` };
  if (!['START', 'END', 'BOTH'].includes(endpoint)) {
    return { success: false, error: '継手位置は START / END / BOTH を指定してください' };
  }

  let target;
  let emitType;
  let targetDescriptor;
  if (targetKind === 'member') {
    const allowed = family === 'column' ? COLUMN_MEMBER_TAGS : BEAM_MEMBER_TAGS;
    if (!allowed.has(targetTag)) {
      return { success: false, error: `${jointTag} は ${targetTag} へ割り当てできません` };
    }
    target = doc.querySelector(selectorById(targetTag, targetId));
    if (!target) return { success: false, error: `${targetTag} #${targetId} が見つかりません` };
    const structure = target.getAttribute('kind_structure');
    if (!['S', 'SRC'].includes(String(structure))) {
      return { success: false, error: '2.0.2継手定義は S / SRC 部材へ割り当ててください' };
    }
    emitType = targetTag.slice(3);
    targetDescriptor = { targetKind, targetTag, targetId: String(targetId) };
  } else if (targetKind === 'section') {
    const allowedTarget = (SECTION_TARGETS_202[family] || []).find(
      (item) => item.sectionTag === targetTag && item.figureTag === figureTag,
    );
    if (!allowedTarget) {
      return { success: false, error: `${jointTag} は指定断面へ割り当てできません` };
    }
    const resolved = resolveSectionFigure(doc, targetTag, targetId, figureTag);
    if (!resolved.section) return { success: false, error: `${targetTag} #${targetId} が見つかりません` };
    if (!resolved.figure) return { success: false, error: `${figureTag} が断面内にありません` };
    target = resolved.figure;
    emitType = targetTag.slice(3);
    targetDescriptor = {
      targetKind,
      targetTag,
      targetId: String(targetId),
      figureTag,
    };
  } else {
    return { success: false, error: '割当先種別が不正です' };
  }

  const endpoints = endpoint === 'BOTH' ? ['START', 'END'] : [endpoint];
  const compatibleEndpoints = new Set(
    getCompatibleJointEndpoints202({ jointTag, targetKind, targetTag, targetId, figureTag }),
  );
  const incompatible = endpoints.filter((ep) => !compatibleEndpoints.has(ep));
  if (incompatible.length > 0) {
    const expected = EXPECTED_STEEL_KIND_202[jointTag];
    return {
      success: false,
      error: `${incompatible.join('/')} 側の鉄骨断面は ${expected} 形継手と適合する形状として確認できません`,
    };
  }

  if (targetKind === 'member') {
    for (const ep of endpoints) {
      const distance = ep === 'START' ? distanceStart : distanceEnd;
      const distanceError = validatePositiveDistance(
        distance,
        family === 'column'
          ? ep === 'START'
            ? '柱脚側継手距離'
            : '柱頭側継手距離'
          : ep === 'START'
            ? '始端側継手距離'
            : '終端側継手距離',
      );
      if (distanceError) return { success: false, error: distanceError };
      const kind = ep === 'START' ? kindStart : kindEnd;
      if (kind && !JOINT_KINDS_202.has(String(kind))) {
        return { success: false, error: '継手種別は BOLT / WBOLT / WELD を指定してください' };
      }
    }
  }

  const changes = [];
  for (const ep of endpoints) {
    const suffix = endpointSuffix202(family, ep);
    setTrackedAttribute(target, `joint_id_${suffix}`, String(jointId), changes);
    if (targetKind === 'member') {
      setTrackedAttribute(
        target,
        `joint_${suffix}`,
        ep === 'START' ? distanceStart : distanceEnd,
        changes,
        { skipBlank: true },
      );
      setTrackedAttribute(
        target,
        `kind_joint_${suffix}`,
        ep === 'START' ? kindStart : kindEnd,
        changes,
        { skipBlank: true },
      );
    }
  }

  if (changes.length === 0) {
    return { success: false, error: '選択した割当内容は既に設定済みです' };
  }

  const modifications = getModifications();
  let removeJointOnUndo = false;
  if (combineWithCreation) {
    const last = modifications[modifications.length - 1];
    if (
      last?.op === 'add' &&
      last.tagName === jointTag &&
      String(last.id) === String(jointId)
    ) {
      modifications.pop();
      removeJointOnUndo = true;
    }
  }

  modifications.push({
    op: 'assignJoint202',
    jointTag,
    jointId: String(jointId),
    removeJointOnUndo,
    ...targetDescriptor,
    changes,
  });
  emitStructuralChange(emitType, String(targetId));
  updateEditingSummary();
  showSuccess(
    `${jointTag} #${jointId} を ${targetKind === 'member' ? `${targetTag} #${targetId}` : `${targetTag} #${targetId} の ${figureTag}`} へ割り当てました`,
  );
  return { success: true, jointId: String(jointId), changes };
}

function ensureJointArrangementContainer(doc) {
  const members = doc.querySelector('StbModel > StbMembers');
  if (!members) return null;
  let container = findDirectChild(members, 'StbJointArrangements');
  if (container) return container;

  const ns = members.namespaceURI;
  container = ns
    ? doc.createElementNS(ns, 'StbJointArrangements')
    : doc.createElement('StbJointArrangements');
  const laterTags = new Set(['StbPanelZoneArrangements', 'StbConnectionArrangements']);
  const before = Array.from(members.children || []).find((child) => laterTags.has(child.tagName));
  if (before) members.insertBefore(container, before);
  else members.appendChild(container);
  return container;
}

/** ST-Bridge 2.1.x の StbJointArrangement を対象部材へ追加する。 */
export function addJointArrangement({ memberTag, memberId, attrs = {} }) {
  const doc = getState('models.documentA');
  if (!doc) return { success: false, id: null, error: 'モデルAが読み込まれていません' };

  const kindMember = MEMBER_KIND_BY_TAG[memberTag];
  if (!kindMember) return { success: false, id: null, error: '継手を配置できない部材種別です' };
  const member = doc.querySelector(selectorById(memberTag, memberId));
  if (!member) return { success: false, id: null, error: `${memberTag} #${memberId} が見つかりません` };
  const idSection = member.getAttribute('id_section');
  if (!idSection) return { success: false, id: null, error: '対象部材に id_section がありません' };

  const startingPoint = String(attrs.starting_point || '').trim();
  if (!['START', 'END'].includes(startingPoint)) {
    return { success: false, id: null, error: 'starting_point は START または END を指定してください' };
  }
  if (attrs.distance === undefined || attrs.distance === null || String(attrs.distance).trim() === '') {
    return { success: false, id: null, error: 'distance を入力してください' };
  }
  if (!Number.isFinite(Number(attrs.distance))) {
    return { success: false, id: null, error: 'distance は数値で入力してください' };
  }

  const container = ensureJointArrangementContainer(doc);
  if (!container) return { success: false, id: null, error: 'StbMembers が見つかりません' };
  const id = generateNextId(doc, 'StbJointArrangement');
  const ns = container.namespaceURI;
  const arrangement = ns
    ? doc.createElementNS(ns, 'StbJointArrangement')
    : doc.createElement('StbJointArrangement');
  arrangement.setAttribute('id', id);
  if (attrs.name) arrangement.setAttribute('name', String(attrs.name));
  arrangement.setAttribute('id_section', idSection);
  arrangement.setAttribute('kind_member', kindMember);
  arrangement.setAttribute('id_member', String(memberId));
  arrangement.setAttribute('starting_point', startingPoint);
  arrangement.setAttribute('distance', String(attrs.distance));
  container.appendChild(arrangement);

  getModifications().push({
    op: 'addJointArrangement',
    elementType: 'JointArrangement',
    id,
    tagName: 'StbJointArrangement',
    memberTag,
    memberId: String(memberId),
  });
  emitStructuralChange('JointArrangement', id);
  emitStructuralChange(memberTag.slice(3), String(memberId));
  updateEditingSummary();
  showSuccess(`StbJointArrangement #${id} を ${memberTag} #${memberId} に追加しました`);
  return { success: true, id, tagName: 'StbJointArrangement' };
}
