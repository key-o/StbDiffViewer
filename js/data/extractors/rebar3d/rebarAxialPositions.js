/**
 * @fileoverview Hoop/stirrup section-layout axial station materialization.
 *
 * Viewer and detailing facts must use the same centered pitch phase. Keep this pure and
 * Three.js independent so production planners can reuse the exact displayed station contract.
 */

const EPS = 1e-9;

export function spreadCenteredAxialPositions(segmentStartMm, segmentLengthMm, pitchMm) {
  const start = Number(segmentStartMm);
  const length = Number(segmentLengthMm);
  const pitch = Number(pitchMm);
  if (!Number.isFinite(start) || !(length > 0) || !(pitch > 0)) return [];

  const count = Math.max(1, Math.floor(length / pitch));
  const spread = (count - 1) * pitch;
  const first = start + (length - spread) / 2;
  return Array.from({ length: count }, (_, index) => first + index * pitch);
}

function loopDiameters(segment) {
  return (segment?.loops || [])
    .map((loop) => Number(loop?.dia))
    .filter((value) => Number.isFinite(value) && value > 0);
}

/**
 * Section-ratio hoop layoutをmember始端基準mmへ展開する。
 * RebarGeneratorのlegacy loop phaseと同一の centered-spacing ruleを使う。
 */
export function materializeHoopAxialPositions(layout, memberLengthMm) {
  const length = Number(memberLengthMm);
  if (!layout?.segments?.length || !(length > 0)) return [];

  const positions = [];
  layout.segments.forEach((segment, segmentIndex) => {
    const startRatio = Number(segment?.startRatio);
    const endRatio = Number(segment?.endRatio);
    const pitchMm = Number(segment?.pitch);
    if (
      !Number.isFinite(startRatio) ||
      !Number.isFinite(endRatio) ||
      !(endRatio > startRatio) ||
      !(pitchMm > 0)
    ) {
      return;
    }

    let fromStartValues = [];
    if (segment?.exactAxialPosition === true && Number.isFinite(Number(segment?.positionRatio))) {
      fromStartValues = [Number(segment.positionRatio) * length];
    } else {
      const segmentStartMm = startRatio * length;
      const segmentLengthMm = (endRatio - startRatio) * length;
      fromStartValues = spreadCenteredAxialPositions(segmentStartMm, segmentLengthMm, pitchMm);
    }

    const diaMm = loopDiameters(segment);
    for (const fromStartMm of fromStartValues) {
      if (fromStartMm < -EPS || fromStartMm > length + EPS || !Number.isFinite(fromStartMm)) {
        continue;
      }
      positions.push({
        fromStartMm,
        localZMm: fromStartMm - length / 2,
        segmentIndex,
        positionZone: segment?.positionZone || null,
        pitchMm,
        diaMm,
        grade: segment?.grade || null,
        exactAxialPosition: segment?.exactAxialPosition === true,
      });
    }
  });

  return positions.sort((a, b) => {
    if (Math.abs(a.fromStartMm - b.fromStartMm) > EPS) {
      return a.fromStartMm - b.fromStartMm;
    }
    return a.segmentIndex - b.segmentIndex;
  });
}
