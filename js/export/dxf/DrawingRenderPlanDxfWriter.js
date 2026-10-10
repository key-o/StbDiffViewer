/**
 * @fileoverview DrawingRenderPlanからAutoCAD R12互換DXFを生成するpure adapter。
 *
 * Three.js scene、camera、SVG DOM、PDF viewportから図形や配置を再計算しない。
 * 座標・レイヤ・注記は確定済みDrawingRenderPlanだけを入力とする。
 */
import { assertDrawingRenderPlan } from '../../data/drawing/drawingRenderPlan.js';
import { downloadDxf, generatePlanDxfContent } from './stb-to-dxf/DxfPlanFormatWriter.js';
import { DXF_OUTPUT_PROFILES, normalizeDxfOutputProfile } from './stb-to-dxf/DxfFormatWriter.js';

export const DRAWING_RENDER_PLAN_DXF_ADAPTER_VERSION = 1;

function resolveDxfOutputOptions(options = {}) {
  const profile = normalizeDxfOutputProfile(options.profile);
  const requestedTextStyle = options.textStyle || {};
  const textStyle = Object.freeze({
    fontFile: requestedTextStyle.fontFile || 'txt',
    bigFontFile:
      requestedTextStyle.bigFontFile ??
      (profile === DXF_OUTPUT_PROFILES.JWCAD_R12 ? '' : 'extfont2.shx'),
  });
  return Object.freeze({ profile, textStyle });
}

function emptyBounds() {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function extendBounds(bounds, point) {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))
    throw new TypeError('DXF出力座標には有限の数値2個が必要です。');
  bounds.minX = Math.min(bounds.minX, point[0]);
  bounds.minY = Math.min(bounds.minY, point[1]);
  bounds.maxX = Math.max(bounds.maxX, point[0]);
  bounds.maxY = Math.max(bounds.maxY, point[1]);
}

function finalizeBounds(bounds) {
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite))
    throw new Error('DXF出力対象の図形がありません。');
  return Object.freeze({
    min: Object.freeze({ x: bounds.minX, y: bounds.minY }),
    max: Object.freeze({ x: bounds.maxX, y: bounds.maxY }),
  });
}

function dxfPoint(point) {
  extendBounds(emptyBounds(), point);
  return Object.freeze({ x: point[0], y: point[1] });
}

function normalizeRotationDeg(value) {
  const angle = Number(value || 0);
  if (!Number.isFinite(angle)) throw new TypeError('DXF文字回転角が不正です。');
  let normalized = angle % 360;
  if (normalized <= -180) normalized += 360;
  if (normalized > 180) normalized -= 360;
  return Math.abs(normalized) <= 1e-12 ? 0 : normalized;
}

function modelToPaperScale(renderPlan) {
  const matrix = renderPlan.profile.modelToPaper;
  const scale = Math.hypot(matrix[0], matrix[1]);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('model→paper縮尺が不正です。');
  return scale;
}

function outputPoint(container, space) {
  const point = container?.[space];
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))
    throw new TypeError(`DrawingRenderPlanの${space}座標が不正です。`);
  return point;
}

function outputPoints(container, space) {
  const points = container?.[space];
  if (!Array.isArray(points) || points.length === 0)
    throw new TypeError(`DrawingRenderPlanの${space}点列が不正です。`);
  for (const point of points) outputPoint({ [space]: point }, space);
  return points;
}

function outputCompiledPoints(points, space) {
  if (!Array.isArray(points) || points.length === 0)
    throw new TypeError(`DrawingRenderPlan tagの${space}点列が不正です。`);
  return points.map((point) => outputPoint(point, space));
}

function outputMagnitude(container, space, name) {
  const value = container?.[space];
  if (!Number.isFinite(value) || value < 0)
    throw new TypeError(`DrawingRenderPlan tagの${name}が不正です。`);
  return value;
}

function addDiagnostic(target, code, severity, detail) {
  if (target.some((diagnostic) => diagnostic.code === code && diagnostic.detail === detail)) return;
  target.push(Object.freeze({ code, severity, detail }));
}

