/**
 * @fileoverview RC壁主筋のsemantic identity / topology sidecarを構築する。
 *
 * Phase 6a-Aではproduction RebarPathを変更しない。既存wallMain pathのmetadataと
 * identityKeyを読み取り、world座標に依存しないsemantic factsへ正規化する。
 * 開口等で1本の主筋が複数segmentへ分割された場合も、同じsemanticIdentityを共有する。
 */

const WALL_DIRECTIONS = new Set(['VERTICAL', 'HORIZONTAL']);
const WALL_PATTERNS = new Set(['SINGLE', 'ZIGZAG', 'DOUBLE_NET', 'INSIDE_OUTSIDE']);
const WALL_FACES = new Set(['CENTER', 'PLUS', 'MINUS', 'OUTSIDE', 'INSIDE', 'ZIGZAG']);

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function finitePositiveOrNull(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function identityToken(value) {
  return encodeURIComponent(textOrNull(value) || '-');
}

/**
 * Current wallMain identityKey contractを読み取る。
 * identityKey自体は変更しない。
 */
export function parseWallMainIdentityKey(identityKey) {
  const raw = textOrNull(identityKey);
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length !== 7 || parts[0] !== 'wall') return null;
  const [, memberId, direction, face, barIndexRaw, segmentIndexRaw, diaRaw] = parts;
  const barIndex = Number(barIndexRaw);
  const segmentIndex = Number(segmentIndexRaw);
  const diaMm = Number(diaRaw);
  if (
    !memberId ||
    !WALL_DIRECTIONS.has(direction) ||
    !WALL_FACES.has(face) ||
    !Number.isInteger(barIndex) ||
    barIndex < 0 ||
    !Number.isInteger(segmentIndex) ||
    segmentIndex < 0 ||
    !Number.isFinite(diaMm) ||
    diaMm <= 0
  ) {
    return null;
  }
  return Object.freeze({ memberId, direction, face, barIndex, segmentIndex, diaMm });
}

function normalizedOpeningMemberIds(openingMemberIds) {
  if (!openingMemberIds) return new Set();
  if (openingMemberIds instanceof Set) {
    return new Set([...openingMemberIds].map((value) => String(value)));
  }
  if (Array.isArray(openingMemberIds)) {
    return new Set(openingMemberIds.map((value) => String(value)));
  }
  return new Set();
}

function semanticIdentityFor({
  modelSource,
  memberId,
  direction,
  pattern,
  face,
  layer,
  barIndex,
  diaName,
  diaMm,
  grade,
}) {
  return [
    'wall',
    identityToken(modelSource),
    identityToken(memberId),
    'wallMain',
    direction,
    pattern,
    face,
    `L${layer}`,
    `B${barIndex}`,
    identityToken(diaName || `D${diaMm}`),
    identityToken(grade),
  ].join(':');
}

function unresolvedPath(path, index, reason, modelSource) {
  return Object.freeze({
    memberType: 'wall',
    role: 'wallMain',
    modelSource: textOrNull(modelSource),
    pathIndex: index,
    sourceIdentityKey: textOrNull(path?.metadata?.identityKey),
    memberId: textOrNull(path?.metadata?.memberId),
    reason,
  });
}

function compareFacts(a, b) {
  return (
    a.semanticIdentity.localeCompare(b.semanticIdentity) ||
    a.segmentIndex - b.segmentIndex ||
    a.sourceIdentityKey.localeCompare(b.sourceIdentityKey)
  );
}

/**
 * wallMain RebarPath[]からworld座標非依存のsemantic factsを構築する。
 * 入力pathは一切変更しない。
 *
 * @returns {{facts:ReadonlyArray<object>, unresolved:ReadonlyArray<object>}}
 */
