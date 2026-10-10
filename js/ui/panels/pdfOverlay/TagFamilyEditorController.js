/** @fileoverview paper-mm TagFamilyの構造化レイアウトエディタ。 */
import {
  TAG_FAMILY_PRIMITIVE_KINDS,
  normalizeTagFamily,
} from '../../../data/drawing/tags/tagFamilyDefinition.js';
import { TAG_TEXT_FORMATS } from '../../../data/drawing/tags/tagValueFormatter.js';
import { parseTagXPath } from '../../../data/drawing/tags/tagXPath.js';
import { TAG_XPATH_CATALOG_BY_CATEGORY } from '../../../data/drawing/tags/tagXPathCatalog.js';
import {
  addTagFamilyParameter,
  addTagFamilyPrimitive,
  commitTagFamilyDraft,
  removeTagFamilyParameter,
  removeTagFamilyPrimitive,
  updateTagFamilyParameter,
  updateTagFamilyPrimitive,
} from '../../../data/drawing/tags/tagFamilyEditorModel.js';
import {
  BUILTIN_TAG_FAMILIES,
  tagFamilyStbKeys,
} from '../../../data/drawing/tags/tagFamilyRegistry.js';
import { buildTagFamilyRenderPlan } from '../../../data/drawing/tags/tagFamilyRenderPlan.js';
import { createElementRef, elementRefKey } from '../../../data/drawing/drawingModel.js';
import { renderTagSvg } from '../../../viewer/drawing/svgTagRenderer.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PREVIEW_SCALE = 6;
const PREVIEW_ORIGIN = Object.freeze([240, 160]);
const PREVIEW_SIZE = Object.freeze([480, 320]);
const PREVIEW_COORDINATE_DIGITS = 1;
const PREVIEW_POINT_SNAP_DISTANCE = 10;
const PREVIEW_ORTHOGONAL_ANGLE = (7.5 * Math.PI) / 180;
const PREVIEW_ORTHOGONAL_TANGENT = Math.tan(PREVIEW_ORTHOGONAL_ANGLE);
const PREVIEW_MOVABLE_KINDS = new Set([
  'text',
  'parameter-text',
  'circled-value',
  'section-figure',
]);

function roundedPaperCoordinate(value) {
  const factor = 10 ** PREVIEW_COORDINATE_DIGITS;
  return Math.round(value * factor) / factor;
}

// プレビュー用サンプル値。XPath末尾の属性名で選び、無ければ属性名そのものを表示する。
const PREVIEW_ATTRIBUTE_TEXT = Object.freeze({
  id: '1',
  id_section: '10',
  name: 'C1',
  kind_structure: 'RC',
  kind_layout: 'ON_GIRDER',
  kind_wall: 'WALL_SHEAR',
  width: '300',
  depth: '850',
  thickness: '200',
  thickness_add_top: '50',
  thickness_add_bottom: '50',
  thickness_add_left: '100',
  thickness_add_right: '100',
  start_width: '300',
  end_width: '350',
  width_X: '800',
  width_Y: '800',
  D: '800',
  t: '200',
  base_depth: '200',
  tip_depth: '150',
  strength_concrete: 'FC30',
  shape: 'H-400x200x8x13',
  strength_main: 'SN490B',
  N_main_total: '12',
  N_main_X_1st: '4',
  N_main_Y_1st: '4',
  N_X: '4',
  N_Y: '4',
  N_main: '12',
  D_main: 'D25',
  D_band: 'D13',
  D_hoop: 'D13',
  pitch_band: '100',
  pitch_hoop: '100',
});

const previewBar = (cx, cy, role = 'main-bar') => ({
  type: 'circle',
  role,
  cx,
  cy,
  r: 12.5,
  filled: true,
});

// 800角・主筋X/Y各4本・中子X/Y各1本のRC柱断面(モデルmm、断面中心原点、Y下向き)。
const PREVIEW_COLUMN_FIGURE = Object.freeze({
  panels: [
    {
      key: 'SAME',
      label: null,
      width: 800,
      height: 800,
      shapes: [
        { type: 'rect', role: 'concrete', x: -400, y: -400, width: 800, height: 800 },
        { type: 'rect', role: 'hoop', x: -340, y: -340, width: 680, height: 680 },
        { type: 'line', role: 'tie', x1: -340, y1: 0, x2: 340, y2: 0 },
        { type: 'line', role: 'tie', x1: 0, y1: -340, x2: 0, y2: 340 },
        ...[-310, -103, 103, 310].flatMap((x) => [previewBar(x, -310), previewBar(x, 310)]),
        ...[-103, 103].flatMap((y) => [previewBar(-310, y), previewBar(310, y)]),
      ],
    },
  ],
});

const previewBeamPanel = (key, label, topCount, bottomCount) => ({
  key,
  label,
  captions: [`上端筋 ${topCount}-D25`, `下端筋 ${bottomCount}-D25`, 'STP 2-D13@200'],
  width: 400,
  height: 800,
  shapes: [
    { type: 'rect', role: 'concrete', x: -200, y: -400, width: 400, height: 800 },
    { type: 'rect', role: 'hoop', x: -150, y: -350, width: 300, height: 700 },
    ...Array.from({ length: topCount }, (_, i) =>
      previewBar(-122 + (244 * i) / (topCount - 1), -322),
    ),
    ...Array.from({ length: bottomCount }, (_, i) =>
      previewBar(-122 + (244 * i) / (bottomCount - 1), 322),
    ),
  ],
});

// 400x800のRC梁。両端部(上端4本/下端3本)と中央(上端2本/下端4本)。
const PREVIEW_BEAM_FIGURE = Object.freeze({
  panels: [previewBeamPanel('ENDS', '両端部', 4, 3), previewBeamPanel('CENTER', '中央', 2, 4)],
});

function previewValue(key, category) {
  const provenance = { kind: 'stb', path: key, rule: 'tag-family-editor-preview' };
  const xpath = parseTagXPath(key);
  if (xpath.resultKind === 'element')
    return {
      valueType: 'figure',
      value:
        xpath.paths[0].steps[0].name === 'StbSecBeam_RC'
          ? PREVIEW_BEAM_FIGURE
          : PREVIEW_COLUMN_FIGURE,
      provenance,
    };
  const attribute = xpath.paths[0].attribute;
  const sample =
    attribute === 'name' && category !== 'Column' && category !== 'Post'
      ? { Girder: 'G1', Beam: 'B1', Brace: 'V1', Slab: 'S1', Wall: 'W1' }[category]
      : PREVIEW_ATTRIBUTE_TEXT[attribute];
  return { valueType: 'text', value: sample ?? `@${attribute}`, provenance };
}

function rawFamily(family) {
  const value = JSON.parse(JSON.stringify(family));
  delete value.builtIn;
  return value;
}

function previewFacts(family) {
  const ref = createElementRef({ modelKey: 'PREVIEW' }, family.category, '1');
  const fields = {};
  for (const parameter of family.parameters)
    fields[parameter.key] = previewValue(parameter.key, family.category);
  return {
    schemaVersion: 1,
    ref,
    elementKey: elementRefKey(ref),
    source: { modelKey: 'PREVIEW', modelRevision: 'tag-family-editor-preview' },
    fields,
  };
}

