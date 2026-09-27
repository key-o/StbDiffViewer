/** @fileoverview PDF上のSTB輪郭線を利用した2D寸法測定コントローラー。 */
import { invertAffine, multiplyAffine, transformPoint } from '../../../data/drawing/affine2d.js';
import { eventBus, MeasurementEvents } from '../../../data/events/index.js';
import { ELEMENT_LABELS } from '../../../config/elementLabels.js';
import {
  areParallelDirections,
  createProjectedPlanMeasurement,
  findNearestDrawingSegment,
} from '../../../app/pdfOverlay/planMeasurement.js';
import { showInfo, showWarning } from '../../common/toast.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SNAP_TOLERANCE_PX = 14;
const DEFAULT_DIMENSION_OFFSET_PX = 18;
const ID_PREFIX = 'pdf-overlay:';

function createSvg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

function scale(vector, factor) {
  return [vector[0] * factor, vector[1] * factor];
}

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1]);
  return length > 1e-9 ? [vector[0] / length, vector[1] / length] : [1, 0];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

function transformVector(matrix, vector) {
  return [
    matrix[0] * vector[0] + matrix[2] * vector[1],
    matrix[1] * vector[0] + matrix[3] * vector[1],
  ];
}

function measurementModelBasis(measurement) {
  const direction = normalize([
    measurement.p2[0] - measurement.p1[0],
    measurement.p2[1] - measurement.p1[1],
  ]);
  return {
    direction,
    offsetDirection: [-direction[1], direction[0]],
  };
}

/**
 * 未移動寸法の18px逃げを現在のmodel→CSS倍率からmodel(mm)へ変換する。
 * 一度ドラッグした後はmodel座標のoffsetを正本とするため、表示倍率を変えても位置関係を保持する。
 */
export function resolveMeasurementOffsetModelMm(
  measurement,
  modelToCss,
  defaultOffsetPx = DEFAULT_DIMENSION_OFFSET_PX,
) {
  if (Number.isFinite(measurement?.offsetModelMm)) return measurement.offsetModelMm;
  const { offsetDirection } = measurementModelBasis(measurement);
  const mappedOffset = transformVector(modelToCss, offsetDirection);
  const pxPerMm = Math.hypot(mappedOffset[0], mappedOffset[1]);
  if (!(pxPerMm > 1e-9)) return 0;

  const p1 = transformPoint(modelToCss, measurement.p1);
  const p2 = transformPoint(modelToCss, measurement.p2);
  const screenDirection = normalize(subtract(p2, p1));
  const screenOffsetDirection = [-screenDirection[1], screenDirection[0]];
  const sign = dot(mappedOffset, screenOffsetDirection) >= 0 ? 1 : -1;
  return (sign * defaultOffsetPx) / pxPerMm;
}

/** Pointer drag量を寸法線直交方向へだけ射影し、model(mm)の新しいoffsetを返す。 */
export function projectMeasurementDragOffset({
  measurement,
  modelToCss,
  startCss,
  currentCss,
  startOffsetModelMm,
} = {}) {
  if (!Array.isArray(startCss) || !Array.isArray(currentCss))
    throw new TypeError('ドラッグ座標が不正です。');
  const inverse = invertAffine(modelToCss);
  const startModel = transformPoint(inverse, startCss);
  const currentModel = transformPoint(inverse, currentCss);
  const { offsetDirection } = measurementModelBasis(measurement);
  const base = Number.isFinite(startOffsetModelMm)
    ? startOffsetModelMm
    : resolveMeasurementOffsetModelMm(measurement, modelToCss);
  return base + dot(subtract(currentModel, startModel), offsetDirection);
}

function line(group, start, end, className) {
  group.append(
    createSvg('line', {
      x1: start[0],
      y1: start[1],
      x2: end[0],
      y2: end[1],
      class: className,
      'vector-effect': 'non-scaling-stroke',
    }),
  );
}

