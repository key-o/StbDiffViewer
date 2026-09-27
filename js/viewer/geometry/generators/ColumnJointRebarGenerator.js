/**
 * @fileoverview world座標RebarPathを既存の円柱インスタンス生成へ接続する。
 * RebarPath自体はLine/Arcを保持し、表示境界でのみArcをLine chordへ分割する。
 * 配筋ルールや曲げ半径をrenderer側で再解決せず、既存の共有geometry/material・本数上限を使う。
 */
import {
  rebarPathToLineSegments,
  validateRebarPath,
} from '../../../data/extractors/rebar3d/rebarPath.js';
import { createColumnRebarMeshes } from './RebarGenerator.js';

export function createColumnJointRebarMeshes(paths, options = {}) {
  const elements = [];
  const nodes = new Map();
  const layouts = new Map();
  for (const path of paths || []) {
    if (path?.metadata?.coordinateSpace !== 'world' || !validateRebarPath(path).ok) continue;
    const dia = Number(path.metadata.dia);
    if (!(dia > 0) || !Number.isFinite(dia)) continue;
    const lines = rebarPathToLineSegments(path, options.tessellation);
    if (!lines.length) continue;
    const sectionId = String(dia);
    if (!layouts.has(sectionId))
      layouts.set(sectionId, {
        segments: [{ startRatio: 0, endRatio: 1, bars: [{ u: 0, v: 0, dia }] }],
      });
    for (const line of lines) {
      const id = String(elements.length);
      nodes.set(`${id}:start`, line.start);
      nodes.set(`${id}:end`, line.end);
      elements.push({
        id,
        id_section: sectionId,
        id_node_bottom: `${id}:start`,
        id_node_top: `${id}:end`,
      });
    }
  }
  const meshes = createColumnRebarMeshes(elements, nodes, layouts, options);
  const rebarKind = options.rebarKind || 'columnTransition';
  for (const mesh of meshes) mesh.userData.rebarKind = rebarKind;
  return meshes;
}
