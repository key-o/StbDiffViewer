/**
 * Issue #510: STB-A RC member silhouettes in an orthogonal grid elevation.
 * X-axis elevation projects to YZ; Y-axis elevation projects to XZ (model mm).
 * Unresolved and nonuniform sections are never given a guessed width.
 */
const SECTION_TAGS = Object.freeze({
  Column: ['StbSecColumn_RC', 'StbSecColumn_SRC', 'StbSecColumn_S', 'StbSecColumn_CFT'],
  Post: ['StbSecColumn_RC', 'StbSecColumn_SRC', 'StbSecColumn_S', 'StbSecColumn_CFT'],
  Girder: [
    'StbSecGirder_RC',
    'StbSecBeam_RC',
    'StbSecGirder_SRC',
    'StbSecBeam_SRC',
    'StbSecGirder_S',
    'StbSecBeam_S',
  ],
  Beam: ['StbSecBeam_RC', 'StbSecBeam_SRC', 'StbSecBeam_S'],
});
const RC_BEAM_SHAPES = Object.freeze({
  RC: [
    'StbSecGirder_RC_Straight',
    'StbSecGirder_RC_Straight_Same',
    'StbSecBeam_RC_Straight',
    'StbSecBeam_RC_Straight_Same',
    'StbSecStraight_Beam_RC',
    'StbSecBeamStraight',
    'StbSecBeam_RC_Rect',
  ],
  SRC: [
    'StbSecGirder_SRC_Straight',
    'StbSecBeam_SRC_Straight',
    'StbSecStraight_Beam_SRC',
    'StbSecBeamStraight',
  ],
});
const STEEL_COLUMN_SHAPES = Object.freeze([
  'StbSecSteelColumn_S_Same',
  'StbSecSteelColumn_CFT_Same',
  'StbSecSteelColumnSame',
]);
const STEEL_BEAM_SHAPES = Object.freeze([
  'StbSecSteelBeamStraight',
  'StbSecSteelBeam_S_Straight',
  'StbSecSteelGirder_S_Straight',
  'StbSecSteelBeam_S_Same',
  'StbSecSteelGirder_S_Same',
]);
const EPS = 1e-6;

function finitePositiveAttribute(element, attr, label) {
  const raw = element.getAttribute(attr);
  const value = raw == null || raw.trim() === '' ? NaN : Number(raw);
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new TypeError(`${label}: ${attr} は正の有限値(mm)が必要です。`);
  }
  return value;
}

function matchingSection(document, member, type, id) {
  const tags = SECTION_TAGS[type] || [];
  const material = String(member?.getAttribute('kind_structure') || '').toUpperCase();
  if (material && !['RC', 'SRC', 'S', 'CFT'].includes(material)) return null;
  const permitted = material ? tags.filter((tag) => tag.endsWith('_' + material)) : tags;
  const matches = [];
  for (const tag of permitted) {
    for (const section of Array.from(document.getElementsByTagNameNS('*', tag))) {
      if (section.getAttribute('id') === id) matches.push(section);
      // Older STB fixtures put section IDs on nested figures. Resolve to the
      // material-specific parent so its structural kind remains known even
      // when the nested figure tag omits the _RC/_SRC/_S suffix.
      if (section.getAttribute('id') == null) {
        for (const candidate of Array.from(section.getElementsByTagName('*'))) {
          if (candidate.getAttribute('id') === id) matches.push(section);
        }
      }
    }
  }
  // An id_section collision across materials or within the same kind is
  // ambiguous. Do not silently render the first matching section.
  return matches.length === 1 ? matches[0] : null;
}

function steelShapeDimensions(raw) {
  const text = String(raw || '')
    .trim()
    .toUpperCase()
    .replaceAll('×', 'X');
  const match = /^(H|BH|SH|BOX|BCR|BCP|B□|□|▢|P|STK|STKR|○|◯|Φ)-([0-9.]+)(?:X([0-9.]+))?/.exec(
    text,
  );
  if (!match) return null;
  const h = Number(match[2]);
  const b = match[3] == null ? null : Number(match[3]);
  if (!(h > 0) || !Number.isFinite(h) || (b != null && (!(b > 0) || !Number.isFinite(b))))
    return null;
  // STKR (JIS G 3466) is a square/rectangular tube, NOT a round tube.
  // Its unequal X/Y sides have an unresolved orientation in this elevation.
  const round = ['P', 'STK', '○', '◯', 'Φ'].includes(match[1]);
  if (!round && b == null) return null;
  return Object.freeze({ height: h, width: round ? h : b, round, shapeType: match[1] });
}

