const OUTSIDE_POSITIONS = new Set(['OUTSIDE_TOP', 'OUTSIDE_BOTTOM']);
const THREE_WAY_FULL_CAGE_POSITIONS = Object.freeze([
  'MAIN_TOP',
  'MAIN_BOTTOM',
  'OUTSIDE_TOP',
  'OUTSIDE_BOTTOM',
]);

export function validateThreeWayOutsideBars(section) {
  const allBars = section?.bars || [];
  const positions = new Set(allBars.map((bar) => bar.pos).filter(Boolean));
  const bars = allBars.filter((bar) => OUTSIDE_POSITIONS.has(bar.pos));
  const hasHorizontal = positions.has('HORIZONTAL');

  if (hasHorizontal && THREE_WAY_FULL_CAGE_POSITIONS.some((position) => !positions.has(position))) {
    return {
      status: 'UNRESOLVED',
      code: 'FOUNDATION_THREEWAY_HORIZONTAL_REQUIRES_FULL_CAGE',
      message:
        'ThreeWay HORIZONTALは仕様図のかご配筋に付随するため、MAIN/OUTSIDEの上下4系統が明示された場合だけ3D化します。',
      positions: [...positions],
    };
  }

  if (!bars.length) return { status: 'READY', explicit: false, bars: [] };

  for (const bar of bars) {
    if (bar.count !== 1) {
      return {
        status: 'UNRESOLVED',
        code: 'FOUNDATION_THREEWAY_OUTSIDE_COUNT_DISTRIBUTION_UNRESOLVED',
        message:
          'ThreeWay OUTSIDEはN>1時の平面内間隔をST-Bridgeから一意化できないため、N=1のみ3D化します。',
        position: bar.pos,
        count: bar.count,
      };
    }
    if (bar.isVertical) {
      return {
        status: 'UNRESOLVED',
        code: 'FOUNDATION_THREEWAY_OUTSIDE_VERTICAL_UNRESOLVED',
        message:
          'ThreeWay OUTSIDEのisVerticalは外周閉鎖筋から個々の立下げ・立上げ折曲げ位置を一意化できないため、推定しません。',
        position: bar.pos,
      };
    }
  }

  return { status: 'READY', explicit: true, bars };
}

export const _foundationThreeWayOutsideContractInternals = Object.freeze({
  OUTSIDE_POSITIONS,
  THREE_WAY_FULL_CAGE_POSITIONS,
});
