/**
 * @fileoverview DrawingRenderPlan用のタグcompile。
 *
 * 既存TagRenderPlanと保存配置を、SVG/DXF双方で共有できるpaper/model絶対座標へ展開する。
 * DOM/CSS viewport/Three.js sceneには依存しない。
 */
import {
  DEFAULT_DRAWING_TAG_ORIENTATION_MODE,
  DRAWING_TAG_ORIENTATION_MODES,
  normalizeDrawingTagOrientationMode,
} from '../../config/drawingTagTemplates.js';
import { invertAffine, transformPoint } from './affine2d.js';
import { buildSelectedDrawingTagPlan } from './tags/tagFamilyRegistry.js';
import {
  computeDefaultTagOriginDisplay,
  describeLineMember,
  estimateTagExtent,
} from './tags/tagPlacementLayout.js';

const TAG_MODE_HIDDEN = 'hidden';
const LINE_ALIGNED_TAG_ELEMENT_TYPES = new Set(['Girder', 'Beam', 'Brace', 'Wall']);
const DIRECTION_EPSILON = 1e-12;

function freezePoint(point) {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))
    throw new TypeError('タグ座標には有限の数値2個が必要です。');
  return Object.freeze([...point]);
}

function paperToDisplay(point) {
  const [x, y] = freezePoint(point);
  return [x, -y];
}

function displayToPaper(point) {
  const [x, y] = freezePoint(point);
  return [x, -y];
}

function transformVector(matrix, vector) {
  const [a, b, c, d] = matrix;
  const [x, y] = freezePoint(vector);
  const result = [a * x + c * y, b * x + d * y];
  if (!result.every(Number.isFinite)) throw new TypeError('タグベクトル変換結果が不正です。');
  return result;
}

function normalizeAngle(value) {
  let angle = Number(value || 0);
  if (!Number.isFinite(angle)) throw new TypeError('タグ回転角が不正です。');
  // atan2由来の浮動小数ノイズ(例: -90.00000000000001)をDXF/SVGの回転角へ漏らさない。
  angle = Math.round((angle % 360) * 1e9) / 1e9;
  if (angle <= -180) angle += 360;
  if (angle > 180) angle -= 360;
  return Math.abs(angle) <= 1e-12 ? 0 : angle;
}

function rotateDisplayVector(vector, rotationDeg) {
  const [x, y] = freezePoint(vector);
  const radians = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos * x - sin * y, sin * x + cos * y];
}

function boundsOfDisplayPoints(points) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const point of points) {
    const [x, y] = freezePoint(point);
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  }
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite))
    throw new Error('タグ配置用の部材範囲を取得できません。');
  return bounds;
}

function planScale(tagPlan) {
  if (tagPlan.units === 'css-px') return 1;
  if (tagPlan.units !== 'paper-mm') throw new TypeError(`未対応のタグ単位です: ${tagPlan.units}`);
  if (tagPlan.schemaVersion === 2) {
    if (!Number.isFinite(tagPlan.paperScale) || tagPlan.paperScale <= 0)
      throw new RangeError('TagFamilyのpaperScaleが不正です。');
    return tagPlan.paperScale;
  }
  return 1;
}

function sourceRecord(drawing, elementKey) {
  const record = (drawing.elements || []).find((candidate) => candidate.key === elementKey);
  if (!record) throw new Error(`タグ対象Drawing recordが見つかりません: ${elementKey}`);
  return record;
}

function displayRotationDeg(rotationDeg, orientationMode, modelToPaper) {
  const rotation = normalizeAngle(rotationDeg);
  if (orientationMode !== DRAWING_TAG_ORIENTATION_MODES.FOLLOW_DRAWING) return rotation;
  const radians = (rotation * Math.PI) / 180;
  const directionModel = [Math.cos(radians), -Math.sin(radians)];
  const directionPaper = transformVector(modelToPaper, directionModel);
  const directionDisplay = [directionPaper[0], -directionPaper[1]];
  if (Math.hypot(directionDisplay[0], directionDisplay[1]) <= 1e-12)
    throw new TypeError('タグ向き変換結果が不正です。');
  return normalizeAngle((Math.atan2(directionDisplay[1], directionDisplay[0]) * 180) / Math.PI);
}

