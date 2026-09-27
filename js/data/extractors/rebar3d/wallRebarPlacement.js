/**
 * @fileoverview ST-Bridge RC壁配筋の3D RenderPlanを構築する。
 *
 * 推測で施工詳細を補わない。位置を一意に決められないケースは
 * SPECIAL_REQUIRED として部材単位でfail-closedする。
 * 壁開口はST-Bridgeの開口矩形で主筋を切り欠き、開口補強筋は
 * StbSecOpen_RCを優先し、未指定時のみ壁断面共通の開口補強筋を用いる。
 *
 * @module data/extractors/rebar3d/wallRebarPlacement
 */

import { collectWallRebarFacts, getWallRebarCoverOverride } from './wallRebarSectionFacts.js';
import { buildWallFrame, buildWallRebarPaths } from './wallRebarGeometry.js';
import { applyWallRebarLayering, validateWallRebarLayering } from './wallRebarLayering.js';

function stableSerialize(value) {
  if (value === undefined) return '"<undefined>"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([key, entryValue]) => [stableSerialize(key), stableSerialize(entryValue)])
      .sort(([left], [right]) => left.localeCompare(right));
    return `{"$map":[${entries.map(([key, entryValue]) => `[${key},${entryValue}]`).join(',')}]}`;
  }
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
    .join(',')}}`;
}

function fingerprintText(value) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * 壁配筋render planの生成元を同一memberの現行STB factsと照合するためのfingerprint。
 */
export function getWallRebarSourceFingerprint(facts, memberId) {
  const walls = (facts?.walls || []).filter((wall) => String(wall?.id) === String(memberId));
  if (walls.length !== 1) return null;

  const wall = walls[0];
  const section = facts?.sections?.get?.(String(wall.sectionId));
  if (!section) return null;
  const nodeIds = (wall.nodeIds || []).map(String);
  const sourceData = {
    wall: {
      id: wall.id,
      name: wall.name,
      sectionId: wall.sectionId,
      nodeIds,
      offsets: wall.offsets,
      typeOutside: wall.typeOutside,
      kindWall: wall.kindWall,
      kindLayout: wall.kindLayout,
      openings: wall.openings,
      hasOpening: wall.hasOpening,
      hasFukashi: wall.hasFukashi,
      hasSlit: wall.hasSlit,
    },
    section,
    nodes: nodeIds.map((id) => facts?.nodes?.get?.(id) || null),
  };
  return fingerprintText(stableSerialize(sourceData));
}

function referencePointsForWall(wall, nodes) {
  const points = [];
  for (const id of wall.nodeIds) {
    const node = nodes.get(String(id));
    if (!node) return null;
    const offset = wall.offsets.get(String(id)) || { x: 0, y: 0, z: 0 };
    points.push({
      x: node.x + offset.x,
      y: node.y + offset.y,
      z: node.z + offset.z,
    });
  }
  return points;
}

function isFiniteCover(value) {
  return Number.isFinite(value) && value >= 0;
}

function special(wall, section, code) {
  return {
    memberType: 'wall',
    memberId: wall.id,
    sectionId: section?.id || wall.sectionId || null,
    status: 'SPECIAL_REQUIRED',
    code,
    specialRequired: true,
  };
}

function validateWall(wall, section, points) {
  if (!section) return 'WALL_REBAR_SECTION_NOT_FOUND';
  if (section.specialCode) return section.specialCode;
  if (section.shape?.type !== 'STRAIGHT') return 'WALL_REBAR_TAPER_UNSUPPORTED';
  if (wall.nodeIds.length < 3 || !points) return 'WALL_REBAR_REFERENCE_GEOMETRY_INVALID';
  if (wall.hasFukashi) return 'WALL_REBAR_FUKASHI_DETAIL_REQUIRED';
  if (wall.hasSlit) return 'WALL_REBAR_SLIT_DETAIL_REQUIRED';
  if (section.hasEdgeBars) return 'WALL_REBAR_EDGE_DETAIL_REQUIRED';
  const openingError = wall.openings.find((opening) => opening.specialCode)?.specialCode;
  if (openingError) return openingError;

  if (section.pattern !== 'SINGLE') {
    if (!isFiniteCover(section.covers.outsideMm) || !isFiniteCover(section.covers.insideMm)) {
      return 'WALL_REBAR_COVER_UNRESOLVED';
    }
  }
  const hasOutsideDirection = ['TYPE_PLUS', 'TYPE_MINUS'].includes(wall.typeOutside);
  const asymmetricCover =
    isFiniteCover(section.covers.outsideMm) &&
    isFiniteCover(section.covers.insideMm) &&
    Math.abs(section.covers.outsideMm - section.covers.insideMm) > 1e-9;
  if ((section.pattern === 'INSIDE_OUTSIDE' || asymmetricCover) && !hasOutsideDirection) {
    return 'WALL_REBAR_OUTSIDE_DIRECTION_UNRESOLVED';
  }
  const layeringCode = validateWallRebarLayering(section, wall.typeOutside);
  if (layeringCode) return layeringCode;
  return null;
}

/**
 * @returns {{paths:Array, checks:Array, readyCount:number, specialCount:number}}
 */
export function buildWallRebarRenderPlan(xmlDoc, options = {}) {
  const facts = collectWallRebarFacts(xmlDoc, options);
  const paths = [];
  const checks = [];

  for (const wall of facts.walls) {
    const section = facts.sections.get(String(wall.sectionId));
    const points = referencePointsForWall(wall, facts.nodes);
    const validationCode = validateWall(wall, section, points);
    if (validationCode) {
      checks.push(special(wall, section, validationCode));
      continue;
    }

    const frame = buildWallFrame(points);
    if (!frame) {
      checks.push(special(wall, section, 'WALL_REBAR_REFERENCE_PLANE_INVALID'));
      continue;
    }

    const rawMemberPaths = buildWallRebarPaths({
      frame,
      section,
      memberId: wall.id,
      typeOutside: wall.typeOutside,
      openings: wall.openings,
    });
    const memberPaths = applyWallRebarLayering(rawMemberPaths, { frame, section });
    if (memberPaths.length === 0) {
      checks.push(special(wall, section, 'WALL_REBAR_NO_RENDERABLE_PATH'));
      continue;
    }

    paths.push(...memberPaths);
    const openingPathCount = memberPaths.filter(
      (path) => path.metadata.role === 'wallOpening',
    ).length;
    checks.push({
      memberType: 'wall',
      memberId: wall.id,
      sectionId: section.id,
      status: 'READY',
      code: 'WALL_REBAR_READY',
      specialRequired: false,
      pattern: section.pattern,
      pathCount: memberPaths.length,
      openingCount: wall.openings.length,
      openingPathCount,
    });
  }

  const modelSource =
    options?.modelSource === null || options?.modelSource === undefined
      ? null
      : String(options.modelSource).trim() || null;

  return {
    paths,
    checks,
    readyCount: checks.filter((check) => check.status === 'READY').length,
    specialCount: checks.filter((check) => check.specialRequired).length,
    provenance: Object.freeze({
      modelSource,
      coverMm: getWallRebarCoverOverride(options),
      wallSourceFingerprints: Object.freeze(
        Object.fromEntries(
          facts.walls.map((wall) => [
            String(wall.id),
            getWallRebarSourceFingerprint(facts, wall.id),
          ]),
        ),
      ),
    }),
  };
}

export const __testOnly = { referencePointsForWall, validateWall };
