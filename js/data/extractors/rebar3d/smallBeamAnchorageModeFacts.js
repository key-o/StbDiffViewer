/**
 * @fileoverview R12-Q-D 小梁上端定着mode strategyをrequirement factsへ後段接続する。
 *
 * VERTICAL_90が選択可能な場合だけmodeを保持し、90°不成立時はalternativeRequiredのまま残す。
 * RebarPath生成・production可否・一般的な定着OK/NGはこの層で決めない。
 */

import { resolveSmallBeamTopAnchorageMode } from './smallBeamAnchorageModeStrategy.js';

export function attachSmallBeamTopAnchorageModeFacts(requirementFacts) {
  if (!requirementFacts?.beam) {
    return { ...(requirementFacts || {}), anchorageModeUnresolved: [] };
  }

  const anchorageModeUnresolved = [];
  for (const [elementId, beamFacts] of requirementFacts.beam) {
    for (const end of beamFacts?.ends || []) {
      if (end.status === 'FREE_END') continue;
      for (const group of end.requirements || []) {
        if (group.role !== 'top') continue;
        group.anchorageMode = resolveSmallBeamTopAnchorageMode({
          vertical90Candidate: group.vertical90Candidate,
        });
        if (group.requirement?.ok && group.anchorageMode?.resolved === false) {
          anchorageModeUnresolved.push({
            elementId,
            elementName: beamFacts.elementName,
            side: end.side,
            role: group.role,
            diaMm: group.diaMm,
            grade: group.grade,
            reason: group.anchorageMode.reason,
          });
        }
      }
    }
  }

  return {
    ...requirementFacts,
    anchorageModeUnresolved,
  };
}
