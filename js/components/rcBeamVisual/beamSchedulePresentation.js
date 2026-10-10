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

/**
 * 梁断面リストの主筋/腹筋本数表記(例: 4-D25、4/2-D25、2-D25 + 2-D22(SD390))。
 * @returns {string} 配筋が無い場合は '-'
 */
export function formatBeamBarCountText(bar) {
  if (!bar || bar.count <= 0) return '-';
  const layers = bar.layers?.filter((layer) => layer.count > 0) || [];
  if (layers.length > 0) {
    const groups = layers.flatMap((layer) =>
      layer.barGroups?.length > 0 ? layer.barGroups : [layer],
    );
    const dias = new Set(groups.map((group) => group.dia).filter(Boolean));
    const grades = new Set(groups.map((group) => group.grade).filter(Boolean));
    const countsText = layers.map((layer) => layer.count).join('/');
    if (dias.size === 0) return countsText;
    if (dias.size === 1 && grades.size <= 1) return `${countsText}-${[...dias][0]}`;
    return groups
      .map(
        (group) =>
          `${group.count}${group.dia ? `-${group.dia}` : ''}${group.grade ? `(${group.grade})` : ''}`,
      )
      .join(' + ');
  }

  const count1st = bar.count1st || bar.count;
  const count2nd = bar.count2nd || 0;
  const countText = count2nd > 0 ? `${count1st}/${count2nd}` : `${count1st}`;
  return bar.dia ? `${countText}-${bar.dia}` : countText;
}

/**
 * 梁断面リストのあばら筋表記(例: 2-D13@200)。
 * @returns {string} あばら筋が無い場合は '-'
 */
export function formatBeamStirrupText(stirrup) {
  if (!stirrup || !stirrup.dia) return '-';
  const countText = stirrup.count > 0 ? `${stirrup.count}-` : '';
  const pitchText = stirrup.pitch ? `@${stirrup.pitch}` : '';
  return `${countText}${stirrup.dia}${pitchText}`;
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
