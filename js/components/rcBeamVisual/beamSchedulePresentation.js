/**
 * RC梁断面リストの位置表示をSVG/DXFで共通化する。
 *
 * STBではSTART/CENTER/ENDを個別に保持していても、基準断面リストでは
 * 同一内容を1列へ圧縮する。両端が同一なら「両端部＋中央」の2列にする。
 */

const PREFERRED_POSITION_ORDER = ['LEFT', 'CENTER', 'RIGHT', 'SAME'];

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      if (['order', 'cover', 'sourceCover', 'mainCenter'].includes(key)) return result;
      result[key] = stableObject(value[key]);
      return result;
    }, {});
}

export function getBeamSchedulePositionSignature(positionData) {
  if (!positionData) return '';
  return JSON.stringify(
    stableObject({
      width: positionData.width,
      depth: positionData.depth,
      topBar: positionData.topBar,
      bottomBar: positionData.bottomBar,
      stirrup: positionData.stirrup,
      webBar: positionData.webBar,
    }),
  );
}

function samePosition(a, b) {
  return getBeamSchedulePositionSignature(a) === getBeamSchedulePositionSignature(b);
}

function createEntry(key, sourceKeys, data, label) {
  return { key, sourceKeys, data, label };
}

/**
 * 基準リストの位置列へ正規化する。
 * @returns {Array<{key:string,sourceKeys:string[],data:Object,label:string}>}
 */
export function resolveBeamSchedulePositionEntries(positions, positionPattern = '') {
  if (!positions) return [];
  if (positions.SAME) {
    return [createEntry('SAME', ['SAME'], positions.SAME, '全断面')];
  }

  const orderedKeys = PREFERRED_POSITION_ORDER.filter((key) => positions[key]);
  const fallbackKeys = Object.entries(positions)
    .filter(([key]) => !orderedKeys.includes(key))
    .sort(([, a], [, b]) => (a?.order ?? 0) - (b?.order ?? 0))
    .map(([key]) => key);
  const keys = [...orderedKeys, ...fallbackKeys];

  if (keys.length === 1) {
    return [createEntry('SAME', [keys[0]], positions[keys[0]], '全断面')];
  }

  if (keys.length === 2) {
    const [first, second] = keys;
    if (samePosition(positions[first], positions[second])) {
      return [createEntry('SAME', keys, positions[first], '全断面')];
    }
    if (positionPattern === 'START_END' || (first === 'LEFT' && second === 'RIGHT')) {
      return [
        createEntry(first, [first], positions[first], '始端'),
        createEntry(second, [second], positions[second], '終端'),
      ];
    }
    return [
      createEntry(first, [first], positions[first], first === 'LEFT' ? '端部' : first),
      createEntry(second, [second], positions[second], second === 'CENTER' ? '中央' : second),
    ];
  }

  const left = positions.LEFT;
  const center = positions.CENTER;
  const right = positions.RIGHT;
  if (left && center && right) {
    const leftCenter = samePosition(left, center);
    const centerRight = samePosition(center, right);
    const leftRight = samePosition(left, right);

    if (leftCenter && centerRight) {
      return [createEntry('SAME', ['LEFT', 'CENTER', 'RIGHT'], left, '全断面')];
    }
    if (leftRight) {
      return [
        createEntry('ENDS', ['LEFT', 'RIGHT'], left, '両端部'),
        createEntry('CENTER', ['CENTER'], center, '中央'),
      ];
    }
    if (leftCenter) {
      return [
        createEntry('LEFT_CENTER', ['LEFT', 'CENTER'], left, '左端・中央'),
        createEntry('RIGHT', ['RIGHT'], right, '右端'),
      ];
    }
    if (centerRight) {
      return [
        createEntry('LEFT', ['LEFT'], left, '左端'),
        createEntry('CENTER_RIGHT', ['CENTER', 'RIGHT'], center, '中央・右端'),
      ];
    }
    return [
      createEntry('LEFT', ['LEFT'], left, '左端'),
      createEntry('CENTER', ['CENTER'], center, '中央'),
      createEntry('RIGHT', ['RIGHT'], right, '右端'),
    ];
  }

  return keys.map((key) => {
    const label =
      key === 'LEFT' ? '左端' : key === 'CENTER' ? '中央' : key === 'RIGHT' ? '右端' : key;
    return createEntry(key, [key], positions[key], label);
  });
}