function collectAdapterDiagnostics(renderPlan, usedLayerIds, texts2D, space) {
  const diagnostics = (renderPlan.diagnostics || []).map((diagnostic) =>
    Object.freeze({ severity: diagnostic.severity || 'warning', ...diagnostic }),
  );
  const usedLayers = renderPlan.layers.filter((layer) => usedLayerIds.has(layer.id));

  if (
    usedLayers.some((layer) => layer.style?.fillColor && layer.style?.fillOpacity > 0) ||
    [...(renderPlan.dimensions || []), ...(renderPlan.tags || [])].some((entry) =>
      entry.primitives?.some((primitive) => primitive.filled === true),
    )
  ) {
    addDiagnostic(
      diagnostics,
      'DXF_R12_FILL_NOT_EMITTED',
      'warning',
      'R12出力ではSVGの切断面塗り・透過を出力せず、閉ポリライン外形のみを保持します。',
    );
  }

  if (usedLayers.some((layer) => layer.style?.strokeColor)) {
    addDiagnostic(
      diagnostics,
      'DXF_R12_TRUECOLOR_FALLBACK',
      'warning',
      'R12の既存Layer tableを使用するため、DrawingRenderPlanのRGB色は完全一致しません。',
    );
  }

  if (
    (renderPlan.annotations || []).some(
      (annotation) =>
        annotation.visible !== false &&
        Number.isFinite(annotation.style?.strokeWidthMm) &&
        annotation.style.strokeWidthMm > 0,
    ) ||
    (renderPlan.dimensions || []).some(
      (dimension) =>
        dimension.visible !== false &&
        dimension.primitives?.some(
          (primitive) =>
            Number.isFinite(primitive.style?.strokeWidthPaperMm) &&
            primitive.style.strokeWidthPaperMm > 0,
        ),
    )
  ) {
    addDiagnostic(
      diagnostics,
      'DXF_R12_ENTITY_LINEWIDTH_NOT_EMITTED',
      'notice',
      'R12出力ではRenderPlanの注記線幅をentity lineweightとして保持しません。',
    );
  }

  if (usedLayers.some((layer) => layer.style?.lineType && layer.style.lineType !== 'CONTINUOUS')) {
    addDiagnostic(
      diagnostics,
      'DXF_R12_LINETYPE_FALLBACK',
      'warning',
      '未定義線種はR12既存writerのCONTINUOUSへフォールバックします。',
    );
  }

  const requestedFonts = [
    renderPlan.profile.textStyle?.fontFamily,
    ...(renderPlan.tags || []).flatMap((tag) =>
      (tag.primitives || [])
        .filter((primitive) => primitive.kind === 'text')
        .map((primitive) => primitive.fontFamily),
    ),
  ].filter(Boolean);
  if (texts2D.length && requestedFonts.some((fontFamily) => fontFamily !== 'txt')) {
    addDiagnostic(
      diagnostics,
      'DXF_R12_TEXT_STYLE_FALLBACK',
      'warning',
      'R12既存writerはSTANDARD/txt文字スタイルを使用し、SVGフォント指定を完全再現しません。',
    );
  }

  if (space === 'model') {
    addDiagnostic(
      diagnostics,
      'DXF_MODEL_SPACE_USES_STB_COORDINATES',
      'notice',
      'model出力は内部model mmを実寸で使用し、用紙原点・図面回転・平行移動を座標へ適用しません。',
    );
  }

  if (
    renderPlan.profile.output?.dimensionRepresentation === 'exploded-line-text' &&
    ((renderPlan.dimensions || []).length > 0 ||
      (renderPlan.annotations || []).some((annotation) =>
        String(annotation.role || '').startsWith('dimension'),
      ))
  ) {
    addDiagnostic(
      diagnostics,
      'DXF_R12_DIMENSION_EXPLODED',
      'notice',
      '寸法はnative DIMENSIONではなく編集可能なLINE/TEXTへ展開して出力します。',
    );
  }

  if (renderPlan.tags === null && (renderPlan.elements || []).length > 0) {
    addDiagnostic(
      diagnostics,
      'DXF_RENDER_PLAN_TAGS_NOT_COMPILED',
      'warning',
      'このDrawingRenderPlanではタグcompileが未実施のため、DXFへタグを出力しません。',
    );
  }

  if (
    Array.isArray(renderPlan.tags) &&
    renderPlan.tags.some((tag) =>
      tag.primitives?.some((primitive) => primitive.role === 'tag-frame' && primitive.cornerRadius),
    )
  ) {
    addDiagnostic(
      diagnostics,
      'DXF_R12_ROUNDED_TAG_FRAME_FALLBACK',
      'warning',
      'R12出力では角丸タグ枠を直線4辺の閉ポリラインへフォールバックします。',
    );
  }

  return Object.freeze(diagnostics);
}