function readableDisplayRotation(direction) {
  let [x, y] = freezePoint(direction);
  if (Math.hypot(x, y) <= DIRECTION_EPSILON) return null;
  // 文字が上下逆にならないよう、同一直線なら右向き（鉛直は画面下向き）を採用する。
  if (x < -DIRECTION_EPSILON || (Math.abs(x) <= DIRECTION_EPSILON && y < 0)) {
    x = -x;
    y = -y;
  }
  return normalizeAngle((Math.atan2(y, x) * 180) / Math.PI);
}

function distanceSquaredToSegment(point, start, end) {
  const vx = end[0] - start[0];
  const vy = end[1] - start[1];
  const length2 = vx * vx + vy * vy;
  if (length2 <= DIRECTION_EPSILON) return Infinity;
  const wx = point[0] - start[0];
  const wy = point[1] - start[1];
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / length2));
  const dx = point[0] - (start[0] + vx * t);
  const dy = point[1] - (start[1] + vy * t);
  return dx * dx + dy * dy;
}

function memberAxisDirectionModel(axis, anchorModel) {
  if (!axis) return null;
  if (axis.kind === 'straight-member-axis') {
    return [axis.end[0] - axis.start[0], axis.end[1] - axis.start[1]];
  }
  if (axis.kind !== 'polyline-member-axis' || !Array.isArray(axis.points)) return null;

  let best = null;
  let bestDistance2 = Infinity;
  for (let index = 1; index < axis.points.length; index += 1) {
    const start = axis.points[index - 1];
    const end = axis.points[index];
    const distance2 = distanceSquaredToSegment(anchorModel, start, end);
    if (distance2 >= bestDistance2) continue;
    bestDistance2 = distance2;
    best = [end[0] - start[0], end[1] - start[1]];
  }
  return best;
}

function memberRotationDisplayDeg({
  elementType,
  memberAxisModel,
  memberDisplayPoints,
  anchorModel,
  modelToPaper,
}) {
  if (!LINE_ALIGNED_TAG_ELEMENT_TYPES.has(String(elementType))) return null;

  const axisDirection = memberAxisDirectionModel(memberAxisModel, anchorModel);
  if (axisDirection && Math.hypot(axisDirection[0], axisDirection[1]) > DIRECTION_EPSILON) {
    const directionPaper = transformVector(modelToPaper, axisDirection);
    const directionDisplay = [directionPaper[0], -directionPaper[1]];
    const rotation = readableDisplayRotation(directionDisplay);
    if (rotation != null) return rotation;
  }

  // 壁など配置基準線を持たない要素は、描画外形の主軸を線分方向として用いる。
  return readableDisplayRotation(describeLineMember(memberDisplayPoints).direction);
}

function absolutePointFactory({ originPaper, rotationDisplayDeg, scale, modelToPaperInverse }) {
  const originDisplay = paperToDisplay(originPaper);
  return (localPoint) => {
    const local = freezePoint(localPoint);
    const rotated = rotateDisplayVector([local[0] * scale, local[1] * scale], rotationDisplayDeg);
    const display = [originDisplay[0] + rotated[0], originDisplay[1] + rotated[1]];
    const paper = displayToPaper(display);
    return Object.freeze({
      paper: freezePoint(paper),
      model: freezePoint(transformPoint(modelToPaperInverse, paper)),
    });
  };
}

function textRotation({ rotationDisplayDeg, modelToPaperInverse }) {
  const displayDirection = rotateDisplayVector([1, 0], rotationDisplayDeg);
  const paperDirection = [displayDirection[0], -displayDirection[1]];
  const modelDirection = transformVector(modelToPaperInverse, paperDirection);
  return Object.freeze({
    display: normalizeAngle(rotationDisplayDeg),
    paper: normalizeAngle(-rotationDisplayDeg),
    model: normalizeAngle((Math.atan2(modelDirection[1], modelDirection[0]) * 180) / Math.PI),
  });
}