export class PdfOverlayMeasurementController {
  constructor(panel) {
    this.panel = panel;
    this.active = false;
    this.firstPick = null;
    this.measurements = [];
    this.nextId = 1;
    this.suppressNextStageClick = false;
    this.suppressClickTimer = null;
    this.bindEvents();
  }

  bindEvents() {
    eventBus.on(MeasurementEvents.MODE_ENTERED, () => {
      this.active = true;
      this.panel.sessionUi?.cancelDrawingMemo();
      this.panel.regionUi?.cancelSelection();
      this.panel.anchorPickTarget = null;
      this.panel.gizmoPickOrigin = false;
      this.panel.e['pdf-overlay-stage']?.classList.add('measurement-mode');
      this.panel.renderOverlay();
    });
    eventBus.on(MeasurementEvents.MODE_EXITED, () => {
      this.active = false;
      this.firstPick = null;
      this.measurements = [];
      this.nextId = 1;
      this.panel.e['pdf-overlay-stage']?.classList.remove('measurement-mode');
      this.panel.renderOverlay();
    });
    eventBus.on(MeasurementEvents.DELETE_REQUESTED, ({ id } = {}) => {
      this.deleteMeasurement(id);
    });
    eventBus.on(MeasurementEvents.SEQUENCE_RESET, () => {
      this.resetPendingSequence();
    });
  }

  resetPendingSequence() {
    if (!this.firstPick) return false;
    this.firstPick = null;
    this.panel.renderOverlay();
    return true;
  }

  isActive() {
    return this.active;
  }

  suppressStageClickTemporarily() {
    this.suppressNextStageClick = true;
    if (this.suppressClickTimer != null) globalThis.clearTimeout(this.suppressClickTimer);
    this.suppressClickTimer = globalThis.setTimeout(() => {
      this.suppressNextStageClick = false;
      this.suppressClickTimer = null;
    }, 0);
  }

  consumeSuppressedStageClick() {
    if (!this.suppressNextStageClick) return false;
    this.suppressNextStageClick = false;
    if (this.suppressClickTimer != null) globalThis.clearTimeout(this.suppressClickTimer);
    this.suppressClickTimer = null;
    return true;
  }

  invalidateDrawing() {
    const ids = this.measurements.map((measurement) => measurement.id);
    this.firstPick = null;
    this.measurements = [];
    this.nextId = 1;
    for (const id of ids) eventBus.emit(MeasurementEvents.MEASUREMENT_DELETED, { id });
    if (this.active) eventBus.emit(MeasurementEvents.SEQUENCE_RESET);
  }

  findHit(event) {
    return findNearestDrawingSegment({
      drawing: this.panel.drawing,
      modelToCss: this.panel.currentModelToCss,
      cssPoint: this.panel.stagePoint(event),
      tolerancePx: SNAP_TOLERANCE_PX,
    });
  }