export function buildWallRebarSemanticFacts(
  paths,
  { modelSource = null, openingMemberIds = null } = {},
) {
  const sourcePaths = Array.isArray(paths) ? paths : [];
  const openingIds = normalizedOpeningMemberIds(openingMemberIds);
  const candidates = [];
  const unresolved = [];

  sourcePaths.forEach((path, pathIndex) => {
    const metadata = path?.metadata || {};
    if (metadata.memberType !== 'wall' || metadata.role !== 'wallMain') return;

    const parsed = parseWallMainIdentityKey(metadata.identityKey);
    if (!parsed) {
      unresolved.push(
        unresolvedPath(path, pathIndex, 'wall-main-identity-key-unresolved', modelSource),
      );
      return;
    }

    const memberId = textOrNull(metadata.memberId);
    const sectionId = textOrNull(metadata.sectionId);
    const direction = textOrNull(metadata.direction);
    const pattern = textOrNull(metadata.pattern);
    const face = textOrNull(metadata.face);
    const diaMm = finitePositiveOrNull(metadata.dia);
    const diaName = textOrNull(metadata.diaName);
    const grade = textOrNull(metadata.strength);

    if (
      !memberId ||
      memberId !== parsed.memberId ||
      !WALL_DIRECTIONS.has(direction) ||
      direction !== parsed.direction ||
      !WALL_PATTERNS.has(pattern) ||
      !WALL_FACES.has(face) ||
      face !== parsed.face ||
      diaMm === null ||
      Math.abs(diaMm - parsed.diaMm) > 1e-9
    ) {
      unresolved.push(
        unresolvedPath(path, pathIndex, 'wall-main-semantic-metadata-invalid', modelSource),
      );
      return;
    }

    const layer = 1;
    const semanticIdentity = semanticIdentityFor({
      modelSource,
      memberId,
      direction,
      pattern,
      face,
      layer,
      barIndex: parsed.barIndex,
      diaName,
      diaMm,
      grade,
    });

    candidates.push({
      modelSource: textOrNull(modelSource),
      memberType: 'wall',
      memberId,
      sectionId,
      role: 'wallMain',
      direction,
      pattern,
      face,
      layer,
      dia: diaMm,
      diaName,
      grade,
      barIndex: parsed.barIndex,
      segmentIndex: parsed.segmentIndex,
      semanticIdentity,
      sourceIdentityKey: String(metadata.identityKey),
    });
  });

  const groupCounts = new Map();
  for (const value of candidates) {
    groupCounts.set(value.semanticIdentity, (groupCounts.get(value.semanticIdentity) || 0) + 1);
  }

  const facts = candidates
    .map((value) => {
      const segmentCount = groupCounts.get(value.semanticIdentity) || 1;
      const split = segmentCount > 1;
      const segmentRole = !split
        ? 'FULL'
        : openingIds.has(value.memberId)
          ? 'OPENING_SPLIT'
          : 'BOUNDARY_SEGMENT';
      return Object.freeze({
        ...value,
        segmentCount,
        segmentRole,
        segmentIdentity: `${value.semanticIdentity}:S${value.segmentIndex}`,
      });
    })
    .sort(compareFacts);

  unresolved.sort((a, b) => {
    const am = a.memberId || '';
    const bm = b.memberId || '';
    return am.localeCompare(bm) || a.pathIndex - b.pathIndex;
  });

  return Object.freeze({
    facts: Object.freeze(facts),
    unresolved: Object.freeze(unresolved),
  });
}

/**
 * buildWallRebarRenderPlan()のsidecarとしてsemantic snapshotを作る。
 * render plan本体には書き戻さない。
 */
export function buildWallRebarTopologySnapshot(renderPlan, { modelSource = null } = {}) {
  const checks = Array.isArray(renderPlan?.checks) ? renderPlan.checks : [];
  const openingMemberIds = new Set(
    checks
      .filter((check) => Number(check?.openingCount) > 0)
      .map((check) => String(check.memberId)),
  );
  return buildWallRebarSemanticFacts(renderPlan?.paths || [], {
    modelSource,
    openingMemberIds,
  });
}
