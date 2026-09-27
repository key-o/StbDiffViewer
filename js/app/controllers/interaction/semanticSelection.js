/**
 * @fileoverview Three.js object参照から独立した semantic selection identity
 *
 * scene object は局所再生成で差し替わるため、選択の意味は ST-Bridge 要素 identity として保持する。
 * Object3D は現在の表示参照にすぎず、この identity を編集・Grip・Property panel 共通契約として使う。
 */

import { normalizeSelectedElementType, normalizeSelectionModelSide } from './selectionInfoUtils.js';

function optionalString(value) {
  if (value === null || value === undefined || String(value) === '') return null;
  return String(value);
}

function canonicalElementId(userData, modelSource) {
  const side = normalizeSelectionModelSide(modelSource);
  if (side === 'A') {
    return optionalString(userData?.elementIdA ?? userData?.elementId);
  }
  if (side === 'B') {
    return optionalString(userData?.elementIdB ?? userData?.elementId);
  }

  // matched 等では編集対象の Model A identity を優先する。
  return optionalString(userData?.elementIdA ?? userData?.elementId ?? userData?.elementIdB);
}

export function createSemanticSelectionIdentity(userData, overrides = {}) {
  const elementType = optionalString(
    overrides.elementType ?? normalizeSelectedElementType(userData),
  );
  const modelSource = optionalString(overrides.modelSource ?? userData?.modelSource);
  const elementId = optionalString(
    overrides.elementId ?? canonicalElementId(userData, modelSource),
  );

  if (!elementType || !elementId) return null;

  return Object.freeze({
    elementType,
    elementId,
    modelSource,
    elementIdA: optionalString(overrides.elementIdA ?? userData?.elementIdA),
    elementIdB: optionalString(overrides.elementIdB ?? userData?.elementIdB),
    subType: optionalString(overrides.subType),
    subId: optionalString(overrides.subId),
  });
}

export function semanticSelectionIdentityKey(identity) {
  if (!identity?.elementType || identity.elementId === undefined || identity.elementId === null) {
    return null;
  }
  return JSON.stringify([
    String(identity.elementType),
    String(identity.elementId),
    optionalString(identity.modelSource),
    optionalString(identity.elementIdA),
    optionalString(identity.elementIdB),
    optionalString(identity.subType),
    optionalString(identity.subId),
  ]);
}

export function sameSemanticSelectionIdentity(a, b) {
  const keyA = semanticSelectionIdentityKey(a);
  const keyB = semanticSelectionIdentityKey(b);
  return keyA !== null && keyA === keyB;
}

export function cloneSemanticSelectionIdentity(identity) {
  if (!identity) return null;
  return {
    elementType: identity.elementType,
    elementId: identity.elementId,
    modelSource: identity.modelSource ?? null,
    elementIdA: identity.elementIdA ?? null,
    elementIdB: identity.elementIdB ?? null,
    subType: identity.subType ?? null,
    subId: identity.subId ?? null,
  };
}
