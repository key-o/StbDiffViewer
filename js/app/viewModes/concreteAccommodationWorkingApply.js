/**
 * @fileoverview accepted FACE_OFFSETふかしをWorking Documentへ可逆適用する。
 *
 * ST-Bridge標準属性へ一意に還元できる候補だけを対象とし、EditingSessionの
 * SetAttributeCommandへ載せる。source documentは変更せず、Undo/Redo可能とする。
 */

import editingSession from '../editing/editingSession.js';
import { findElementByTagAndId } from '../editing/attributeCommandUtils.js';
import { createConcreteAccommodationExtensionCommand } from '../editing/concreteAccommodationExtensionCommand.js';
import {
  buildStbLocalPrismExtensionEntry,
  findStbLocalPrismExtensionEntry,
} from '../../data/extractors/rebar3d/concreteAccommodationStbExtension.js';

const FACE_ATTRIBUTES = new Set([
  'thickness_add_top',
  'thickness_add_bottom',
  'thickness_add_right',
  'thickness_add_left',
]);
const HOST_TO_ELEMENT_TYPE = Object.freeze({
  StbBeam: 'Beam',
  StbGirder: 'Girder',
});
const EPS = 1e-6;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatMm(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number
    .toFixed(6)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
}

function failure(reason, extra = {}) {
  return { ok: false, changed: false, reason, ...extra };
}

function accepted(evaluation) {
  if (evaluation?.decisionStatus !== undefined && evaluation?.decisionStatus !== null) {
    return evaluation.decisionStatus === 'ACCEPTED';
  }
  return evaluation?.candidate?.status === 'ACCEPTED';
}

function workingMemberValue(element, attribute) {
  if (!element) return null;
  if (!element.hasAttribute(attribute)) return 0;
  return finiteNonNegative(element.getAttribute(attribute));
}

/**
 * UI/command共通の適用可否判定。
 */
export function inspectConcreteAccommodationWorkingApply({
  evaluation,
  modelSource = null,
  session = editingSession,
} = {}) {
  if (!evaluation) return failure('fukashi-working-evaluation-missing');
  if (String(modelSource || '') !== 'A') {
    return failure('fukashi-working-model-source-unsupported', { modelSource });
  }
  if (!accepted(evaluation)) {
    return failure('fukashi-working-approval-required');
  }

  const patch = evaluation.stbExportCandidate;
  if (!patch?.resolved || patch.exportable !== true) {
    return failure(patch?.reason || 'fukashi-working-export-candidate-unavailable', {
      patch: patch || null,
    });
  }
  if (evaluation?.candidate?.mode !== 'FACE_OFFSET') {
    return failure('fukashi-working-face-offset-required', { patch });
  }
  if (patch.candidateId && patch.candidateId !== evaluation.candidate.id) {
    return failure('fukashi-working-candidate-mismatch', { patch });
  }
  if (!HOST_TO_ELEMENT_TYPE[patch.hostMemberTag]) {
    return failure('fukashi-working-host-tag-unsupported', { patch });
  }
  if (!FACE_ATTRIBUTES.has(patch.attribute)) {
    return failure('fukashi-working-attribute-unsupported', { patch });
  }
  if (!patch.hostMemberId) {
    return failure('fukashi-working-host-id-missing', { patch });
  }

  const existingMm = finiteNonNegative(patch.existingMm);
  const incrementMm = Number(patch.incrementMm);
  const valueMm = finiteNonNegative(patch.valueMm);
  if (
    existingMm === null ||
    !(Number.isFinite(incrementMm) && incrementMm > 0) ||
    valueMm === null ||
    Math.abs(existingMm + incrementMm - valueMm) > EPS
  ) {
    return failure('fukashi-working-patch-invalid', { patch });
  }

  const state = session?.getState?.();
  if (!state?.active || !state.workingDocument) {
    return failure('fukashi-working-session-required', { patch });
  }

  const element = findElementByTagAndId(
    state.workingDocument,
    patch.hostMemberTag,
    patch.hostMemberId,
  );
  if (!element) {
    return failure('fukashi-working-host-not-found', { patch });
  }

  const currentMm = workingMemberValue(element, patch.attribute);
  if (currentMm === null) {
    return failure('fukashi-working-current-value-invalid', { patch });
  }
  if (Math.abs(currentMm - valueMm) <= EPS) {
    return {
      ok: true,
      changed: false,
      reason: 'ALREADY_APPLIED',
      patch,
      currentMm,
      elementType: HOST_TO_ELEMENT_TYPE[patch.hostMemberTag],
      nextValue: formatMm(valueMm),
    };
  }
  if (Math.abs(currentMm - existingMm) > EPS) {
    return failure('fukashi-working-stale-evaluation', {
      patch,
      currentMm,
      expectedExistingMm: existingMm,
    });
  }

  return {
    ok: true,
    changed: null,
    reason: null,
    patch,
    currentMm,
    elementType: HOST_TO_ELEMENT_TYPE[patch.hostMemberTag],
    nextValue: formatMm(valueMm),
  };
}

