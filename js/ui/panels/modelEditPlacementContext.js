/**
 * @fileoverview モデル編集リボンの配置基準コンテキスト。
 *
 * Revit の作業面に近い概念として、節点配置時の基準を Story / X通り / Y通り /
 * StbGirder / StbBeam / StbSlab / 自由配置から選択できるようにする。
 * ここでは UI 用の配置コンテキストだけを管理し、XML mutation 自体は AddMemberForm /
 * EditingSession の既存経路へ委譲する。
 */

import editDocumentProvider from '../../app/editing/editDocumentProvider.js';
import { getState } from '../../data/state/globalState.js';

export const PLACEMENT_TYPES = Object.freeze([
  { value: 'story', label: '階 (Story)' },
  { value: 'x-axis', label: 'X通り' },
  { value: 'y-axis', label: 'Y通り' },
  { value: 'girder', label: '大梁上' },
  { value: 'beam', label: '小梁上' },
  { value: 'slab', label: '床上' },
  { value: 'free', label: '自由' },
]);

const context = {
  type: 'story',
  targetId: null,
};

function stringValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

function activeDocument() {
  return editDocumentProvider.getActiveEditDocument?.() || null;
}

function memberTargets(tagName) {
  const document = activeDocument();
  if (!document) return [];
  return [...document.getElementsByTagName(tagName)].map((element) => {
    const id = stringValue(element.getAttribute('id'));
    const name = stringValue(element.getAttribute('name'));
    return {
      id,
      label: name ? `${name} (#${id})` : `${tagName} #${id}`,
      value: id,
    };
  });
}

function storyTargets() {
  const stories = getState('models.stories') || [];
  if (Array.isArray(stories) && stories.length > 0) {
    return stories.map((story) => ({
      id: stringValue(story.id),
      value: stringValue(story.id),
      label: story.name
        ? `${story.name}  Z=${Number(story.height || 0).toFixed(0)}`
        : stringValue(story.id),
      coordinate: Number(story.height || 0),
    }));
  }

  const document = activeDocument();
  if (!document) return [];
  return [...document.getElementsByTagName('StbStory')].map((story) => ({
    id: stringValue(story.getAttribute('id')),
    value: stringValue(story.getAttribute('id')),
    label: `${story.getAttribute('name') || `Story #${story.getAttribute('id')}`}  Z=${Number(story.getAttribute('height') || 0).toFixed(0)}`,
    coordinate: Number(story.getAttribute('height') || 0),
  }));
}

function axisTargets(axisKind) {
  const axesData = getState('models.axesData') || { xAxes: [], yAxes: [] };
  const axes = axisKind === 'x-axis' ? axesData.xAxes || [] : axesData.yAxes || [];
  return axes.map((axis) => ({
    id: stringValue(axis.id),
    value: stringValue(axis.id),
    label: `${axis.name || axis.id}  ${axisKind === 'x-axis' ? 'X' : 'Y'}=${Number(axis.distance || 0).toFixed(0)}`,
    coordinate: Number(axis.distance || 0),
  }));
}

export function getPlacementTargets(type = context.type) {
  switch (type) {
    case 'story':
      return storyTargets();
    case 'x-axis':
    case 'y-axis':
      return axisTargets(type);
    case 'girder':
      return memberTargets('StbGirder');
    case 'beam':
      return memberTargets('StbBeam');
    case 'slab':
      return memberTargets('StbSlab');
    case 'free':
    default:
      return [];
  }
}

export function setPlacementContext(type, targetId = null) {
  const validType = PLACEMENT_TYPES.some((entry) => entry.value === type) ? type : 'free';
  context.type = validType;
  const targets = getPlacementTargets(validType);
  const requested = targetId == null ? null : String(targetId);
  const found = requested ? targets.find((target) => String(target.id) === requested) : null;
  context.targetId = found?.id ?? targets[0]?.id ?? null;
  return getPlacementContext();
}

export function ensurePlacementContext() {
  let targets = getPlacementTargets(context.type);
  if (targets.length === 0 && context.type !== 'free') {
    for (const fallback of ['story', 'x-axis', 'y-axis', 'girder', 'beam', 'slab']) {
      targets = getPlacementTargets(fallback);
      if (targets.length > 0) {
        context.type = fallback;
        context.targetId = targets[0].id;
        return getPlacementContext();
      }
    }
    context.type = 'free';
    context.targetId = null;
    return getPlacementContext();
  }

  if (
    targets.length > 0 &&
    !targets.some((target) => String(target.id) === String(context.targetId))
  ) {
    context.targetId = targets[0].id;
  }
  return getPlacementContext();
}

export function getPlacementContext() {
  const targets = getPlacementTargets(context.type);
  const target = targets.find((entry) => String(entry.id) === String(context.targetId)) || null;
  return Object.freeze({
    type: context.type,
    targetId: context.targetId,
    targetLabel: target?.label || null,
    coordinate: Number.isFinite(target?.coordinate) ? target.coordinate : null,
  });
}

export function placementContextFromSelection(identity) {
  if (!identity?.elementType || identity.elementId == null) return null;
  const typeByElement = {
    Girder: 'girder',
    Beam: 'beam',
    Slab: 'slab',
  };
  const type = typeByElement[identity.elementType];
  if (!type) return null;
  return setPlacementContext(type, identity.elementId);
}

/**
 * 節点フォームの座標拘束と ST-Bridge semantic host 属性を返す。
 * Story/X/Y通りは作業面として座標1成分を拘束し、host 部材では kind/id_member を設定する。
 */
export function resolveNodePlacement(contextValue = getPlacementContext()) {
  switch (contextValue?.type) {
    case 'story':
      return {
        lockedCoordinates: Number.isFinite(contextValue.coordinate)
          ? { Z: contextValue.coordinate }
          : {},
        attributes: { kind: 'OTHER' },
      };
    case 'x-axis':
      return {
        lockedCoordinates: Number.isFinite(contextValue.coordinate)
          ? { X: contextValue.coordinate }
          : {},
        attributes: { kind: 'OTHER' },
      };
    case 'y-axis':
      return {
        lockedCoordinates: Number.isFinite(contextValue.coordinate)
          ? { Y: contextValue.coordinate }
          : {},
        attributes: { kind: 'OTHER' },
      };
    case 'girder':
      return {
        lockedCoordinates: {},
        attributes: contextValue.targetId
          ? { kind: 'ON_GIRDER', id_member: String(contextValue.targetId) }
          : { kind: 'OTHER' },
      };
    case 'beam':
      return {
        lockedCoordinates: {},
        attributes: contextValue.targetId
          ? { kind: 'ON_BEAM', id_member: String(contextValue.targetId) }
          : { kind: 'OTHER' },
      };
    case 'slab':
      return {
        lockedCoordinates: {},
        attributes: contextValue.targetId
          ? { kind: 'ON_SLAB', id_member: String(contextValue.targetId) }
          : { kind: 'OTHER' },
      };
    case 'free':
    default:
      return { lockedCoordinates: {}, attributes: { kind: 'OTHER' } };
  }
}
