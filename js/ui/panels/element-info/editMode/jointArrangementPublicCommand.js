/**
 * @fileoverview StbJointArrangement public safety gate。
 *
 * 旧 jointAdd.js の 2.1.x legacy route は host member.id_section を JointArrangement.id_section
 * へ流用するため、正規仕様の「StbJoints の継手ID」参照と一致しない。public 2.1.x route は
 * Working Session を必須とし、typed Working Command だけを許可する。
 */

import editingSession from '../../../../app/editing/editingSession.js';
import {
  addJointArrangement as addTypedJointArrangement,
  deleteJointArrangement as deleteTypedJointArrangement,
  getCompatibleJointDefinitions21 as getTypedCompatibleJointDefinitions21,
  reassignJointArrangement as reassignTypedJointArrangement,
} from './jointArrangementWorkingCommand.js';

function inactiveResult(operation) {
  return {
    success: false,
    id: null,
    error: `${operation}は typed reference を保証するため Working Session 中のみ実行できます。`,
  };
}

export function addJointArrangement(input) {
  if (editingSession.getState()?.active !== true)
    return inactiveResult('StbJointArrangement の追加');
  return addTypedJointArrangement(input);
}

export function reassignJointArrangement(input) {
  if (editingSession.getState()?.active !== true)
    return inactiveResult('StbJointArrangement の再割当');
  return reassignTypedJointArrangement(input);
}

export function deleteJointArrangement(input) {
  if (editingSession.getState()?.active !== true)
    return inactiveResult('StbJointArrangement の削除');
  return deleteTypedJointArrangement(input);
}

export function getCompatibleJointDefinitions21(document, memberTag) {
  return getTypedCompatibleJointDefinitions21(document, memberTag);
}