/**
 * DrawingRenderPlanを既存R12 writerのentity入力へ変換する。
 * writer側で座標、寸法値、部材形状を再計算しない。
 */
export function collectDrawingRenderPlanDxfEntities(renderPlan) {
  const plan = assertDrawingRenderPlan(renderPlan);
  const space = plan.profile.output?.preferredSpace || 'model';
  if (space !== 'model' && space !== 'paper')
    throw new RangeError('DXF出力座標系はmodelまたはpaperを指定してください。');
  if (plan.profile.output?.dimensionRepresentation === 'native-dimension') {
    throw new TypeError(
      'native DXF DIMENSION profileは未実装です。exploded-line-textを使用してください。',
    );
  }

  const layerById = new Map((plan.layers || []).map((layer) => [layer.id, layer]));
  const elementByKey = new Map((plan.elements || []).map((element) => [element.key, element]));
  const usedLayerIds = new Set();
  const lines2D = [];
  const polylines2D = [];
  const texts2D = [];
  const circles2D = [];
  const arcs2D = [];
  const lineTypes = [];
  const lineTypeByPattern = new Map();
  const bounds = emptyBounds();
  const scale = modelToPaperScale(plan);

  const layerVisible = (layerId) => {
    const layer = layerById.get(layerId);
    if (!layer) throw new Error(`DrawingRenderPlanのレイヤが見つかりません: ${layerId}`);
    return layer.visible !== false;
  };

  const resolveDashPatternLineType = (dashPatternMm, sourceId, descriptionPrefix) => {
    if (!Array.isArray(dashPatternMm) || dashPatternMm.length === 0) return 'CONTINUOUS';
    if (!dashPatternMm.every((value) => Number.isFinite(value) && value > 0))
      throw new TypeError(`DrawingRenderPlanの破線patternが不正です: ${sourceId}`);
    const unitScale = space === 'paper' ? 1 : 1 / scale;
    const pattern = dashPatternMm.map(
      (value, index) => value * unitScale * (index % 2 === 0 ? 1 : -1),
    );
    const key = pattern.map((value) => value.toFixed(6)).join(',');
    let lineType = lineTypeByPattern.get(key);
    if (!lineType) {
      lineType = `SDV_DASH_${lineTypes.length + 1}`;
      lineTypeByPattern.set(key, lineType);
      lineTypes.push(
        Object.freeze({
          name: lineType,
          description: `${descriptionPrefix} ${dashPatternMm.join('/')} mm`,
          pattern: Object.freeze(pattern),
        }),
      );
    }
    return lineType;
  };

  const resolveAnnotationLineType = (annotation) =>
    resolveDashPatternLineType(
      annotation.style?.dashPatternMm,
      annotation.id,
      'SDV RenderPlan dash',
    );

  const resolveReferenceLineType = (primitive) =>
    resolveDashPatternLineType(
      primitive.style?.dashPatternMm,
      primitive.id,
      'SDV DXF reference dash',
    );

  for (const primitive of plan.primitives || []) {
    const element = elementByKey.get(primitive.elementKey);
    if (!element)
      throw new Error(`DrawingRenderPlanの部材が見つかりません: ${primitive.elementKey}`);
    if (element.visible === false || !layerVisible(primitive.layerId)) continue;
    if (
      primitive.kind !== 'polyline' ||
      !['member-outline', 'wall-opening-outline'].includes(primitive.role)
    ) {
      throw new TypeError(
        `DXF writer未対応のDrawingRenderPlan primitiveです: ${primitive.kind}/${primitive.role}`,
      );
    }
    const points = outputPoints(primitive.points, space);
    for (const point of points) extendBounds(bounds, point);
    polylines2D.push(
      Object.freeze({
        id: primitive.id,
        points: Object.freeze(points.map(dxfPoint)),
        layer: primitive.layerId,
        closed: primitive.closed === true,
      }),
    );
    usedLayerIds.add(primitive.layerId);
  }

  for (const primitive of plan.referencePrimitives || []) {
    if (primitive.visible === false || !layerVisible(primitive.layerId)) continue;

    if (primitive.kind === 'line') {
      const points = outputPoints(primitive.points, space);
      if (points.length !== 2) throw new TypeError('DXF参照LINEには2点が必要です。');
      extendBounds(bounds, points[0]);
      extendBounds(bounds, points[1]);
      lines2D.push(
        Object.freeze({
          id: primitive.id,
          start: dxfPoint(points[0]),
          end: dxfPoint(points[1]),
          layer: primitive.layerId,
          lineType: resolveReferenceLineType(primitive),
        }),
      );
      usedLayerIds.add(primitive.layerId);
      continue;
    }

    if (primitive.kind === 'polyline') {
      const points = outputPoints(primitive.points, space);
      for (const point of points) extendBounds(bounds, point);
      polylines2D.push(
        Object.freeze({
          id: primitive.id,
          points: Object.freeze(points.map(dxfPoint)),
          bulges: Object.freeze([...(primitive.bulges || points.map(() => 0))]),
          layer: primitive.layerId,
          lineType: resolveReferenceLineType(primitive),
          closed: primitive.closed === true,
        }),
      );
      usedLayerIds.add(primitive.layerId);
      continue;
    }

    if (primitive.kind === 'circle') {
      const center = outputPoint(primitive.center, space);
      const radius = outputMagnitude(primitive.radius, space, 'DXF参照円半径');
      extendBounds(bounds, [center[0] - radius, center[1] - radius]);
      extendBounds(bounds, [center[0] + radius, center[1] + radius]);
      circles2D.push(
        Object.freeze({
          id: primitive.id,
          center: dxfPoint(center),
          radius,
          layer: primitive.layerId,
          lineType: resolveReferenceLineType(primitive),
        }),
      );
      usedLayerIds.add(primitive.layerId);
      continue;
    }

    if (primitive.kind === 'arc') {
      const center = outputPoint(primitive.center, space);
      const start = outputPoint(primitive.startPoint, space);
      const end = outputPoint(primitive.endPoint, space);
      const radius = outputMagnitude(primitive.radius, space, 'DXF参照円弧半径');
      extendBounds(bounds, [center[0] - radius, center[1] - radius]);
      extendBounds(bounds, [center[0] + radius, center[1] + radius]);
      const angle = (point) =>
        normalizeRotationDeg(
          (Math.atan2(point[1] - center[1], point[0] - center[0]) * 180) / Math.PI,
        );
      const startAngle = angle(start);
      const endAngle = angle(end);
      arcs2D.push(
        Object.freeze({
          id: primitive.id,
          center: dxfPoint(center),
          radius,
          // DXF ARCはCCW固定。clockwise参照は始終角を入れ替えて同じ幾何を表す。
          startAngle: primitive.clockwise ? endAngle : startAngle,
          endAngle: primitive.clockwise ? startAngle : endAngle,
          layer: primitive.layerId,
          lineType: resolveReferenceLineType(primitive),
        }),
      );
      usedLayerIds.add(primitive.layerId);
      continue;
    }

    if (primitive.kind === 'text') {
      const point = outputPoint(primitive.point, space);
      const height = outputMagnitude(primitive.textHeight, space, 'DXF参照文字高さ');
      const rotation = normalizeRotationDeg(-(primitive.rotationDeg?.[space] || 0));
      const lines = String(primitive.text || '').split(/\r?\n/);
      const radians = (rotation * Math.PI) / 180;
      const down = [Math.sin(radians), -Math.cos(radians)];
      for (const [index, line] of lines.entries()) {
        const position = [
          point[0] + down[0] * height * 1.2 * index,
          point[1] + down[1] * height * 1.2 * index,
        ];
        extendBounds(bounds, position);
        texts2D.push(
          Object.freeze({
            id: lines.length === 1 ? primitive.id : `${primitive.id}:line:${index}`,
            position: dxfPoint(position),
            text: line,
            layer: primitive.layerId,
            height,
            rotation,
            obliqueDeg: Number.isFinite(primitive.obliqueDeg) ? primitive.obliqueDeg : 0,
            widthFactor:
              Number.isFinite(primitive.widthFactor) && primitive.widthFactor > 0
                ? primitive.widthFactor
                : 1,
            generationFlags:
              (primitive.mirrorX === true ? 2 : 0) | (primitive.mirrorY === true ? 4 : 0),
            anchor: primitive.anchor?.horizontal || 'left',
            verticalAlign: primitive.anchor?.vertical || 'baseline',
          }),
        );
      }
      usedLayerIds.add(primitive.layerId);
      continue;
    }

    throw new TypeError(`DXF writer未対応のreference primitiveです: ${primitive.kind}`);
  }

  for (const annotation of plan.annotations || []) {
    if (annotation.visible === false || !layerVisible(annotation.layerId)) continue;
    if (annotation.kind === 'line') {
      const points = outputPoints(annotation.points, space);
      if (points.length !== 2) throw new TypeError('DXF LINE注記には2点が必要です。');
      extendBounds(bounds, points[0]);
      extendBounds(bounds, points[1]);
      lines2D.push(
        Object.freeze({
          id: annotation.id,
          start: dxfPoint(points[0]),
          end: dxfPoint(points[1]),
          layer: annotation.layerId,
          lineType: resolveAnnotationLineType(annotation),
        }),
      );
      usedLayerIds.add(annotation.layerId);
      continue;
    }

    if (annotation.kind === 'circle') {
      const center = outputPoint(annotation.center, space);
      const radius = outputMagnitude(annotation.radius, space, 'DXF注記円半径');
      extendBounds(bounds, [center[0] - radius, center[1] - radius]);
      extendBounds(bounds, [center[0] + radius, center[1] + radius]);
      circles2D.push(
        Object.freeze({
          id: annotation.id,
          center: dxfPoint(center),
          radius,
          layer: annotation.layerId,
        }),
      );
      usedLayerIds.add(annotation.layerId);
      continue;
    }

    if (annotation.kind === 'text') {
      if (/\r|\n/.test(annotation.text))
        throw new TypeError('R12 TEXTでは改行を含む注記を出力できません。');
      const point = outputPoint(annotation.point, space);
      extendBounds(bounds, point);
      const annotationTextHeightPaperMm =
        annotation.style?.textHeightMm ?? plan.profile.textStyle.textHeightMm;
      const annotationTextHeight =
        space === 'paper' ? annotationTextHeightPaperMm : annotationTextHeightPaperMm / scale;
      texts2D.push(
        Object.freeze({
          id: annotation.id,
          position: dxfPoint(point),
          text: annotation.text,
          layer: annotation.layerId,
          height: annotationTextHeight,
          // 両座標系のY上向き角度はRenderPlanで解決済み。
          rotation: normalizeRotationDeg(annotation.rotationDeg[space]),
          anchor: annotation.anchor || 'middle',
          verticalAlign: 'middle',
        }),
      );
      usedLayerIds.add(annotation.layerId);
      continue;
    }

    throw new TypeError(`DXF writer未対応の注記図形です: ${annotation.kind}`);
  }

  for (const dimension of plan.dimensions || []) {
    if (dimension.visible === false || !layerVisible(dimension.layerId)) continue;
    for (const primitive of dimension.primitives || []) {
      if (primitive.kind === 'line') {
        const points = outputPoints(primitive.points, space);
        if (points.length !== 2) throw new TypeError('DXF寸法LINEには2点が必要です。');
        extendBounds(bounds, points[0]);
        extendBounds(bounds, points[1]);
        lines2D.push(
          Object.freeze({
            id: primitive.id,
            start: dxfPoint(points[0]),
            end: dxfPoint(points[1]),
            layer: dimension.layerId,
            lineType: resolveDashPatternLineType(
              primitive.style?.dashPatternPaperMm,
              primitive.id,
              'SDV dimension dash',
            ),
          }),
        );
        usedLayerIds.add(dimension.layerId);
        continue;
      }

      if (primitive.kind === 'polyline') {
        const points = outputPoints(primitive.points, space);
        for (const point of points) extendBounds(bounds, point);
        polylines2D.push(
          Object.freeze({
            id: primitive.id,
            points: Object.freeze(points.map(dxfPoint)),
            layer: dimension.layerId,
            closed: primitive.closed === true,
          }),
        );
        usedLayerIds.add(dimension.layerId);
        continue;
      }

      if (primitive.kind === 'circle') {
        const center = outputPoint(primitive.center, space);
        const radius = outputMagnitude(primitive.radius, space, 'DXF寸法円半径');
        extendBounds(bounds, [center[0] - radius, center[1] - radius]);
        extendBounds(bounds, [center[0] + radius, center[1] + radius]);
        circles2D.push(
          Object.freeze({
            id: primitive.id,
            center: dxfPoint(center),
            radius,
            layer: dimension.layerId,
          }),
        );
        usedLayerIds.add(dimension.layerId);
        continue;
      }

      if (primitive.kind === 'text') {
        if (/\r|\n/.test(primitive.text))
          throw new TypeError('R12 TEXTでは改行を含む寸法文字を出力できません。');
        const point = outputPoint(primitive.point, space);
        extendBounds(bounds, point);
        const heightPaperMm = primitive.style?.heightPaperMm;
        if (!Number.isFinite(heightPaperMm) || heightPaperMm <= 0)
          throw new TypeError('DrawingRenderPlan寸法文字高さが不正です。');
        texts2D.push(
          Object.freeze({
            id: primitive.id,
            position: dxfPoint(point),
            text: primitive.text,
            layer: dimension.layerId,
            height: space === 'paper' ? heightPaperMm : heightPaperMm / scale,
            rotation: normalizeRotationDeg(primitive.rotationDeg?.[space] || 0),
            anchor: 'middle',
            verticalAlign: 'middle',
          }),
        );
        usedLayerIds.add(dimension.layerId);
        continue;
      }

      throw new TypeError(
        `DXF writer未対応の寸法primitiveです: ${primitive.kind}/${primitive.role}`,
      );
    }
  }

  if (Array.isArray(plan.tags)) {
    for (const tag of plan.tags) {
      const element = elementByKey.get(tag.elementKey);
      if (!element)
        throw new Error(`DrawingRenderPlanのタグ対象部材が見つかりません: ${tag.elementKey}`);
      if (element.visible === false || !layerVisible(tag.layerId)) continue;
      for (const primitive of tag.primitives || []) {
        if (primitive.kind === 'anchor') continue;

        if (primitive.kind === 'line') {
          const points = outputCompiledPoints(primitive.points, space);
          if (points.length !== 2) throw new TypeError('DXFタグLINEには2点が必要です。');
          extendBounds(bounds, points[0]);
          extendBounds(bounds, points[1]);
          lines2D.push(
            Object.freeze({
              id: primitive.id,
              start: dxfPoint(points[0]),
              end: dxfPoint(points[1]),
              layer: tag.layerId,
            }),
          );
          usedLayerIds.add(tag.layerId);
          continue;
        }

        if (primitive.kind === 'polyline') {
          const points = outputCompiledPoints(primitive.points, space);
          for (const point of points) extendBounds(bounds, point);
          polylines2D.push(
            Object.freeze({
              id: primitive.id,
              points: Object.freeze(points.map(dxfPoint)),
              layer: tag.layerId,
              closed: primitive.closed === true,
            }),
          );
          usedLayerIds.add(tag.layerId);
          continue;
        }

        if (primitive.kind === 'circle') {
          const center = outputPoint(primitive.center, space);
          const radius = outputMagnitude(primitive.radius, space, '円半径');
          extendBounds(bounds, [center[0] - radius, center[1] - radius]);
          extendBounds(bounds, [center[0] + radius, center[1] + radius]);
          circles2D.push(
            Object.freeze({
              id: primitive.id,
              center: dxfPoint(center),
              radius,
              layer: tag.layerId,
            }),
          );
          usedLayerIds.add(tag.layerId);
          continue;
        }

        if (primitive.kind === 'text') {
          if (/\r|\n/.test(primitive.text))
            throw new TypeError('R12 TEXTでは改行を含むタグ文字を出力できません。');
          const point = outputPoint(primitive.point, space);
          extendBounds(bounds, point);
          texts2D.push(
            Object.freeze({
              id: primitive.id,
              position: dxfPoint(point),
              text: primitive.text,
              layer: tag.layerId,
              height: outputMagnitude(primitive.textHeight, space, '文字高さ'),
              rotation: normalizeRotationDeg(primitive.rotationDeg?.[space] || 0),
              anchor: primitive.textAnchor || 'middle',
              verticalAlign: 'middle',
            }),
          );
          usedLayerIds.add(tag.layerId);
          continue;
        }

        throw new TypeError(
          `DXF writer未対応のタグprimitiveです: ${primitive.kind}/${primitive.role}`,
        );
      }
    }
  }

  const finalizedBounds = finalizeBounds(bounds);
  const layers = Object.freeze([...usedLayerIds]);
  const diagnostics = collectAdapterDiagnostics(plan, usedLayerIds, texts2D, space);

  const exportLog = Object.freeze({
    adapterVersion: DRAWING_RENDER_PLAN_DXF_ADAPTER_VERSION,
    renderPlanSchemaVersion: plan.schemaVersion,
    profileId: plan.profile.id,
    preferredSpace: space,
    editableText: plan.profile.output?.editableText === true,
    editableDimensions: plan.profile.output?.editableDimensions === true,
    dimensionRepresentation: plan.profile.output?.dimensionRepresentation || 'exploded-line-text',
    modelKey: plan.source?.modelKey ?? null,
    modelRevision: plan.source?.modelRevision ?? null,
    drawingRevision: plan.source?.drawingRevision ?? null,
    viewType: plan.view?.type ?? null,
    storyId: plan.view?.storyId ?? null,
  });

  return Object.freeze({
    adapterVersion: DRAWING_RENDER_PLAN_DXF_ADAPTER_VERSION,
    space,
    units: 'mm',
    exportLog,
    bounds: finalizedBounds,
    layers,
    lines2D: Object.freeze(lines2D),
    polylines2D: Object.freeze(polylines2D),
    texts2D: Object.freeze(texts2D),
    circles2D: Object.freeze(circles2D),
    arcs2D: Object.freeze(arcs2D),
    lineTypes: Object.freeze(lineTypes),
    diagnostics,
    stats: Object.freeze({
      lines: lines2D.length,
      polylines: polylines2D.length,
      texts: texts2D.length,
      circles: circles2D.length,
      arcs: arcs2D.length,
      layers: layers.length,
      lineTypes: lineTypes.length,
    }),
  });
}

export function generateDrawingRenderPlanDxf(renderPlan, options = {}) {
  const entities = collectDrawingRenderPlanDxfEntities(renderPlan);
  const output = resolveDxfOutputOptions(options);
  const content = generatePlanDxfContent(
    entities.bounds,
    entities.layers,
    entities.lines2D,
    entities.polylines2D,
    entities.texts2D,
    entities.circles2D,
    entities.lineTypes,
    entities.arcs2D,
    { textStyle: output.textStyle },
  );
  return Object.freeze({ ...entities, outputProfile: output.profile, content });
}

export async function downloadDrawingRenderPlanDxf(
  renderPlan,
  filename,
  directoryHandle = null,
  options = {},
) {
  const result = generateDrawingRenderPlanDxf(renderPlan, options);
  await downloadDxf(result.content, filename, directoryHandle, { profile: result.outputProfile });
  return result;
}