function propertySpecs(kind) {
  const commonText = [
    ['x', 'X', 'number'],
    ['y', 'Y', 'number'],
    ['fontSize', '文字高(mm)', 'number'],
    ['align', '揃え', 'align'],
    ['haloWidth', '文字ハロー(mm)', 'number'],
  ];
  switch (kind) {
    case 'text':
      return [...commonText, ['text', '固定文字', 'text']];
    case 'parameter-text':
      return [...commonText, ['parameterId', 'パラメータ', 'parameter']];
    case 'circled-value':
      return [
        ...commonText,
        ['parameterId', 'パラメータ', 'parameter'],
        ['radius', '半径(mm)', 'number'],
        ['strokeWidth', '円線幅(mm)', 'number'],
      ];
    case 'line':
    case 'separator':
      return [
        ['x1', 'X1', 'number'],
        ['y1', 'Y1', 'number'],
        ['x2', 'X2', 'number'],
        ['y2', 'Y2', 'number'],
        ['strokeWidth', '線幅(mm)', 'number'],
      ];
    case 'rectangle':
      return [
        ['x', 'X', 'number'],
        ['y', 'Y', 'number'],
        ['width', '幅(mm)', 'number'],
        ['height', '高さ(mm)', 'number'],
        ['strokeWidth', '線幅(mm)', 'number'],
      ];
    case 'rounded-rectangle':
      return [
        ['x', 'X', 'number'],
        ['y', 'Y', 'number'],
        ['width', '幅(mm)', 'number'],
        ['height', '高さ(mm)', 'number'],
        ['radius', '角丸半径(mm)', 'number'],
        ['strokeWidth', '線幅(mm)', 'number'],
      ];
    case 'circle':
      return [
        ['x', 'X', 'number'],
        ['y', 'Y', 'number'],
        ['radius', '半径(mm)', 'number'],
        ['strokeWidth', '線幅(mm)', 'number'],
      ];
    case 'leader-anchor':
      return [
        ['x', 'X', 'number'],
        ['y', 'Y', 'number'],
      ];
    case 'section-figure':
      return [
        ['x', 'X(上辺中央)', 'number'],
        ['y', 'Y(上辺中央)', 'number'],
        ['parameterId', '断面図パラメータ', 'parameter'],
        ['scaleDenominator', '縮尺 1/n', 'number'],
        ['strokeWidth', '外形線幅(mm)', 'number'],
        ['fontSize', '状態文字高(mm)', 'number'],
      ];
    default:
      return [];
  }
}

export class TagFamilyEditorController {
  constructor(manager) {
    this.manager = manager;
    this.session = manager.session;
    this.root = manager.root;
    this.draft = null;
    this.selectedParameterId = null;
    this.selectedPrimitiveId = null;
    this.previewTool = 'select';
    this.previewDrag = null;
    this.bound = false;
  }

  e(id) {
    return this.root.querySelector(`#${id}`);
  }

  bindEvents() {
    if (this.bound || !this.e('pdf-overlay-tag-family-editor')) return;
    this.bound = true;
    this.e('pdf-overlay-tag-family-editor-close')?.addEventListener('click', () => this.close());
    this.e('pdf-overlay-tag-family-editor-cancel')?.addEventListener('click', () => this.close());
    this.e('pdf-overlay-tag-family-editor-save')?.addEventListener('click', () => this.save());
    this.e('pdf-overlay-tag-family-editor-parameter-preset')?.addEventListener(
      'change',
      (event) => {
        const input = this.e('pdf-overlay-tag-family-editor-parameter-key');
        if (input && event.target.value) input.value = event.target.value;
      },
    );
    this.e('pdf-overlay-tag-family-editor-add-parameter')?.addEventListener('click', () =>
      this.addParameter(),
    );
    this.e('pdf-overlay-tag-family-editor-add-primitive')?.addEventListener('click', () =>
      this.addPrimitive(),
    );
    this.e('pdf-overlay-tag-family-editor-apply-parameter')?.addEventListener('click', () =>
      this.applyParameter(),
    );
    this.e('pdf-overlay-tag-family-editor-apply-primitive')?.addEventListener('click', () =>
      this.applyPrimitive(),
    );
    this.e('pdf-overlay-tag-family-editor-remove-primitive')?.addEventListener('click', () =>
      this.removePrimitive(),
    );
    this.e('pdf-overlay-tag-family-editor-tool-select')?.addEventListener('click', () =>
      this.setPreviewTool('select'),
    );
    this.e('pdf-overlay-tag-family-editor-tool-line')?.addEventListener('click', () =>
      this.setPreviewTool('line'),
    );
    for (const id of [
      'pdf-overlay-tag-family-editor-snap-orthogonal',
      'pdf-overlay-tag-family-editor-snap-endpoint',
      'pdf-overlay-tag-family-editor-snap-geometry',
      'pdf-overlay-tag-family-editor-snap-shape',
    ]) {
      this.e(id)?.addEventListener('change', () => this.renderPreview());
    }
    const preview = this.e('pdf-overlay-tag-family-editor-preview');
    preview?.addEventListener('pointerdown', (event) => this.onPreviewPointerDown(event));
    preview?.addEventListener('pointermove', (event) => this.onPreviewPointerMove(event));
    preview?.addEventListener('pointerup', (event) => this.onPreviewPointerUp(event));
    preview?.addEventListener('pointercancel', (event) => this.onPreviewPointerCancel(event));
  }

  isOpen() {
    return !this.e('pdf-overlay-tag-family-editor')?.hidden;
  }

  open(familyInput) {
    try {
      const family = normalizeTagFamily(familyInput, { builtIn: familyInput?.builtIn === true });
      if (family.builtIn)
        throw new TypeError(
          '標準タグは読取専用です。先に「複製」でユーザー定義を作成してください。',
        );
      this.draft = normalizeTagFamily(rawFamily(family));
      this.selectedParameterId = this.draft.parameters[0]?.id ?? null;
      this.selectedPrimitiveId = this.draft.primitives[0]?.id ?? null;
      this.previewTool = 'select';
      this.previewDrag = null;
      const editor = this.e('pdf-overlay-tag-family-editor');
      editor.hidden = false;
      editor.setAttribute('aria-hidden', 'false');
      this.e('pdf-overlay-tag-family-editor-title').textContent = this.draft.name;
      this.e('pdf-overlay-tag-family-editor-subtitle').textContent =
        ` ${this.draft.category} / v${this.draft.version} / paper-mm`;
      this.refresh();
    } catch (error) {
      this.manager.fail(error);
    }
  }

  close() {
    const editor = this.e('pdf-overlay-tag-family-editor');
    if (editor) {
      editor.hidden = true;
      editor.setAttribute('aria-hidden', 'true');
    }
    this.cancelPreviewDrag({ rerender: false });
    this.draft = null;
    this.selectedParameterId = null;
    this.selectedPrimitiveId = null;
    this.previewTool = 'select';
  }

  status(message) {
    const node = this.e('pdf-overlay-tag-family-editor-status');
    if (node) node.textContent = message;
  }

  fail(error) {
    this.status(error?.message || 'タグレイアウト編集に失敗しました。');
  }

  setPreviewTool(tool) {
    if (!['select', 'line'].includes(tool))
      throw new TypeError(`未対応のプレビューツールです: ${tool}`);
    if (this.previewTool === tool) {
      this.refreshPreviewToolUi();
      return;
    }
    this.cancelPreviewDrag();
    this.previewTool = tool;
    this.refreshPreviewToolUi();
    this.status(
      tool === 'line'
        ? '線ツール: プレビュー上で始点から終点までドラッグしてください。'
        : '選択・移動: 文字要素をドラッグして位置を調整できます。',
    );
  }

  refreshPreviewToolUi() {
    const select = this.e('pdf-overlay-tag-family-editor-tool-select');
    const line = this.e('pdf-overlay-tag-family-editor-tool-line');
    const svg = this.e('pdf-overlay-tag-family-editor-preview');
    if (select) {
      select.classList.toggle('btn-primary', this.previewTool === 'select');
      select.classList.toggle('btn-secondary', this.previewTool !== 'select');
      select.setAttribute('aria-pressed', String(this.previewTool === 'select'));
    }
    if (line) {
      line.classList.toggle('btn-primary', this.previewTool === 'line');
      line.classList.toggle('btn-secondary', this.previewTool !== 'line');
      line.setAttribute('aria-pressed', String(this.previewTool === 'line'));
    }
    svg?.classList.toggle('is-line-tool', this.previewTool === 'line');
  }