function compileItem({
  tagId,
  item,
  absolutePoint,
  scale,
  genericTextHeightPaperMm,
  genericStrokeWidthPaperMm,
  modelToPaperScale,
  rotations,
  fontFamily,
}) {
  const id = (suffix = '') => `${tagId}:${item.id}${suffix}`;
  const magnitude = (paper) => {
    if (!Number.isFinite(paper) || paper < 0)
      throw new TypeError('タグ寸法には0以上の有限値が必要です。');
    return Object.freeze({ paper, model: paper / modelToPaperScale });
  };

  if (item.kind === 'text') {
    const textHeightPaper =
      item.fontSize == null ? genericTextHeightPaperMm : item.fontSize * scale;
    const haloPaper =
      item.strokeWidth == null ? genericStrokeWidthPaperMm : item.strokeWidth * scale;
    return [
      Object.freeze({
        id: id(),
        kind: 'text',
        role: 'tag-text',
        point: absolutePoint(item.point),
        text: item.text,
        textAnchor: item.textAnchor || 'middle',
        fontFamily,
        textHeight: magnitude(textHeightPaper),
        haloWidth: magnitude(haloPaper),
        rotationDeg: rotations,
      }),
    ];
  }

  if (item.kind === 'line') {
    return [
      Object.freeze({
        id: id(),
        kind: 'line',
        role: 'tag-line',
        points: Object.freeze(item.points.map(absolutePoint)),
        strokeWidth: magnitude(item.strokeWidth * scale),
      }),
    ];
  }

  if (item.kind === 'frame') {
    const [x, y, width, height] = item.rect;
    const points = [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
    ].map(absolutePoint);
    return [
      Object.freeze({
        id: id(),
        kind: 'polyline',
        role: 'tag-frame',
        closed: true,
        points: Object.freeze(points),
        strokeWidth: magnitude(item.strokeWidth * scale),
        cornerRadius: item.shape === 'rounded-rect' ? magnitude(item.radius * scale) : null,
      }),
    ];
  }

  if (item.kind === 'circle') {
    return [
      Object.freeze({
        id: id(),
        kind: 'circle',
        role: 'tag-circle',
        center: absolutePoint(item.point),
        radius: magnitude(item.radius * scale),
        strokeWidth: magnitude(item.strokeWidth * scale),
        ...(item.filled === true ? { filled: true } : {}),
      }),
    ];
  }

  if (item.kind === 'circled-value') {
    const textHeightPaper =
      item.fontSize == null ? genericTextHeightPaperMm : item.fontSize * scale;
    const haloPaper =
      item.strokeWidth == null ? genericStrokeWidthPaperMm : item.strokeWidth * scale;
    const circleStrokePaper = (item.circleStrokeWidth ?? item.strokeWidth ?? 0.35) * scale;
    return [
      Object.freeze({
        id: id(':circle'),
        kind: 'circle',
        role: 'tag-circle',
        center: absolutePoint(item.point),
        radius: magnitude(item.radius * scale),
        strokeWidth: magnitude(circleStrokePaper),
      }),
      Object.freeze({
        id: id(':text'),
        kind: 'text',
        role: 'tag-text',
        point: absolutePoint(item.point),
        text: item.text,
        textAnchor: item.textAnchor || 'middle',
        fontFamily,
        textHeight: magnitude(textHeightPaper),
        haloWidth: magnitude(haloPaper),
        rotationDeg: rotations,
      }),
    ];
  }

  if (item.kind === 'leader-anchor') {
    return [
      Object.freeze({
        id: id(),
        kind: 'anchor',
        role: 'tag-leader-anchor',
        point: absolutePoint(item.point),
      }),
    ];
  }

  throw new TypeError(`未対応のタグprimitiveです: ${item.kind}`);
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function normalizeResolvedPlacements(resolved) {
  if (resolved == null) return [null];
  if (!Array.isArray(resolved)) {
    if (typeof resolved !== 'object') throw new TypeError('tag placement解決結果が不正です。');
    return [resolved];
  }
  if (resolved.length === 0)
    throw new Error(
      'tag placement resolverは空配列を返せません。intentなしはnullを返してください。',
    );
  if (resolved.some((placement) => !placement || typeof placement !== 'object')) {
    throw new TypeError('複数tag placement解決結果が不正です。');
  }
  return resolved;
}

function placementInstanceId(placement) {
  if (placement?.instanceId == null) return null;
  const value = String(placement.instanceId).trim();
  if (!value) throw new TypeError('tag placement instanceIdが空です。');
  return value;
}

/**
 * @param {Object} input
 * @param {Object} input.drawing DrawingModel
 * @param {Object} input.renderPlanGeometry DrawingRenderPlanのtags以外の確定geometry
 */
export function compileDrawingRenderTags({
  drawing,
  renderPlanGeometry,
  displaySettings = {},
  showLabels = true,
  tagFamilyState = null,
  resolveTagFacts = null,
  resolveTagPlacement = null,
  tagOrientationMode = DEFAULT_DRAWING_TAG_ORIENTATION_MODE,
  genericTextHeightPaperMm = 3.5,
  genericStrokeWidthPaperMm = 0.8,
} = {}) {
  if (
    !Array.isArray(renderPlanGeometry?.elements) ||
    !Array.isArray(renderPlanGeometry?.primitives)
  )
    throw new TypeError('タグcompileにはDrawingRenderPlan geometryが必要です。');
  if (!Number.isFinite(genericTextHeightPaperMm) || genericTextHeightPaperMm <= 0)
    throw new RangeError('既定タグ文字高さが不正です。');
  if (!Number.isFinite(genericStrokeWidthPaperMm) || genericStrokeWidthPaperMm < 0)
    throw new RangeError('既定タグhalo幅が不正です。');

  const orientationMode = normalizeDrawingTagOrientationMode(tagOrientationMode);
  const modelToPaper = renderPlanGeometry.profile.modelToPaper;
  const modelToPaperInverse = invertAffine(modelToPaper);
  const modelToPaperScale = Math.hypot(modelToPaper[0], modelToPaper[1]);
  const layerById = new Map(renderPlanGeometry.layers.map((layer) => [layer.id, layer]));
  const primitiveByElement = new Map();
  for (const primitive of renderPlanGeometry.primitives) {
    if (!primitiveByElement.has(primitive.elementKey))
      primitiveByElement.set(primitive.elementKey, []);
    primitiveByElement.get(primitive.elementKey).push(primitive);
  }

  const tags = [];
  for (const element of renderPlanGeometry.elements) {
    if (element.state !== 'drawn' || element.visible === false || element.taggable === false)
      continue;
    const layer = layerById.get(element.layerId);
    if (!layer || layer.visible === false) continue;
    const record = sourceRecord(drawing, element.key);
    const displayType = element.renderType || record.ref.elementType;
    const selection = showLabels
      ? (displaySettings?.tagModes?.[displayType] ?? 'mark')
      : TAG_MODE_HIDDEN;
    if (selection === TAG_MODE_HIDDEN) continue;

    const selectedPlan = buildSelectedDrawingTagPlan({
      record,
      source: drawing.source,
      selection,
      tagFamilyState,
      resolveTagFacts,
    });
    const scale = planScale(selectedPlan);
    const primitives = primitiveByElement.get(element.key) || [];
    const memberPaperPoints = primitives.flatMap((primitive) =>
      primitive.points?.paper ? primitive.points.paper : [],
    );
    if (memberPaperPoints.length === 0) continue;
    const memberDisplayPoints = memberPaperPoints.map(paperToDisplay);
    const bboxDisplay = boundsOfDisplayPoints(memberDisplayPoints);
    const centerPaper = element.anchor?.paper;
    if (!centerPaper) continue;
    const centerDisplay = paperToDisplay(centerPaper);
    const extent = estimateTagExtent(selectedPlan, {
      fontSize: genericTextHeightPaperMm,
      paperMmToDisplay: 1,
    });
    const defaultOriginDisplay = computeDefaultTagOriginDisplay({
      elementType: record.ref.elementType,
      centerDisplay,
      points: memberDisplayPoints,
      bbox: bboxDisplay,
      extent,
      fontSize: genericTextHeightPaperMm,
    });
    const defaultOriginPaper = displayToPaper(defaultOriginDisplay);
    const defaultAnchorModel = transformPoint(modelToPaperInverse, defaultOriginPaper);
    const placementContext = Object.freeze({
      ref: Object.freeze({ ...record.ref }),
      elementKey: record.key,
      template: selectedPlan.template,
      memberAnchorModel: freezePoint(element.anchor.model),
      memberAxisModel: element.memberAxisModel,
      defaultAnchorModel: freezePoint(defaultAnchorModel),
    });
    const resolvedPlacement =
      typeof resolveTagPlacement === 'function' ? resolveTagPlacement(placementContext) : null;
    const placements = normalizeResolvedPlacements(resolvedPlacement);
    const instanceIds = new Set();
    const multiplePlacements = placements.length > 1;

    for (const placement of placements) {
      const instanceId = placementInstanceId(placement);
      if (multiplePlacements && !instanceId)
        throw new Error('複数tag placementには一意なinstanceIdが必要です。');
      if (instanceId && instanceIds.has(instanceId))
        throw new Error('tag placement instanceIdが重複しています: ' + instanceId);
      if (instanceId) instanceIds.add(instanceId);

      const anchorModel = placement?.anchorModel || defaultAnchorModel;
      const offsetModel = placement?.offsetModel || [0, 0];
      freezePoint(anchorModel);
      freezePoint(offsetModel);
      const originModel = [anchorModel[0] + offsetModel[0], anchorModel[1] + offsetModel[1]];
      const originPaper = transformPoint(modelToPaper, originModel);
      const requestedRotationDeg = placement?.rotationDeg || 0;
      const memberRotation =
        orientationMode === DRAWING_TAG_ORIENTATION_MODES.FOLLOW_MEMBER
          ? memberRotationDisplayDeg({
              elementType: record.ref.elementType,
              memberAxisModel: element.memberAxisModel,
              memberDisplayPoints,
              anchorModel,
              modelToPaper,
            })
          : null;
      const rotationDisplayDeg =
        memberRotation == null
          ? displayRotationDeg(
              requestedRotationDeg,
              orientationMode === DRAWING_TAG_ORIENTATION_MODES.FOLLOW_MEMBER
                ? DRAWING_TAG_ORIENTATION_MODES.FOLLOW_DRAWING
                : orientationMode,
              modelToPaper,
            )
          : normalizeAngle(memberRotation + requestedRotationDeg);
      const rotations = textRotation({ rotationDisplayDeg, modelToPaperInverse });
      const absolutePoint = absolutePointFactory({
        originPaper,
        rotationDisplayDeg,
        scale,
        modelToPaperInverse,
      });
      const tagIdParts = [element.key, selectedPlan.template.id, selectedPlan.template.version];
      if (multiplePlacements) tagIdParts.push(instanceId);
      const tagId = JSON.stringify(tagIdParts);
      const compiledPrimitives = selectedPlan.items.flatMap((item) =>
        compileItem({
          tagId,
          item,
          absolutePoint,
          scale,
          genericTextHeightPaperMm,
          genericStrokeWidthPaperMm,
          modelToPaperScale,
          rotations,
          fontFamily: selectedPlan.fontFamily,
        }),
      );

      // カスタムTagFamilyの「引出線アンカー」があれば、その絶対座標を引出線終点に使う。
      const leaderEnd = compiledPrimitives.find(
        (primitive) => primitive.role === 'tag-leader-anchor',
      )?.point ?? {
        paper: originPaper,
        model: originModel,
      };
      let leader = null;
      if (placement?.leader === true && distance(leaderEnd.paper, centerPaper) > 1e-9) {
        leader = Object.freeze({
          id: `${tagId}:leader`,
          kind: 'line',
          role: 'tag-leader',
          points: Object.freeze([
            Object.freeze({
              paper: freezePoint(centerPaper),
              model: freezePoint(element.anchor.model),
            }),
            Object.freeze({
              paper: freezePoint(leaderEnd.paper),
              model: freezePoint(leaderEnd.model),
            }),
          ]),
          strokeWidth: Object.freeze({
            paper: 0.35,
            model: 0.35 / modelToPaperScale,
          }),
        });
        compiledPrimitives.push(leader);
      }

      tags.push(
        Object.freeze({
          id: tagId,
          ...(instanceId == null ? {} : { instanceId }),
          elementKey: element.key,
          layerId: element.layerId,
          sourceRef: element.sourceRef,
          template: selectedPlan.template,
          color: layer.style?.strokeColor || '#075963',
          orientationMode,
          origin: Object.freeze({
            paper: freezePoint(originPaper),
            model: freezePoint(originModel),
          }),
          rotationDeg: rotations,
          defaultAnchorModel: freezePoint(defaultAnchorModel),
          placement: placement
            ? Object.freeze({
                ...(instanceId == null ? {} : { instanceId }),
                anchorModel: freezePoint(anchorModel),
                offsetModel: freezePoint(offsetModel),
                rotationDeg: normalizeAngle(placement.rotationDeg || 0),
                leader: placement.leader === true,
              })
            : null,
          renderPlan: selectedPlan,
          renderScale: scale,
          genericTextHeightPaperMm,
          genericStrokeWidthPaperMm,
          primitives: Object.freeze(compiledPrimitives),
        }),
      );
    }
  }
  return Object.freeze(tags);
}