function resolvedSteelShape(section, accepted, pattern) {
  const geometry = Array.from(section.getElementsByTagName('*')).filter(
    (node) => pattern.test(node.localName) && !node.localName.endsWith('_Shape'),
  );
  const matching = geometry.filter((node) => accepted.includes(node.localName));
  // Fail closed on multi-position and nonuniform steel sections.
  if (geometry.length !== 1 || matching.length !== 1) return null;
  return steelShapeDimensions(matching[0].getAttribute('shape'));
}

function candidates(section, names) {
  return names.flatMap((tag) => Array.from(section.getElementsByTagNameNS('*', tag)));
}

function uniformHaunchDepth(haunches, sectionId) {
  if (![2, 3].includes(haunches.length)) return null;
  const positions = haunches.map((haunch) => haunch.getAttribute('pos'));
  const expectedPositions = haunches.length === 2 ? ['START', 'END'] : ['START', 'CENTER', 'END'];
  if (
    new Set(positions).size !== expectedPositions.length ||
    !expectedPositions.every((position) => positions.includes(position))
  ) {
    return null;
  }

  const dimensions = haunches.map((haunch) => ({
    width: finitePositiveAttribute(haunch, 'width', sectionId),
    depth: finitePositiveAttribute(haunch, 'depth', sectionId),
  }));
  const first = dimensions[0];
  if (dimensions.some(({ width, depth }) => width !== first.width || depth !== first.depth))
    return null;
  return first.depth;
}

const unsupported = (reason) => ({ status: 'unsupported', reason });

/**
 * Exact basic RC rectangle/circular-column elevation silhouettes. Other
 * section variants remain explicitly unsupported, not approximated.
 */