  previewSvgPoint(event) {
    const svg = this.e('pdf-overlay-tag-family-editor-preview');
    if (!svg) throw new TypeError('タグプレビューがありません。');

    if (typeof svg.createSVGPoint === 'function' && typeof svg.getScreenCTM === 'function') {
      try {
        const matrix = svg.getScreenCTM();
        if (matrix && typeof matrix.inverse === 'function') {
          const point = svg.createSVGPoint();
          point.x = event.clientX;
          point.y = event.clientY;
          const local = point.matrixTransform(matrix.inverse());
          if (Number.isFinite(local.x) && Number.isFinite(local.y)) return [local.x, local.y];
        }
      } catch {
        // JSDOM等、SVG座標変換APIが未実装の環境ではviewBox比率へfallbackする。
      }
    }

    const rect = svg.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0))
      throw new RangeError('タグプレビューの表示サイズを取得できません。');
    return [
      (event.clientX - rect.left) * (PREVIEW_SIZE[0] / rect.width),
      (event.clientY - rect.top) * (PREVIEW_SIZE[1] / rect.height),
    ];
  }

  previewPaperPoint(event) {
    if (!this.draft) throw new TypeError('編集対象がありません。');
    const [x, y] = this.previewSvgPoint(event);
    const scale = PREVIEW_SCALE * this.draft.paperScale;
    return [
      roundedPaperCoordinate((x - PREVIEW_ORIGIN[0]) / scale),
      roundedPaperCoordinate((y - PREVIEW_ORIGIN[1]) / scale),
    ];
  }

  paperPointToPreview(point) {
    const scale = PREVIEW_SCALE * (this.draft?.paperScale ?? 1);
    return [PREVIEW_ORIGIN[0] + point[0] * scale, PREVIEW_ORIGIN[1] + point[1] * scale];
  }

  primitiveNodeFromEvent(event) {
    const node = event.target?.closest?.('[data-tag-family-primitive-id]');
    const svg = this.e('pdf-overlay-tag-family-editor-preview');
    return node && svg?.contains(node) ? node : null;
  }

  lineSegments() {
    if (!this.draft) return [];
    return this.draft.primitives
      .filter((primitive) => primitive.kind === 'line' || primitive.kind === 'separator')
      .map((primitive) => ({
        primitiveId: primitive.id,
        a: [primitive.x1, primitive.y1],
        b: [primitive.x2, primitive.y2],
      }));
  }

  lineEndpointCandidates() {
    const endpoints = [];
    for (const segment of this.lineSegments()) {
      endpoints.push(
        {
          kind: 'endpoint',
          priority: 0,
          primitiveId: segment.primitiveId,
          endpoint: 'start',
          point: segment.a,
        },
        {
          kind: 'endpoint',
          priority: 0,
          primitiveId: segment.primitiveId,
          endpoint: 'end',
          point: segment.b,
        },
      );
    }
    return endpoints;
  }

  lineMidpointCandidates() {
    return this.lineSegments().map((segment) => ({
      kind: 'midpoint',
      priority: 2,
      primitiveId: segment.primitiveId,
      point: [
        roundedPaperCoordinate((segment.a[0] + segment.b[0]) / 2),
        roundedPaperCoordinate((segment.a[1] + segment.b[1]) / 2),
      ],
    }));
  }

  segmentIntersection(first, second) {
    const [x1, y1] = first.a;
    const [x2, y2] = first.b;
    const [x3, y3] = second.a;
    const [x4, y4] = second.b;
    const dx1 = x2 - x1;
    const dy1 = y2 - y1;
    const dx2 = x4 - x3;
    const dy2 = y4 - y3;
    const denominator = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(denominator) < 1e-9) return null;
    const offsetX = x3 - x1;
    const offsetY = y3 - y1;
    const t = (offsetX * dy2 - offsetY * dx2) / denominator;
    const u = (offsetX * dy1 - offsetY * dx1) / denominator;
    const epsilon = 1e-9;
    if (t < -epsilon || t > 1 + epsilon || u < -epsilon || u > 1 + epsilon) return null;
    return [roundedPaperCoordinate(x1 + t * dx1), roundedPaperCoordinate(y1 + t * dy1)];
  }

  lineIntersectionCandidates() {
    const segments = this.lineSegments();
    const intersections = [];
    for (let first = 0; first < segments.length; first += 1) {
      for (let second = first + 1; second < segments.length; second += 1) {
        const point = this.segmentIntersection(segments[first], segments[second]);
        if (!point) continue;
        intersections.push({
          kind: 'intersection',
          priority: 1,
          primitiveIds: [segments[first].primitiveId, segments[second].primitiveId],
          point,
        });
      }
    }
    return intersections;
  }

  shapeSnapCandidates() {
    if (!this.draft) return [];
    const candidates = [];
    const push = (kind, priority, primitiveId, point, role) => {
      candidates.push({
        kind,
        priority,
        primitiveId,
        role,
        point: point.map(roundedPaperCoordinate),
      });
    };

    for (const primitive of this.draft.primitives) {
      if (primitive.kind === 'rectangle' || primitive.kind === 'rounded-rectangle') {
        const x1 = primitive.x;
        const y1 = primitive.y;
        const x2 = primitive.x + primitive.width;
        const y2 = primitive.y + primitive.height;
        push('shape-corner', 2, primitive.id, [x1, y1], 'top-left');
        push('shape-corner', 2, primitive.id, [x2, y1], 'top-right');
        push('shape-corner', 2, primitive.id, [x2, y2], 'bottom-right');
        push('shape-corner', 2, primitive.id, [x1, y2], 'bottom-left');
        push('shape-center', 4, primitive.id, [(x1 + x2) / 2, (y1 + y2) / 2], 'center');
        continue;
      }
      if (primitive.kind === 'circle' || primitive.kind === 'circled-value') {
        push('shape-center', 4, primitive.id, [primitive.x, primitive.y], 'center');
        continue;
      }
      if (primitive.kind === 'leader-anchor') {
        push('shape-anchor', 2, primitive.id, [primitive.x, primitive.y], 'anchor');
      }
    }
    return candidates;
  }

  endpointSnapEnabled() {
    return this.e('pdf-overlay-tag-family-editor-snap-endpoint')?.checked !== false;
  }

  geometrySnapEnabled() {
    return this.e('pdf-overlay-tag-family-editor-snap-geometry')?.checked !== false;
  }

  shapeSnapEnabled() {
    return this.e('pdf-overlay-tag-family-editor-snap-shape')?.checked !== false;
  }

  orthogonalSnapEnabled() {
    return this.e('pdf-overlay-tag-family-editor-snap-orthogonal')?.checked !== false;
  }

  lineSnapCandidates() {
    return [
      ...(this.endpointSnapEnabled() ? this.lineEndpointCandidates() : []),
      ...(this.geometrySnapEnabled()
        ? [...this.lineIntersectionCandidates(), ...this.lineMidpointCandidates()]
        : []),
      ...(this.shapeSnapEnabled() ? this.shapeSnapCandidates() : []),
    ];
  }

  candidateBelongsToPrimitive(candidate, primitiveId) {
    if (!primitiveId) return false;
    return (
      candidate.primitiveId === primitiveId ||
      candidate.primitiveIds?.includes?.(primitiveId) === true
    );
  }

  snapToLinePoint(
    point,
    { excludePrimitiveId = null, excludeEndpoint = null, excludeWholePrimitive = false } = {},
  ) {
    const target = this.paperPointToPreview(point);
    let best = null;
    for (const candidate of this.lineSnapCandidates()) {
      if (excludeWholePrimitive && this.candidateBelongsToPrimitive(candidate, excludePrimitiveId))
        continue;
      if (
        !excludeWholePrimitive &&
        candidate.kind === 'endpoint' &&
        candidate.primitiveId === excludePrimitiveId &&
        candidate.endpoint === excludeEndpoint
      )
        continue;
      const projected = this.paperPointToPreview(candidate.point);
      const distance = Math.hypot(projected[0] - target[0], projected[1] - target[1]);
      if (distance > PREVIEW_POINT_SNAP_DISTANCE) continue;
      if (
        !best ||
        candidate.priority < best.priority ||
        (candidate.priority === best.priority && distance < best.distance)
      )
        best = { ...candidate, distance };
    }
    return best;
  }

  resolveLineTranslation(drag, pointerPoint) {
    const rawDelta = [
      pointerPoint[0] - drag.pointerStart[0],
      pointerPoint[1] - drag.pointerStart[1],
    ];
    const rawStart = [
      roundedPaperCoordinate(drag.originStart[0] + rawDelta[0]),
      roundedPaperCoordinate(drag.originStart[1] + rawDelta[1]),
    ];
    const rawEnd = [
      roundedPaperCoordinate(drag.originEnd[0] + rawDelta[0]),
      roundedPaperCoordinate(drag.originEnd[1] + rawDelta[1]),
    ];
    const startSnap = this.snapToLinePoint(rawStart, {
      excludePrimitiveId: drag.primitiveId,
      excludeWholePrimitive: true,
    });
    const endSnap = this.snapToLinePoint(rawEnd, {
      excludePrimitiveId: drag.primitiveId,
      excludeWholePrimitive: true,
    });
    const selectedSnap =
      startSnap && endSnap
        ? startSnap.distance <= endSnap.distance
          ? { endpoint: 'start', snap: startSnap, rawPoint: rawStart }
          : { endpoint: 'end', snap: endSnap, rawPoint: rawEnd }
        : startSnap
          ? { endpoint: 'start', snap: startSnap, rawPoint: rawStart }
          : endSnap
            ? { endpoint: 'end', snap: endSnap, rawPoint: rawEnd }
            : null;

    let delta = rawDelta;
    if (selectedSnap) {
      delta = [
        rawDelta[0] + selectedSnap.snap.point[0] - selectedSnap.rawPoint[0],
        rawDelta[1] + selectedSnap.snap.point[1] - selectedSnap.rawPoint[1],
      ];
    }
    return {
      start: [
        roundedPaperCoordinate(drag.originStart[0] + delta[0]),
        roundedPaperCoordinate(drag.originStart[1] + delta[1]),
      ],
      end: [
        roundedPaperCoordinate(drag.originEnd[0] + delta[0]),
        roundedPaperCoordinate(drag.originEnd[1] + delta[1]),
      ],
      snapKind: selectedSnap?.snap.kind ?? null,
      snapPoint: selectedSnap?.snap.point ?? null,
      snappedEndpoint: selectedSnap?.endpoint ?? null,
    };
  }

  orthogonalLinePoint(start, point, { force = false } = {}) {
    const dx = point[0] - start[0];
    const dy = point[1] - start[1];
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX === 0 && absY === 0) return null;

    if (force) {
      return absX >= absY
        ? { point: [point[0], start[1]], kind: 'horizontal' }
        : { point: [start[0], point[1]], kind: 'vertical' };
    }
    if (!this.orthogonalSnapEnabled()) return null;
    if (absY <= absX * PREVIEW_ORTHOGONAL_TANGENT)
      return { point: [point[0], start[1]], kind: 'horizontal' };
    if (absX <= absY * PREVIEW_ORTHOGONAL_TANGENT)
      return { point: [start[0], point[1]], kind: 'vertical' };
    return null;
  }

  resolveLinePoint(start, point, event = null, snapOptions = {}) {
    const snap = this.snapToLinePoint(point, snapOptions);
    if (snap) return { point: [...snap.point], kind: snap.kind, snap };
    const orthogonal = this.orthogonalLinePoint(start, point, { force: event?.shiftKey === true });
    if (orthogonal) return orthogonal;
    return { point, kind: null };
  }

  snapKindLabel(kind) {
    return (
      {
        endpoint: '端点',
        intersection: '交点',
        midpoint: '中点',
        'shape-corner': '図形角点',
        'shape-center': '図形中心',
        'shape-anchor': 'アンカー',
        horizontal: '水平',
        vertical: '垂直',
      }[kind] || null
    );
  }

  setActivePreviewSnap(point, kind) {
    const svg = this.e('pdf-overlay-tag-family-editor-preview');
    if (!svg) return;
    let marker = svg.querySelector('.tag-family-editor-active-snap-point');
    if (!point || !kind) {
      marker?.remove();
      return;
    }
    if (!marker) {
      marker = this.root.ownerDocument.createElementNS(SVG_NS, 'circle');
      marker.setAttribute(
        'class',
        'tag-family-editor-active-snap-point tag-family-editor-snap-point',
      );
      marker.setAttribute('r', '6');
      svg.appendChild(marker);
    }
    const [x, y] = this.paperPointToPreview(point);
    marker.setAttribute('cx', String(x));
    marker.setAttribute('cy', String(y));
    marker.dataset.snapKind = kind;
  }

  renderPreviewSnapMarkers() {
    const svg = this.e('pdf-overlay-tag-family-editor-preview');
    if (!svg) return;
    const rendered = new Map();
    for (const candidate of this.lineSnapCandidates()) {
      const key = `${candidate.point[0]}:${candidate.point[1]}`;
      const previous = rendered.get(key);
      if (previous && previous.priority <= candidate.priority) continue;
      previous?.node.remove();
      const [x, y] = this.paperPointToPreview(candidate.point);
      const marker = this.root.ownerDocument.createElementNS(SVG_NS, 'circle');
      marker.setAttribute('cx', String(x));
      marker.setAttribute('cy', String(y));
      marker.setAttribute('r', candidate.kind === 'intersection' ? '4.5' : '4');
      marker.setAttribute('class', 'tag-family-editor-snap-point');
      marker.setAttribute('pointer-events', 'none');
      marker.dataset.snapKind = candidate.kind;
      svg.appendChild(marker);
      rendered.set(key, { priority: candidate.priority, node: marker });
    }
  }

  renderSelectedLineEndpointHandles() {
    const svg = this.e('pdf-overlay-tag-family-editor-preview');
    if (!svg) return;
    svg
      .querySelectorAll('.tag-family-editor-line-endpoint-handle')
      .forEach((node) => node.remove());
    const primitive = this.draft?.primitives.find(
      (candidate) => candidate.id === this.selectedPrimitiveId,
    );
    if (!primitive || (primitive.kind !== 'line' && primitive.kind !== 'separator')) return;
    for (const [endpoint, point] of [
      ['start', [primitive.x1, primitive.y1]],
      ['end', [primitive.x2, primitive.y2]],
    ]) {
      const [x, y] = this.paperPointToPreview(point);
      const handle = this.root.ownerDocument.createElementNS(SVG_NS, 'circle');
      handle.setAttribute('cx', String(x));
      handle.setAttribute('cy', String(y));
      handle.setAttribute('r', '6');
      handle.setAttribute('class', 'tag-family-editor-line-endpoint-handle');
      handle.dataset.tagFamilyLineEndpoint = endpoint;
      handle.dataset.tagFamilyPrimitiveId = primitive.id;
      svg.appendChild(handle);
    }
  }

  lineEndpointHandleFromEvent(event) {
    const handle = event.target?.closest?.('[data-tag-family-line-endpoint]');
    const svg = this.e('pdf-overlay-tag-family-editor-preview');
    return handle && svg?.contains(handle) ? handle : null;
  }

  selectPreviewPrimitive(primitiveId) {
    if (!primitiveId || !this.draft?.primitives.some((primitive) => primitive.id === primitiveId))
      return;
    this.selectedPrimitiveId = primitiveId;
    this.refreshPrimitiveList();
    this.refreshProperties();
    this.highlightPreviewSelection();
    this.renderSelectedLineEndpointHandles();
  }

  decoratePreviewNode(node, item) {
    const primitiveId = item.sourcePrimitiveId ?? item.id;
    const primitive = this.draft?.primitives.find((candidate) => candidate.id === primitiveId);
    if (!primitive) return;
    node.dataset.tagFamilyPrimitiveId = primitive.id;
    node.dataset.tagFamilyPrimitiveKind = primitive.kind;
    node.classList.add('tag-family-editor-preview-item');
    node.setAttribute('pointer-events', 'all');
    node
      .querySelectorAll?.('[pointer-events]')
      .forEach((child) => child.setAttribute('pointer-events', 'all'));
    if (PREVIEW_MOVABLE_KINDS.has(primitive.kind)) node.dataset.tagFamilyDraggable = 'true';
    if (primitive.kind === 'line' || primitive.kind === 'separator')
      node.dataset.tagFamilyLineDraggable = 'true';
  }

  highlightPreviewSelection() {
    const svg = this.e('pdf-overlay-tag-family-editor-preview');
    if (!svg) return;
    svg.querySelectorAll('[data-tag-family-primitive-id]').forEach((node) => {
      const selected = node.dataset.tagFamilyPrimitiveId === this.selectedPrimitiveId;
      node.classList.toggle('is-selected', selected);
      node.setAttribute('aria-selected', String(selected));
    });
  }

  capturePreviewPointer(pointerId) {
    const svg = this.e('pdf-overlay-tag-family-editor-preview');
    if (Number.isInteger(pointerId) && typeof svg?.setPointerCapture === 'function') {
      try {
        svg.setPointerCapture(pointerId);
      } catch {
        // pointer capture非対応環境ではSVG内のpointer eventだけで継続する。
      }
    }
  }

  releasePreviewPointer(pointerId) {
    const svg = this.e('pdf-overlay-tag-family-editor-preview');
    if (Number.isInteger(pointerId) && typeof svg?.releasePointerCapture === 'function') {
      try {
        svg.releasePointerCapture(pointerId);
      } catch {
        // 既にcaptureが解除済みの場合は無視する。
      }
    }
  }

  onPreviewPointerDown(event) {
    if (!this.draft || event.button !== 0) return;
    const pointerId = Number.isInteger(event.pointerId) ? event.pointerId : null;
    try {
      const rawStart = this.previewPaperPoint(event);
      if (this.previewTool === 'line') {
        const startSnap = this.snapToLinePoint(rawStart);
        const start = startSnap ? [...startSnap.point] : rawStart;
        const svg = this.e('pdf-overlay-tag-family-editor-preview');
        const draftLine = this.root.ownerDocument.createElementNS(SVG_NS, 'line');
        const [x, y] = this.paperPointToPreview(start);
        draftLine.setAttribute('x1', String(x));
        draftLine.setAttribute('y1', String(y));
        draftLine.setAttribute('x2', String(x));
        draftLine.setAttribute('y2', String(y));
        draftLine.setAttribute('class', 'tag-family-editor-preview-draft-line');
        svg.appendChild(draftLine);
        this.previewDrag = {
          type: 'draw-line',
          pointerId,
          start,
          startSnapKind: startSnap?.kind ?? null,
          last: start,
          snapKind: startSnap?.kind ?? null,
          draftLine,
        };
        this.setActivePreviewSnap(startSnap ? start : null, startSnap?.kind ?? null);
        this.capturePreviewPointer(pointerId);
        event.preventDefault();
        return;
      }

      const handle = this.lineEndpointHandleFromEvent(event);
      if (handle) {
        const primitiveId = handle.dataset.tagFamilyPrimitiveId;
        const endpoint = handle.dataset.tagFamilyLineEndpoint;
        this.selectPreviewPrimitive(primitiveId);
        const primitive = this.draft.primitives.find((candidate) => candidate.id === primitiveId);
        if (!primitive || !['line', 'separator'].includes(primitive.kind)) return;
        const movingPoint =
          endpoint === 'start' ? [primitive.x1, primitive.y1] : [primitive.x2, primitive.y2];
        const fixedPoint =
          endpoint === 'start' ? [primitive.x2, primitive.y2] : [primitive.x1, primitive.y1];
        const lineNode = this.e('pdf-overlay-tag-family-editor-preview')?.querySelector(
          `[data-tag-family-primitive-id="${primitiveId}"]:not(.tag-family-editor-line-endpoint-handle)`,
        );
        this.previewDrag = {
          type: 'move-line-endpoint',
          pointerId,
          primitiveId,
          endpoint,
          start: movingPoint,
          last: movingPoint,
          snapKind: null,
          fixedPoint,
          lineNode,
          handle,
        };
        this.e('pdf-overlay-tag-family-editor-preview')?.classList.add('is-endpoint-dragging');
        this.capturePreviewPointer(pointerId);
        event.preventDefault();
        return;
      }

      const node = this.primitiveNodeFromEvent(event);
      if (!node) return;
      const primitiveId = node.dataset.tagFamilyPrimitiveId;
      this.selectPreviewPrimitive(primitiveId);
      const primitive = this.draft.primitives.find((candidate) => candidate.id === primitiveId);
      if (!primitive) return;

      if (primitive.kind === 'line' || primitive.kind === 'separator') {
        this.previewDrag = {
          type: 'move-line',
          pointerId,
          primitiveId,
          pointerStart: rawStart,
          originStart: [primitive.x1, primitive.y1],
          originEnd: [primitive.x2, primitive.y2],
          last: {
            start: [primitive.x1, primitive.y1],
            end: [primitive.x2, primitive.y2],
            snapKind: null,
            snapPoint: null,
            snappedEndpoint: null,
          },
          lineNode: node,
        };
        this.e('pdf-overlay-tag-family-editor-preview')?.classList.add('is-line-dragging');
        this.capturePreviewPointer(pointerId);
        event.preventDefault();
        return;
      }

      if (!PREVIEW_MOVABLE_KINDS.has(primitive.kind)) return;
      this.previewDrag = {
        type: 'move',
        pointerId,
        primitiveId,
        start: rawStart,
        last: rawStart,
        origin: [primitive.x, primitive.y],
        node,
        originalTransform: node.getAttribute('transform') || '',
      };
      node.classList.add('is-dragging');
      this.capturePreviewPointer(pointerId);
      event.preventDefault();
    } catch (error) {
      this.fail(error);
    }
  }

  onPreviewPointerMove(event) {
    const drag = this.previewDrag;
    if (!drag) return;
    const pointerId = Number.isInteger(event.pointerId) ? event.pointerId : null;
    if (drag.pointerId !== null && pointerId !== drag.pointerId) return;
    try {
      const current = this.previewPaperPoint(event);
      drag.last = current;
      if (drag.type === 'draw-line') {
        const resolved = this.resolveLinePoint(drag.start, current, event);
        drag.last = resolved.point;
        drag.snapKind = resolved.kind;
        const [x, y] = this.paperPointToPreview(resolved.point);
        drag.draftLine?.setAttribute('x2', String(x));
        drag.draftLine?.setAttribute('y2', String(y));
        this.setActivePreviewSnap(resolved.kind ? resolved.point : null, resolved.kind);
      } else if (drag.type === 'move-line-endpoint') {
        const resolved = this.resolveLinePoint(drag.fixedPoint, current, event, {
          excludePrimitiveId: drag.primitiveId,
          excludeEndpoint: drag.endpoint,
        });
        drag.last = resolved.point;
        drag.snapKind = resolved.kind;
        const [x, y] = this.paperPointToPreview(resolved.point);
        const xAttribute = drag.endpoint === 'start' ? 'x1' : 'x2';
        const yAttribute = drag.endpoint === 'start' ? 'y1' : 'y2';
        drag.lineNode?.setAttribute(xAttribute, String(x));
        drag.lineNode?.setAttribute(yAttribute, String(y));
        drag.handle?.setAttribute('cx', String(x));
        drag.handle?.setAttribute('cy', String(y));
        this.setActivePreviewSnap(resolved.kind ? resolved.point : null, resolved.kind);
      } else if (drag.type === 'move-line') {
        const resolved = this.resolveLineTranslation(drag, current);
        drag.last = resolved;
        const [x1, y1] = this.paperPointToPreview(resolved.start);
        const [x2, y2] = this.paperPointToPreview(resolved.end);
        drag.lineNode?.setAttribute('x1', String(x1));
        drag.lineNode?.setAttribute('y1', String(y1));
        drag.lineNode?.setAttribute('x2', String(x2));
        drag.lineNode?.setAttribute('y2', String(y2));
        const svg = this.e('pdf-overlay-tag-family-editor-preview');
        svg
          ?.querySelector(
            `[data-tag-family-primitive-id="${drag.primitiveId}"][data-tag-family-line-endpoint="start"]`,
          )
          ?.setAttribute('cx', String(x1));
        svg
          ?.querySelector(
            `[data-tag-family-primitive-id="${drag.primitiveId}"][data-tag-family-line-endpoint="start"]`,
          )
          ?.setAttribute('cy', String(y1));
        svg
          ?.querySelector(
            `[data-tag-family-primitive-id="${drag.primitiveId}"][data-tag-family-line-endpoint="end"]`,
          )
          ?.setAttribute('cx', String(x2));
        svg
          ?.querySelector(
            `[data-tag-family-primitive-id="${drag.primitiveId}"][data-tag-family-line-endpoint="end"]`,
          )
          ?.setAttribute('cy', String(y2));
        this.setActivePreviewSnap(resolved.snapPoint, resolved.snapKind);
      } else if (drag.type === 'move') {
        const scale = PREVIEW_SCALE * this.draft.paperScale;
        const dx = (current[0] - drag.start[0]) * scale;
        const dy = (current[1] - drag.start[1]) * scale;
        const translate = `translate(${dx} ${dy})`;
        drag.node?.setAttribute(
          'transform',
          drag.originalTransform ? `${drag.originalTransform} ${translate}` : translate,
        );
      }
      event.preventDefault();
    } catch (error) {
      this.fail(error);
      this.cancelPreviewDrag();
    }
  }

  onPreviewPointerUp(event) {
    const drag = this.previewDrag;
    if (!drag) return;
    const pointerId = Number.isInteger(event.pointerId) ? event.pointerId : null;
    if (drag.pointerId !== null && pointerId !== drag.pointerId) return;
    this.releasePreviewPointer(drag.pointerId);
    try {
      let end = drag.last;
      let snapKind = drag.snapKind ?? null;
      try {
        const rawEnd = this.previewPaperPoint(event);
        if (drag.type === 'draw-line') {
          const resolved = this.resolveLinePoint(drag.start, rawEnd, event);
          end = resolved.point;
          snapKind = resolved.kind;
        } else if (drag.type === 'move-line-endpoint') {
          const resolved = this.resolveLinePoint(drag.fixedPoint, rawEnd, event, {
            excludePrimitiveId: drag.primitiveId,
            excludeEndpoint: drag.endpoint,
          });
          end = resolved.point;
          snapKind = resolved.kind;
        } else if (drag.type === 'move-line') {
          const resolved = this.resolveLineTranslation(drag, rawEnd);
          end = resolved;
          snapKind = resolved.snapKind;
        } else {
          end = rawEnd;
        }
      } catch {
        // pointerupがSVG外で発生した場合は最後に取得できた座標を使用する。
      }
      this.previewDrag = null;
      this.e('pdf-overlay-tag-family-editor-preview')?.classList.remove(
        'is-endpoint-dragging',
        'is-line-dragging',
      );
      this.setActivePreviewSnap(null, null);

      if (drag.type === 'draw-line') {
        drag.draftLine?.remove();
        const length = Math.hypot(end[0] - drag.start[0], end[1] - drag.start[1]);
        if (length < 0.2) {
          this.status('線の長さが短すぎるため追加しませんでした。');
          return;
        }
        let draft = addTagFamilyPrimitive(this.draft, 'line');
        const primitiveId = draft.primitives.at(-1).id;
        draft = updateTagFamilyPrimitive(draft, primitiveId, {
          x1: drag.start[0],
          y1: drag.start[1],
          x2: end[0],
          y2: end[1],
        });
        this.draft = draft;
        this.selectedPrimitiveId = primitiveId;
        this.refresh();
        const startLabel = this.snapKindLabel(drag.startSnapKind);
        const endLabel = this.snapKindLabel(snapKind);
        const snapNotes = [
          startLabel ? `始点=${startLabel}` : null,
          endLabel
            ? ['horizontal', 'vertical'].includes(snapKind)
              ? endLabel
              : `終点=${endLabel}`
            : null,
        ].filter(Boolean);
        this.status(
          `${primitiveId} をマウス操作で追加しました。${snapNotes.length ? ` (${snapNotes.join(' / ')})` : ''}`,
        );
        return;
      }

      if (drag.type === 'move-line-endpoint') {
        const patch =
          drag.endpoint === 'start' ? { x1: end[0], y1: end[1] } : { x2: end[0], y2: end[1] };
        this.draft = updateTagFamilyPrimitive(this.draft, drag.primitiveId, patch);
        this.selectedPrimitiveId = drag.primitiveId;
        this.refresh();
        const label = this.snapKindLabel(snapKind);
        this.status(
          `${drag.primitiveId} の${drag.endpoint === 'start' ? '始点' : '終点'}を X=${end[0]} mm / Y=${end[1]} mm へ移動しました。${label ? ` (${label})` : ''}`,
        );
        return;
      }

      if (drag.type === 'move-line') {
        this.draft = updateTagFamilyPrimitive(this.draft, drag.primitiveId, {
          x1: end.start[0],
          y1: end.start[1],
          x2: end.end[0],
          y2: end.end[1],
        });
        this.selectedPrimitiveId = drag.primitiveId;
        this.refresh();
        const label = this.snapKindLabel(snapKind);
        this.status(
          `${drag.primitiveId} を平行移動しました: (${end.start[0]}, ${end.start[1]}) → (${end.end[0]}, ${end.end[1]}) mm${label ? ` (${end.snappedEndpoint === 'start' ? '始点' : '終点'}=${label})` : ''}`,
        );
        return;
      }

      if (drag.type === 'move') {
        const x = roundedPaperCoordinate(drag.origin[0] + end[0] - drag.start[0]);
        const y = roundedPaperCoordinate(drag.origin[1] + end[1] - drag.start[1]);
        this.draft = updateTagFamilyPrimitive(this.draft, drag.primitiveId, { x, y });
        this.selectedPrimitiveId = drag.primitiveId;
        this.refresh();
        this.status(`${drag.primitiveId} を X=${x} mm / Y=${y} mm へ移動しました。`);
      }
    } catch (error) {
      this.previewDrag = null;
      this.renderPreview();
      this.fail(error);
    }
  }

  onPreviewPointerCancel(event) {
    const drag = this.previewDrag;
    if (!drag) return;
    const pointerId = Number.isInteger(event.pointerId) ? event.pointerId : null;
    if (drag.pointerId !== null && pointerId !== drag.pointerId) return;
    this.releasePreviewPointer(drag.pointerId);
    this.cancelPreviewDrag();
  }

  cancelPreviewDrag({ rerender = true } = {}) {
    const drag = this.previewDrag;
    if (!drag) return;
    drag.draftLine?.remove();
    this.releasePreviewPointer(drag.pointerId);
    this.previewDrag = null;
    this.e('pdf-overlay-tag-family-editor-preview')?.classList.remove(
      'is-endpoint-dragging',
      'is-line-dragging',
    );
    this.setActivePreviewSnap(null, null);
    if (rerender && this.draft) this.renderPreview();
  }

  refresh() {
    if (!this.draft) return;
    this.refreshParameterChoices();
    this.refreshParameterList();
    this.refreshParameterProperties();
    this.refreshPrimitiveList();
    this.refreshProperties();
    this.renderPreview();
    this.refreshPreviewToolUi();
  }

  /** カテゴリ別のSTB XPath候補。選ぶと入力欄へ写し、入力欄は自由に編集できる。 */
  refreshParameterChoices() {
    const select = this.e('pdf-overlay-tag-family-editor-parameter-preset');
    if (!select) return;
    const used = new Set(this.draft.parameters.map((parameter) => parameter.key));
    const entries = TAG_XPATH_CATALOG_BY_CATEGORY[this.draft.category] || [];
    select.replaceChildren();
    const placeholder = this.root.ownerDocument.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '候補から選択…';
    select.appendChild(placeholder);
    for (const entry of entries.filter((candidate) => !used.has(candidate.key))) {
      const option = this.root.ownerDocument.createElement('option');
      option.value = entry.key;
      option.textContent = entry.label;
      option.title = entry.key;
      select.appendChild(option);
    }
    select.value = '';
  }

  refreshParameterList() {
    const list = this.e('pdf-overlay-tag-family-editor-parameter-list');
    if (!list) return;
    list.replaceChildren();
    for (const parameter of this.draft.parameters) {
      const li = this.root.ownerDocument.createElement('li');
      const edit = this.root.ownerDocument.createElement('button');
      edit.type = 'button';
      edit.className =
        parameter.id === this.selectedParameterId
          ? 'btn btn-primary btn-sm tag-family-editor-item'
          : 'btn btn-secondary btn-sm tag-family-editor-item';
      edit.textContent = `${parameter.key} [${parameter.format}]`;
      edit.addEventListener('click', () => {
        this.selectedParameterId = parameter.id;
        this.refreshParameterList();
        this.refreshParameterProperties();
      });
      const remove = this.root.ownerDocument.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-secondary btn-sm';
      remove.textContent = '削除';
      remove.addEventListener('click', () => {
        try {
          this.draft = removeTagFamilyParameter(this.draft, parameter.id);
          if (this.selectedParameterId === parameter.id)
            this.selectedParameterId = this.draft.parameters[0]?.id ?? null;
          if (!this.draft.primitives.some((primitive) => primitive.id === this.selectedPrimitiveId))
            this.selectedPrimitiveId = this.draft.primitives[0]?.id ?? null;
          this.refresh();
          this.status(`${parameter.key} を削除しました。`);
        } catch (error) {
          this.fail(error);
        }
      });
      li.append(edit, remove);
      list.appendChild(li);
    }
  }

  refreshParameterProperties() {
    const panel = this.e('pdf-overlay-tag-family-editor-parameter-properties');
    const apply = this.e('pdf-overlay-tag-family-editor-apply-parameter');
    if (!panel) return;
    panel.replaceChildren();
    const parameter = this.draft?.parameters.find(
      (candidate) => candidate.id === this.selectedParameterId,
    );
    if (!parameter) {
      panel.textContent = 'パラメータを選択してください。';
      if (apply) apply.disabled = true;
      return;
    }

    const key = this.root.ownerDocument.createElement('div');
    key.className = 'workspace-result';
    key.textContent = parameter.key;
    panel.appendChild(key);

    const addSelect = (prop, labelText, values) => {
      const label = this.root.ownerDocument.createElement('label');
      label.textContent = labelText;
      const select = this.root.ownerDocument.createElement('select');
      select.className = 'form-control';
      select.dataset.tagFamilyParameterProperty = prop;
      for (const [value, text] of values) {
        const option = this.root.ownerDocument.createElement('option');
        option.value = value;
        option.textContent = text;
        select.appendChild(option);
      }
      select.value = parameter[prop] ?? '';
      label.appendChild(select);
      panel.appendChild(label);
    };
    const addInput = (prop, labelText, value) => {
      const label = this.root.ownerDocument.createElement('label');
      label.textContent = labelText;
      const input = this.root.ownerDocument.createElement('input');
      input.className = 'form-control';
      input.dataset.tagFamilyParameterProperty = prop;
      input.value = value ?? '';
      label.appendChild(input);
      panel.appendChild(label);
    };

    const formats =
      parameter.format === 'section-figure' ? ['section-figure'] : [...TAG_TEXT_FORMATS];
    addSelect(
      'format',
      '書式',
      formats.map((value) => [value, value]),
    );
    addInput('prefix', '接頭辞', parameter.prefix);
    addInput('suffix', '接尾辞', parameter.suffix);
    addSelect('unit', '単位', [
      ['', 'なし'],
      ['mm', 'mm'],
    ]);
    addInput('delimiter', '区切り', parameter.delimiter);
    addInput('missingText', 'missing表示', parameter.missingText);
    addInput('invalidText', 'invalid表示', parameter.invalidText);
    addInput('notApplicableText', 'not-applicable表示', parameter.notApplicableText);

    const zeroLabel = this.root.ownerDocument.createElement('label');
    const zero = this.root.ownerDocument.createElement('input');
    zero.type = 'checkbox';
    zero.checked = parameter.omitKnownZero;
    zero.dataset.tagFamilyParameterProperty = 'omitKnownZero';
    zeroLabel.append(zero, this.root.ownerDocument.createTextNode(' 既知0を省略'));
    panel.appendChild(zeroLabel);

    const optionalLabel = this.root.ownerDocument.createElement('label');
    const optional = this.root.ownerDocument.createElement('input');
    optional.type = 'checkbox';
    optional.checked = parameter.optional;
    optional.dataset.tagFamilyParameterProperty = 'optional';
    optionalLabel.append(optional, this.root.ownerDocument.createTextNode(' field欠落を許容'));
    panel.appendChild(optionalLabel);
    if (apply) apply.disabled = false;
  }

  refreshPrimitiveList() {
    const list = this.e('pdf-overlay-tag-family-editor-primitive-list');
    if (!list) return;
    list.replaceChildren();
    for (const primitive of this.draft.primitives) {
      const li = this.root.ownerDocument.createElement('li');
      const button = this.root.ownerDocument.createElement('button');
      button.type = 'button';
      button.className =
        primitive.id === this.selectedPrimitiveId
          ? 'btn btn-primary btn-sm tag-family-editor-item'
          : 'btn btn-secondary btn-sm tag-family-editor-item';
      button.textContent = `${primitive.id} / ${primitive.kind}`;
      button.addEventListener('click', () => {
        this.selectedPrimitiveId = primitive.id;
        this.refreshPrimitiveList();
        this.refreshProperties();
        this.highlightPreviewSelection();
        this.renderSelectedLineEndpointHandles();
      });
      li.appendChild(button);
      list.appendChild(li);
    }
  }

  refreshProperties() {
    const panel = this.e('pdf-overlay-tag-family-editor-properties');
    const apply = this.e('pdf-overlay-tag-family-editor-apply-primitive');
    const remove = this.e('pdf-overlay-tag-family-editor-remove-primitive');
    if (!panel) return;
    panel.replaceChildren();
    const primitive = this.draft?.primitives.find(
      (candidate) => candidate.id === this.selectedPrimitiveId,
    );
    if (!primitive) {
      panel.textContent = '図形要素を選択してください。';
      if (apply) apply.disabled = true;
      if (remove) remove.disabled = true;
      return;
    }

    const identity = this.root.ownerDocument.createElement('div');
    identity.className = 'workspace-result';
    identity.textContent = `${primitive.id} / ${primitive.kind}`;
    panel.appendChild(identity);

    for (const [key, labelText, type] of propertySpecs(primitive.kind)) {
      const label = this.root.ownerDocument.createElement('label');
      label.textContent = labelText;
      let input;
      if (type === 'align') {
        input = this.root.ownerDocument.createElement('select');
        for (const value of ['left', 'center', 'right']) {
          const option = this.root.ownerDocument.createElement('option');
          option.value = value;
          option.textContent = value;
          input.appendChild(option);
        }
      } else if (type === 'parameter') {
        input = this.root.ownerDocument.createElement('select');
        const figure = primitive.kind === 'section-figure';
        for (const parameter of this.draft.parameters) {
          if ((parameter.format === 'section-figure') !== figure) continue;
          const option = this.root.ownerDocument.createElement('option');
          option.value = parameter.id;
          option.textContent = `${parameter.key} (${parameter.id})`;
          input.appendChild(option);
        }
      } else {
        input = this.root.ownerDocument.createElement('input');
        input.type = type === 'number' ? 'number' : 'text';
        if (type === 'number') input.step = 'any';
      }
      input.className = 'form-control';
      input.dataset.tagFamilyPrimitiveProperty = key;
      input.value = primitive[key] ?? '';
      label.appendChild(input);
      panel.appendChild(label);
    }

    const conditionTitle = this.root.ownerDocument.createElement('strong');
    conditionTitle.textContent = '条件表示';
    panel.appendChild(conditionTitle);
    const conditionLabel = this.root.ownerDocument.createElement('label');
    conditionLabel.textContent = '判定パラメータ';
    const conditionParameter = this.root.ownerDocument.createElement('select');
    conditionParameter.className = 'form-control';
    conditionParameter.dataset.tagFamilyConditionParameter = 'true';
    const none = this.root.ownerDocument.createElement('option');
    none.value = '';
    none.textContent = '条件なし';
    conditionParameter.appendChild(none);
    for (const parameter of this.draft.parameters) {
      const option = this.root.ownerDocument.createElement('option');
      option.value = parameter.id;
      option.textContent = parameter.key;
      conditionParameter.appendChild(option);
    }
    conditionParameter.value = primitive.condition?.parameterId || '';
    conditionLabel.appendChild(conditionParameter);
    panel.appendChild(conditionLabel);

    const statuses = ['known', 'missing', 'invalid', 'not-applicable'];
    const selectedStatuses = new Set(primitive.condition?.statusIn || []);
    for (const status of statuses) {
      const label = this.root.ownerDocument.createElement('label');
      const checkbox = this.root.ownerDocument.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = status;
      checkbox.checked = selectedStatuses.has(status);
      checkbox.dataset.tagFamilyConditionStatus = 'true';
      label.append(checkbox, this.root.ownerDocument.createTextNode(` ${status}`));
      panel.appendChild(label);
    }
    if (apply) apply.disabled = false;
    if (remove) remove.disabled = false;
  }

  addParameter() {
    try {
      const input = this.e('pdf-overlay-tag-family-editor-parameter-key');
      const key = input?.value?.trim();
      if (!key) throw new TypeError('追加するSTB XPathを入力してください。');
      this.draft = addTagFamilyParameter(this.draft, key);
      const added = this.draft.parameters.at(-1);
      this.selectedParameterId = added?.id ?? this.selectedParameterId;
      this.selectedPrimitiveId = this.draft.primitives.at(-1)?.id ?? this.selectedPrimitiveId;
      if (input) input.value = '';
      this.refresh();
      this.status(`${added?.key ?? key} を追加しました。`);
    } catch (error) {
      this.fail(error);
    }
  }

  applyParameter() {
    try {
      if (!this.selectedParameterId) throw new TypeError('パラメータを選択してください。');
      const patch = {};
      this.e('pdf-overlay-tag-family-editor-parameter-properties')
        ?.querySelectorAll('[data-tag-family-parameter-property]')
        .forEach((input) => {
          const key = input.dataset.tagFamilyParameterProperty;
          patch[key] = input.type === 'checkbox' ? input.checked : input.value;
        });
      this.draft = updateTagFamilyParameter(this.draft, this.selectedParameterId, patch);
      this.refresh();
      this.status(`${this.selectedParameterId} の表示設定を更新しました。`);
    } catch (error) {
      this.fail(error);
    }
  }

  addPrimitive() {
    try {
      const kind = this.e('pdf-overlay-tag-family-editor-primitive-kind')?.value;
      if (!TAG_FAMILY_PRIMITIVE_KINDS.includes(kind))
        throw new TypeError('追加する図形要素が不正です。');
      this.draft = addTagFamilyPrimitive(this.draft, kind);
      this.selectedPrimitiveId = this.draft.primitives.at(-1)?.id ?? null;
      this.refresh();
      this.status(`${kind} を追加しました。`);
    } catch (error) {
      this.fail(error);
    }
  }

  applyPrimitive() {
    try {
      if (!this.selectedPrimitiveId) throw new TypeError('図形要素を選択してください。');
      const patch = {};
      const properties = this.e('pdf-overlay-tag-family-editor-properties');
      properties?.querySelectorAll('[data-tag-family-primitive-property]').forEach((input) => {
        const key = input.dataset.tagFamilyPrimitiveProperty;
        patch[key] = input.type === 'number' ? Number(input.value) : input.value;
      });
      const conditionParameter = properties?.querySelector(
        '[data-tag-family-condition-parameter]',
      )?.value;
      if (conditionParameter) {
        const statusIn = [
          ...properties.querySelectorAll('[data-tag-family-condition-status]:checked'),
        ].map((input) => input.value);
        if (!statusIn.length)
          throw new TypeError('条件表示を使う場合は1つ以上のstatusを選択してください。');
        patch.condition = { parameterId: conditionParameter, statusIn };
      } else {
        patch.condition = null;
      }
      this.draft = updateTagFamilyPrimitive(this.draft, this.selectedPrimitiveId, patch);
      this.refresh();
      this.status(`${this.selectedPrimitiveId} のプロパティを更新しました。`);
    } catch (error) {
      this.fail(error);
    }
  }

  removePrimitive() {
    try {
      if (!this.selectedPrimitiveId) throw new TypeError('図形要素を選択してください。');
      const removed = this.selectedPrimitiveId;
      this.draft = removeTagFamilyPrimitive(this.draft, removed);
      this.selectedPrimitiveId = this.draft.primitives[0]?.id ?? null;
      this.refresh();
      this.status(`${removed} を削除しました。`);
    } catch (error) {
      this.fail(error);
    }
  }

  previewFacts() {
    const context = this.session.selectedTagContext?.();
    if (context?.ref?.elementType === this.draft.category) {
      try {
        if (typeof this.session.panel.tagFactsResolver !== 'function')
          throw new Error('STBタグfacts resolverがありません。');
        const facts = this.session.panel.tagFactsResolver(
          context.ref,
          tagFamilyStbKeys(this.draft),
        );
        return { facts, source: '選択部材のSTB値' };
      } catch {
        // 未対応カテゴリやresolver不在は、推定ではなく明示的なプレビュー用サンプルへ退避する。
      }
    }
    return { facts: previewFacts(this.draft), source: 'プレビュー用サンプル値' };
  }

  renderPreview() {
    const svg = this.e('pdf-overlay-tag-family-editor-preview');
    const status = this.e('pdf-overlay-tag-family-editor-preview-status');
    if (!svg || !this.draft) return;
    svg.replaceChildren();

    const background = this.root.ownerDocument.createElementNS(SVG_NS, 'rect');
    background.setAttribute('x', '0');
    background.setAttribute('y', '0');
    background.setAttribute('width', '480');
    background.setAttribute('height', '320');
    background.setAttribute('class', 'tag-family-editor-preview-background');
    svg.appendChild(background);

    for (let x = PREVIEW_ORIGIN[0] % (10 * PREVIEW_SCALE); x <= 480; x += 10 * PREVIEW_SCALE) {
      const line = this.root.ownerDocument.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(x));
      line.setAttribute('y1', '0');
      line.setAttribute('x2', String(x));
      line.setAttribute('y2', '320');
      line.setAttribute('class', 'tag-family-editor-grid');
      svg.appendChild(line);
    }
    for (let y = PREVIEW_ORIGIN[1] % (10 * PREVIEW_SCALE); y <= 320; y += 10 * PREVIEW_SCALE) {
      const line = this.root.ownerDocument.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', '0');
      line.setAttribute('y1', String(y));
      line.setAttribute('x2', '480');
      line.setAttribute('y2', String(y));
      line.setAttribute('class', 'tag-family-editor-grid');
      svg.appendChild(line);
    }

    try {
      const preview = this.previewFacts();
      const plan = buildTagFamilyRenderPlan({ facts: preview.facts, family: this.draft });
      const nodes = renderTagSvg({
        plan,
        originCss: PREVIEW_ORIGIN,
        paperMmToCss: PREVIEW_SCALE,
        document: this.root.ownerDocument,
      });
      nodes.forEach((node, index) => this.decoratePreviewNode(node, plan.items[index]));
      svg.append(...nodes);
      this.renderPreviewSnapMarkers();
      this.highlightPreviewSelection();
      this.renderSelectedLineEndpointHandles();
      this.refreshPreviewToolUi();
      if (status)
        status.textContent = `${preview.source} / 1 mm = ${PREVIEW_SCALE} px / family倍率 ${Math.round(this.draft.paperScale * 100)}%`;
    } catch (error) {
      if (status) status.textContent = `プレビュー不可: ${error.message}`;
    }
  }

  save() {
    try {
      if (!this.draft) throw new TypeError('編集対象がありません。');
      const result = commitTagFamilyDraft(this.manager.state(), this.draft, {
        builtIns: BUILTIN_TAG_FAMILIES,
      });
      this.manager.applyState(result.state, { render: true });
      const familySelect = this.manager.e('pdf-overlay-tag-family');
      if (familySelect) familySelect.value = result.family.id;
      this.manager.refreshDetails();
      this.manager.status(
        `${result.family.name} のレイアウトを v${result.family.version} として保存しました。`,
      );
      this.close();
    } catch (error) {
      this.fail(error);
    }
  }
}