  handleStageClick(event) {
    if (!this.active) return false;

    if (
      this.panel.viewportMode() !== 'pdf' ||
      !this.panel.drawing ||
      !this.panel.currentModelToCss
    ) {
      showWarning('PDF照合表示でSTB図面を生成してから寸法測定してください。');
      return true;
    }

    const hit = this.findHit(event);
    if (!hit) {
      showWarning('STB要素の線の近くをクリックしてください。');
      return true;
    }

    if (!this.firstPick) {
      // 3D側に未完了の1点目が残っていても、新しいPDF測定へ持ち越さない。
      eventBus.emit(MeasurementEvents.SEQUENCE_RESET, {
        targetSurface: 'pdf-overlay',
        reason: 'first-pick',
      });
      this.firstPick = hit;
      const elementType = hit.ref?.elementType || null;
      eventBus.emit(MeasurementEvents.FIRST_POINT_PICKED, {
        point: [...hit.point],
        normal: [...hit.normal],
        surface: 'pdf-overlay',
        elementInfo: {
          elementType,
          elementLabel: elementType ? ELEMENT_LABELS[elementType] || elementType : null,
          elementName: hit.mark || null,
          modelSide: hit.ref?.modelKey || null,
        },
      });
      this.panel.renderOverlay();
      showInfo('1本目のSTB線を取得しました。2本目の線をクリックしてください。');
      return true;
    }

    if (!areParallelDirections(this.firstPick.tangent, hit.tangent)) {
      showWarning('平行なSTB線を選択してください。PDF図面の寸法測定は平行線間に限定しています。');
      return true;
    }

    const projected = createProjectedPlanMeasurement(this.firstPick, hit);
    if (!projected) {
      showWarning('1 mm未満のため測定を確定しません。別のSTB線を選択してください。');
      return true;
    }

    const modelToPdf =
      this.panel.pageRender?.cssToPdf && this.panel.currentModelToCss
        ? multiplyAffine(this.panel.pageRender.cssToPdf, this.panel.currentModelToCss)
        : null;
    const measurement = {
      ...projected,
      id: `${ID_PREFIX}${this.nextId++}`,
      pageNumber: this.panel.pageRender?.pageNumber ?? null,
      modelToPdf,
      offsetModelMm: null,
    };
    this.measurements.push(measurement);
    this.firstPick = null;

    eventBus.emit(MeasurementEvents.MEASUREMENT_COMPLETED, {
      id: measurement.id,
      distance: measurement.distance,
      p1: [...measurement.p1],
      p2: [...measurement.p2],
      surface: 'pdf-overlay',
    });

    this.panel.renderOverlay();
    return true;
  }