export function resolveAxisElevationMemberOutline({
  document,
  member,
  type,
  sectionId,
  axisDirection,
  projectedPoints,
} = {}) {
  if (!['X', 'Y'].includes(axisDirection)) throw new TypeError('軸組図の投影軸が不正です。');
  if (
    !Array.isArray(projectedPoints) ||
    projectedPoints.length !== 2 ||
    projectedPoints.some(
      (point) => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite),
    )
  ) {
    throw new TypeError('部材投影座標が不正です。');
  }

  if (!SECTION_TAGS[type]) return unsupported(`${type} の断面外形は未対応です。`);
  if (!String(sectionId || '').trim()) return unsupported('断面IDがありません。');
  const section = matchingSection(document, member, type, String(sectionId));
  if (!section) return unsupported(`断面 ${sectionId} は未定義または構造種別が曖昧です。`);
  // Older STB sections may put the ID on StbSecBeam_RC_Rect itself.
  // A terminal suffix such as "_Rect" must not be mistaken for the material.
  const material = /_(RC|SRC|S|CFT)(?:_|$)/.exec(section.localName)?.[1] || null;
  const rotation = ['rotate', 'rotate_angle', 'angle']
    .map((attr) => member?.getAttribute(attr))
    .find((value) => value != null);
  if (rotation != null && (rotation.trim() === '' || !Number.isFinite(Number(rotation)))) {
    return unsupported('柱・梁の回転指定が不正です。');
  }
  if (rotation != null && Math.abs(Number(rotation) % 180) > EPS) {
    return unsupported('回転断面の外形投影は未対応です。');
  }

  const [[x1, z1], [x2, z2]] = projectedPoints;
  if (type === 'Column' || type === 'Post') {
    if (Math.abs(x2 - x1) > EPS || Math.abs(z2 - z1) <= EPS) {
      return unsupported('傾斜柱・水平柱は正確な外形投影が未対応です。');
    }
    let width;
    if (material === 'RC' || material === 'SRC') {
      const supported = [
        `StbSecColumn_${material}_Rect`,
        `StbSecColumn_${material}_Circle`,
        `StbSecRect_Column_${material}`,
        `StbSecCircle_Column_${material}`,
        'StbSecColumnRect',
        'StbSecColumnCircle',
      ];
      const figures = supported.includes(section.localName)
        ? [section]
        : candidates(section, supported);
      if (figures.length !== 1)
        return unsupported('RC/SRC柱のコンクリート外形が単一断面ではありません。');
      const figure = figures[0];
      // A flat STB 2.0.x figure may use width/depth rather than width_X/Y.
      const circular = /(?:Circle|_Circle)/.test(figure.localName);
      if (circular) {
        const diameterAttr = figure.getAttribute('D') != null ? 'D' : 'diameter';
        width = finitePositiveAttribute(figure, diameterAttr, sectionId);
      } else if (figure.getAttribute('width_X') != null && figure.getAttribute('width_Y') != null) {
        width = finitePositiveAttribute(
          figure,
          axisDirection === 'X' ? 'width_Y' : 'width_X',
          sectionId,
        );
      } else if (material === 'RC' && figure.localName === 'StbSecColumn_RC_Rect') {
        const attr = axisDirection === 'X' ? 'depth' : 'width';
        width = finitePositiveAttribute(figure, attr, sectionId);
      } else {
        return unsupported('柱断面のX/Y寸法を確定できません。');
      }
    } else {
      const shape = resolvedSteelShape(
        section,
        STEEL_COLUMN_SHAPES,
        /^StbSecSteelColumn(?:_|Same|NotSame|ThreeTypes)/,
      );
      if (!shape) return unsupported('鋼柱の断面形状が不明か変断面です。');
      // H/rectangular BOX may rotate about Z; without a reliable direction contract
      // their X/Y side envelopes cannot be resolved. Square and round are invariant.
      if (Math.abs(shape.width - shape.height) > EPS)
        return unsupported('異方向寸法を持つ鋼柱の断面向きは未対応です。');
      width = shape.width;
    }
    const left = x1 - width / 2;
    const right = x1 + width / 2;
    const bottom = Math.min(z1, z2);
    const top = Math.max(z1, z2);
    return {
      status: 'outline',
      sectionId,
      points: [
        [left, bottom],
        [right, bottom],
        [right, top],
        [left, top],
      ],
    };
  }

  if (Math.abs(z2 - z1) > EPS || Math.abs(x2 - x1) <= EPS) {
    return unsupported('傾斜梁・直交梁の外形投影は未対応です。');
  }
  // The straight member datum is the top of the section (see ProfileBasedBeamGenerator).
  let depth;
  if (material === 'RC' || material === 'SRC') {
    const allowed = RC_BEAM_SHAPES[material];
    const figures = allowed.includes(section.localName) ? [section] : candidates(section, allowed);
    // Count structural figure variants, not reinforcement or wrapper elements.
    // Multiple "order" sections must not silently collapse to one rectangle.
    const geometric = Array.from(section.getElementsByTagName('*')).filter((element) =>
      /^(?:StbSec(?:Girder|Beam)(?:_RC|_SRC)?_(?:Straight|Taper|Haunch|Rect)|StbSec(?:Straight|Taper|Haunch)_Beam_(?:RC|SRC)|StbSecBeam(?:Straight|Taper|Haunch))/.test(
        element.localName,
      ),
    );
    const geometryCount = allowed.includes(section.localName) ? 1 : geometric.length;
    if (figures.length === 1 && geometryCount === 1) {
      finitePositiveAttribute(figures[0], 'width', sectionId);
      depth = finitePositiveAttribute(figures[0], 'depth', sectionId);
    } else {
      const haunches = geometric.filter((element) => /Haunch/.test(element.localName));
      if (figures.length !== 0 || haunches.length !== geometryCount) {
        return unsupported('RC/SRC梁の変断面は一定矩形に置き換えません。');
      }
      depth = uniformHaunchDepth(haunches, sectionId);
      if (depth == null) return unsupported('不均一または位置不正なハンチ梁の外形は未対応です。');
    }
  } else if (material === 'S') {
    const shape = resolvedSteelShape(
      section,
      STEEL_BEAM_SHAPES,
      /^StbSecSteel(?:Beam|Girder)(?:_|Straight|Taper|Joint|Haunch|FiveTypes)/,
    );
    if (!shape) return unsupported('S梁の形鋼寸法が不明、またはハンチ・変断面です。');
    depth = shape.height;
  } else {
    return unsupported('梁の構造種別は未対応です。');
  }
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  return {
    status: 'outline',
    sectionId,
    points: [
      [left, z1 - depth],
      [right, z1 - depth],
      [right, z1],
      [left, z1],
    ],
  };
}
