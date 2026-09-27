/**
 * @fileoverview Phase 5 arrangement Working Command compatibility barrel。
 *
 * OpenArrangement と JointArrangement は参照意味論が異なるため専用モジュールへ分離した。
 * 既存 direct import 互換のため public API だけを再exportする。
 */

export {
  addOpenWithAssignment,
  reassignOpenArrangement,
  deleteOpenArrangement,
} from './openArrangementWorkingCommand.js';

export {
  addJointArrangement,
  reassignJointArrangement,
  deleteJointArrangement,
  getCompatibleJointDefinitions21,
} from './jointArrangementPublicCommand.js';