/**
 * accepted FACE_OFFSETを1つのSetAttributeCommandとしてWorking Documentへ適用する。
 */
export function applyAcceptedConcreteAccommodationToWorkingDocument({
  evaluation,
  modelSource = null,
  session = editingSession,
} = {}) {
  const inspection = inspectConcreteAccommodationWorkingApply({
    evaluation,
    modelSource,
    session,
  });
  if (!inspection.ok || inspection.changed === false) return inspection;

  const { patch, elementType, nextValue } = inspection;
  const result = session.setAttribute(elementType, patch.hostMemberId, patch.attribute, nextValue, {
    label: `${patch.hostMemberTag} ${patch.hostMemberId} の ${patch.attribute} にふかし +${formatMm(
      patch.incrementMm,
    )}mm を適用`,
    reason: 'concreteAccommodationFaceOffsetApply',
    validate: ({ workingDocument }) => {
      const element = findElementByTagAndId(
        workingDocument,
        patch.hostMemberTag,
        patch.hostMemberId,
      );
      const current = workingMemberValue(element, patch.attribute);
      return current !== null && Math.abs(current - Number(patch.valueMm)) <= EPS;
    },
  });

  return {
    ok: true,
    changed: result.changed === true,
    reason: result.changed ? null : 'ALREADY_APPLIED',
    patch,
    command: result.command,
    revision: result.revision,
    affectedElements: result.affectedElements,
  };
}

export const CONCRETE_ACCOMMODATION_WORKING_FACE_ATTRIBUTES = Object.freeze([...FACE_ATTRIBUTES]);

function extensionPropertiesEqual(existing, entry) {
  if (!existing || !entry) return false;
  if (
    existing.objectName !== entry.objectName ||
    String(existing.idObject) !== String(entry.idObject) ||
    existing.candidateId !== entry.candidateId
  ) {
    return false;
  }
  for (const property of entry.properties || []) {
    const current = existing.properties?.get?.(property.key);
    if (!current || current.type !== property.type || current.value !== property.value)
      return false;
  }
  return existing.properties?.size === entry.properties.length;
}

export function inspectConcreteAccommodationLocalPrismWorkingApply({
  evaluation,
  modelSource = null,
  session = editingSession,
} = {}) {
  const built = buildStbLocalPrismExtensionEntry({ evaluation, modelSource });
  if (!built.persistable || !built.entry) {
    return failure(built.reason || 'local-prism-extension-not-persistable', {
      extensionResolution: built,
    });
  }

  const state = session?.getState?.();
  if (!state?.active || !state.workingDocument) {
    return failure('fukashi-working-session-required', { entry: built.entry });
  }

  const host = findElementByTagAndId(
    state.workingDocument,
    built.entry.objectName,
    built.entry.idObject,
  );
  if (!host) {
    return failure('local-prism-extension-host-not-found', { entry: built.entry });
  }

  const existing = findStbLocalPrismExtensionEntry(state.workingDocument, built.entry.candidateId);
  if (existing && extensionPropertiesEqual(existing, built.entry)) {
    return {
      ok: true,
      changed: false,
      reason: 'ALREADY_APPLIED',
      entry: built.entry,
      existing,
    };
  }

  return {
    ok: true,
    changed: null,
    reason: null,
    entry: built.entry,
    existing,
  };
}

export function applyAcceptedLocalPrismToWorkingDocument({
  evaluation,
  modelSource = null,
  session = editingSession,
} = {}) {
  const inspection = inspectConcreteAccommodationLocalPrismWorkingApply({
    evaluation,
    modelSource,
    session,
  });
  if (!inspection.ok || inspection.changed === false) return inspection;

  const state = session.getState();
  const command = createConcreteAccommodationExtensionCommand(
    state.workingDocument,
    inspection.entry,
    {
      label: `LOCAL_PRISM ${inspection.entry.candidateId} をStbExtensionへ保存`,
    },
  );
  if (command.isNoop) {
    return {
      ok: true,
      changed: false,
      reason: 'ALREADY_APPLIED',
      entry: inspection.entry,
    };
  }

  const result = session.executeCommand(command, {
    reason: 'concreteAccommodationLocalPrismExtensionApply',
    validate: ({ workingDocument }) => {
      const persisted = findStbLocalPrismExtensionEntry(
        workingDocument,
        inspection.entry.candidateId,
      );
      return extensionPropertiesEqual(persisted, inspection.entry);
    },
  });

  return {
    ok: true,
    changed: result.changed === true,
    reason: result.changed ? null : 'ALREADY_APPLIED',
    entry: inspection.entry,
    command: result.command,
    revision: result.revision,
    affectedElements: result.affectedElements,
  };
}
