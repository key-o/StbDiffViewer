import { createLine, createRebarPath } from './rebarPath.js';
import { resolveReverseTMainSwitchIntervals } from './stripFootingMainSwitch.js';
import { querySelectorAll } from '../sectionListUtils.js';

const EPS = 1e-6;

function findSectionElement(xmlDoc, sectionId) {
  return (
    querySelectorAll(xmlDoc, 'StbSecFoundation_RC').find(
      (element) => String(element.getAttribute('id') || '') === String(sectionId || ''),
    ) || null
  );
}

function removeSwitchAttributes(element) {
  element?.removeAttribute?.('length');
  element?.removeAttribute?.('main_type');
}

export function transformSwitchDocument(xmlDoc, sectionId, tipFace = null) {
  const clone = xmlDoc?.cloneNode?.(true);
  if (!clone) return null;
  const section = findSectionElement(clone, sectionId);
  if (!section) return null;

  const targetTipPosition = tipFace ? `MAIN_TIP_${tipFace}` : null;
  const targetBasePosition = tipFace ? `MAIN_BASE_${tipFace}` : null;
  for (const element of querySelectorAll(section, 'StbSecBarFoundation_RC_Continuous')) {
    const position = String(element.getAttribute('pos') || '').toUpperCase();
    let remove = false;

    if (tipFace) {
      if (position === targetTipPosition) {
        element.setAttribute('pos', targetBasePosition);
      } else if (position.startsWith('MAIN_TIP_') || position === targetBasePosition) {
        remove = true;
      }
    } else if (position.startsWith('MAIN_TIP_')) {
      remove = true;
    }

    if (remove) {
      element.parentNode?.removeChild?.(element);
      continue;
    }
    removeSwitchAttributes(element);
  }
  return clone;
}

function localY(point, frame) {
  return (point.x - frame.start.x) * frame.left.x + (point.y - frame.start.y) * frame.left.y;
}

function interpolatePoint(start, end, t) {
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    z: start.z + (end.z - start.z) * t,
  };
}

export function clipLineToYInterval(
  primitive,
  frame,
  intervalStart,
  intervalEnd,
  outerMinY,
  outerMaxY,
) {
  if (primitive?.type !== 'line') return { status: 'UNSUPPORTED' };
  const startY = localY(primitive.start, frame);
  const endY = localY(primitive.end, frame);
  if (![startY, endY].every(Number.isFinite)) return { status: 'UNSUPPORTED' };

  const deltaY = endY - startY;
  if (Math.abs(deltaY) <= EPS) {
    const onInterval = startY >= intervalStart - EPS && startY <= intervalEnd + EPS;
    const onPhysicalOuter =
      Math.abs(startY - outerMinY) <= EPS || Math.abs(startY - outerMaxY) <= EPS;
    return onInterval && onPhysicalOuter
      ? { status: 'READY', primitive: createLine(primitive.start, primitive.end) }
      : { status: 'OUTSIDE' };
  }

  const tA = (intervalStart - startY) / deltaY;
  const tB = (intervalEnd - startY) / deltaY;
  const t0 = Math.max(0, Math.min(tA, tB));
  const t1 = Math.min(1, Math.max(tA, tB));
  if (!(t1 - t0 > EPS)) return { status: 'OUTSIDE' };
  return {
    status: 'READY',
    primitive: createLine(
      interpolatePoint(primitive.start, primitive.end, t0),
      interpolatePoint(primitive.start, primitive.end, t1),
    ),
  };
}

function clipPathToInterval(path, frame, interval, intervalResult, metadata) {
  const primitives = [];
  for (const primitive of path?.primitives || []) {
    const clipped = clipLineToYInterval(
      primitive,
      frame,
      interval[0],
      interval[1],
      intervalResult.minY,
      intervalResult.maxY,
    );
    if (clipped.status === 'UNSUPPORTED') return null;
    if (clipped.status === 'READY') primitives.push(clipped.primitive);
  }
  if (!primitives.length) return null;
  return createRebarPath(primitives, { ...path.metadata, ...metadata });
}

export function clipGeneratedMainPaths({
  generatedPaths,
  frame,
  section,
  bar,
  faceSwitch,
  sourcePosition,
  outputPosition,
}) {
  const intervalResult = resolveReverseTMainSwitchIntervals({
    position: bar.pos,
    mainType: faceSwitch.mainType,
    lengthMm: faceSwitch.lengthMm,
    halfWidthMm: section.shape.widthMm / 2,
    sideInsetMm: section.coverSideMm + bar.diaMm / 2,
  });
  if (intervalResult.status !== 'READY') {
    return { status: 'UNRESOLVED', reason: intervalResult.reason, intervalResult };
  }

  const sourcePaths = generatedPaths.filter((path) => path?.metadata?.position === sourcePosition);
  if (!sourcePaths.length) return { status: 'UNRESOLVED', reason: 'GENERATED_MAIN_PATH_MISSING' };

  const paths = [];
  for (const path of sourcePaths) {
    for (
      let fragmentIndex = 0;
      fragmentIndex < intervalResult.intervals.length;
      fragmentIndex += 1
    ) {
      const interval = intervalResult.intervals[fragmentIndex];
      const clipped = clipPathToInterval(path, frame, interval, intervalResult, {
        position: outputPosition,
        mainSwitchBasis: intervalResult.basis,
        mainSwitchType: faceSwitch.mainType,
        mainSwitchLengthMm: faceSwitch.lengthMm,
        mainSwitchIntervalStartY: interval[0],
        mainSwitchIntervalEndY: interval[1],
        mainSwitchFragmentIndex: fragmentIndex,
      });
      if (!clipped) return { status: 'UNRESOLVED', reason: 'MAIN_SWITCH_CLIP_FAILED' };
      paths.push(clipped);
    }
  }
  return { status: 'READY', paths, intervalResult };
}