  deleteMeasurement(id) {
    if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) return false;
    const index = this.measurements.findIndex((measurement) => measurement.id === id);
    if (index < 0) return false;
    this.measurements.splice(index, 1);
    eventBus.emit(MeasurementEvents.MEASUREMENT_DELETED, { id });
    this.panel.renderOverlay();
    return true;
  }

  appendVisuals(svg) {
    if (!svg || !this.panel.currentModelToCss) return;
    if (!this.firstPick && this.measurements.length === 0) return;

    const pageNumber = this.panel.pageRender?.pageNumber ?? null;
    const visibleMeasurements = this.measurements.filter(
      (measurement) => measurement.pageNumber == null || measurement.pageNumber === pageNumber,
    );
    if (!this.firstPick && visibleMeasurements.length === 0) return;

    const group = createSvg('g', {
      class: 'pdf-overlay-measurements',
    });

    for (const measurement of visibleMeasurements)
      this.appendMeasurement(group, measurement, this.panel.currentModelToCss);
    if (this.firstPick) this.appendFirstPick(group, this.firstPick, this.panel.currentModelToCss);

    svg.append(group);
  }

  appendFirstPick(group, hit, modelToCss) {
    const start = transformPoint(modelToCss, hit.segment.start);
    const end = transformPoint(modelToCss, hit.segment.end);
    const point = transformPoint(modelToCss, hit.point);
    const normalEnd = transformPoint(modelToCss, [
      hit.point[0] + hit.normal[0] * 100,
      hit.point[1] + hit.normal[1] * 100,
    ]);
    const screenNormal = normalize([normalEnd[0] - point[0], normalEnd[1] - point[1]]);

    line(group, start, end, 'pdf-overlay-measurement-source-line');
    line(group, point, add(point, scale(screenNormal, 28)), 'pdf-overlay-measurement-normal');

    group.append(
      createSvg('circle', {
        cx: point[0],
        cy: point[1],
        r: 5,
        class: 'pdf-overlay-measurement-pick',
        'vector-effect': 'non-scaling-stroke',
      }),
    );
  }

  appendMeasurement(group, measurement, modelToCss) {
    const p1 = transformPoint(modelToCss, measurement.p1);
    const p2 = transformPoint(modelToCss, measurement.p2);
    const dimDirection = normalize(subtract(p2, p1));
    const offsetDirection = [-dimDirection[1], dimDirection[0]];
    let offset;

    if (Number.isFinite(measurement.offsetModelMm)) {
      const { offsetDirection: modelOffsetDirection } = measurementModelBasis(measurement);
      const offsetModelPoint = add(
        measurement.p1,
        scale(modelOffsetDirection, measurement.offsetModelMm),
      );
      const offsetCssPoint = transformPoint(modelToCss, offsetModelPoint);
      offset = subtract(offsetCssPoint, p1);
    } else {
      offset = scale(offsetDirection, DEFAULT_DIMENSION_OFFSET_PX);
    }

    const dimStart = add(p1, offset);
    const dimEnd = add(p2, offset);

    line(group, p1, dimStart, 'pdf-overlay-measurement-extension');
    line(group, p2, dimEnd, 'pdf-overlay-measurement-extension');

    const draggable = createSvg('g', {
      class: 'pdf-overlay-measurement-draggable',
      'data-measurement-id': measurement.id,
    });
    line(draggable, dimStart, dimEnd, 'pdf-overlay-measurement-hit');
    line(draggable, dimStart, dimEnd, 'pdf-overlay-measurement-dimension');

    this.appendArrow(draggable, dimStart, dimDirection);
    this.appendArrow(draggable, dimEnd, scale(dimDirection, -1));

    for (const point of [p1, p2]) {
      group.append(
        createSvg('circle', {
          cx: point[0],
          cy: point[1],
          r: 4,
          class: 'pdf-overlay-measurement-pick',
          'vector-effect': 'non-scaling-stroke',
        }),
      );
    }

    const labelSide = dot(offset, offsetDirection) >= 0 ? 1 : -1;
    const labelPoint = [
      (dimStart[0] + dimEnd[0]) / 2 + offsetDirection[0] * 10 * labelSide,
      (dimStart[1] + dimEnd[1]) / 2 + offsetDirection[1] * 10 * labelSide,
    ];
    const text = createSvg('text', {
      x: labelPoint[0],
      y: labelPoint[1],
      class: 'pdf-overlay-measurement-label',
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      'data-measurement-id': measurement.id,
    });
    text.textContent = `${Math.round(measurement.distance).toLocaleString()} mm`;
    draggable.append(text);
    this.bindMeasurementDrag(draggable, measurement, modelToCss);
    group.append(draggable);
  }

  bindMeasurementDrag(target, measurement, modelToCss) {
    target.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    target.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const startCss = this.panel.stagePoint(event);
      const startOffsetModelMm = resolveMeasurementOffsetModelMm(measurement, modelToCss);
      measurement.offsetModelMm = startOffsetModelMm;
      const eventTarget = target.ownerDocument?.defaultView || globalThis;

      const move = (moveEvent) => {
        measurement.offsetModelMm = projectMeasurementDragOffset({
          measurement,
          modelToCss,
          startCss,
          currentCss: this.panel.stagePoint(moveEvent),
          startOffsetModelMm,
        });
        this.panel.renderOverlay();
      };
      const finish = () => {
        eventTarget.removeEventListener('pointermove', move);
        eventTarget.removeEventListener('pointerup', finish);
        eventTarget.removeEventListener('pointercancel', finish);
        this.suppressStageClickTemporarily();
        this.panel.renderOverlay();
      };

      eventTarget.addEventListener('pointermove', move);
      eventTarget.addEventListener('pointerup', finish, { once: true });
      eventTarget.addEventListener('pointercancel', finish, { once: true });
    });
  }

  appendArrow(group, tip, inwardDirection) {
    const direction = normalize(inwardDirection);
    const perp = [-direction[1], direction[0]];
    const length = 8;
    const width = 4;
    const base = add(tip, scale(direction, length));
    line(group, tip, add(base, scale(perp, width)), 'pdf-overlay-measurement-dimension');
    line(group, tip, add(base, scale(perp, -width)), 'pdf-overlay-measurement-dimension');
  }
}
