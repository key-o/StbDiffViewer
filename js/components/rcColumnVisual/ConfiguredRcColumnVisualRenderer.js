/**
 * RC柱断面リスト用の作図設定付きSVGレンダラー。
 *
 * 配筋位置は columnScheduleModel のmm座標を唯一の基準とし、
 * 本クラスは共通モデルをSVGへ投影するだけにする。
 */

import { createSvgElement } from './rebarSymbolDefs.js';
import {
  appendRcRectangularConcrete,
  appendRcRectangularDimensions,
  createRcSectionProjection,
  createRcSectionSvg,
  placeRcBarSymbol,
  serializeRcSvg,
} from '../rcVisualSvg.js';
import { resolveRcScheduleProfile } from '../rcScheduleProfile.js';
import { buildColumnScheduleGeometry } from './columnScheduleModel.js';
import {
  BASELINE_COLUMN_COVER_FACES,
  averageColumnCoverFaces,
  normalizeColumnCoverFaces,
} from '../../ui/panels/sectionList/columnSectionCover.js';

const COL_BAR_PREFIX = 'col-bar';

export class ConfiguredRcColumnVisualRenderer {
  constructor(options = {}) {
    this.settings = {
      maxWidth: options.maxWidth || 150,
      maxHeight: options.maxHeight || 150,
      padding: options.padding || 25,
      showDimensions: options.showDimensions !== false,
    };
    this.scheduleProfile = resolveRcScheduleProfile(options.scheduleProfile || {});
    this.coverFaces = normalizeColumnCoverFaces(
      options.coverFaces || this.scheduleProfile.column.hoopCenterFaces || BASELINE_COLUMN_COVER_FACES,
    );
  }

  setCoverFaces(coverFaces) {
    this.coverFaces = normalizeColumnCoverFaces(coverFaces);
  }

  setScheduleProfile(scheduleProfile) {
    this.scheduleProfile = resolveRcScheduleProfile(scheduleProfile || {});
  }

  renderEmptyToElement() {
    const { maxWidth, maxHeight } = this.settings;
    const svg = createSvgElement('svg', {
      width: maxWidth,
      height: maxHeight,
      viewBox: `0 0 ${maxWidth} ${maxHeight}`,
      xmlns: 'http://www.w3.org/2000/svg',
      'data-empty-section': 'true',
    });
    svg.appendChild(
      createSvgElement('rect', {
        x: 0,
        y: 0,
        width: maxWidth,
        height: maxHeight,
        fill: 'white',
      }),
    );
    const message = createSvgElement('text', {
      x: maxWidth / 2,
      y: maxHeight / 2,
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      'font-size': '10px',
      'font-family': 'sans-serif',
      fill: '#666',
    });
    message.textContent = '断面情報なし';
    svg.appendChild(message);
    return svg;
  }

  renderToString(sectionData, renderOptions = {}) {
    return serializeRcSvg(this.renderToElement(sectionData, renderOptions));
  }

  renderToElement(sectionData, renderOptions = {}) {
    if (sectionData?.diameter || sectionData?.isCircular) {
      return this.renderCircularToElement(sectionData, renderOptions);
    }
    return this.renderRectangularToElement(sectionData, renderOptions);
  }

  createScheduleSvg(geometry, renderOptions) {
    return createRcSectionSvg({
      sectionWidth: geometry.width,
      sectionHeight: geometry.height,
      maxWidth: this.settings.maxWidth,
      maxHeight: this.settings.maxHeight,
      padding: this.settings.padding,
      fixedScale: renderOptions.fixedScale,
      symbolPrefix: COL_BAR_PREFIX,
    });
  }

  placeScheduleBars(svg, bars, sx, sy) {
    bars.forEach((bar) => {
      const use = placeRcBarSymbol(svg, bar.dia, sx(bar.x), sy(bar.y), {
        prefix: COL_BAR_PREFIX,
        className: `rc-column-rebar rc-column-rebar-${bar.role}`,
        role: bar.role,
        layer: bar.layer,
        paperDiameterMm: this.scheduleProfile.symbols.barPaperDiameterMm,
        scheduleProfile: this.scheduleProfile,
      });
      if (bar.directions?.length) {
        use.setAttribute('data-rebar-direction', bar.directions.join(''));
      }
    });
  }

  renderRectangularToElement(sectionData, renderOptions = {}) {
    if (renderOptions.scheduleProfile) this.setScheduleProfile(renderOptions.scheduleProfile);
    const geometry = buildColumnScheduleGeometry(sectionData, {
      coverFaces: this.coverFaces,
      sharedSlotCounts: renderOptions.sharedSlotCounts,
    });
    if (!geometry) return this.renderEmptyToElement();

    const { svg, scale } = this.createScheduleSvg(geometry, renderOptions);
    const { rectX, rectY, rectWidth, rectHeight, sx, sy } = createRcSectionProjection({
      sectionWidth: geometry.width,
      sectionHeight: geometry.height,
      padding: this.settings.padding,
      scale,
    });

    appendRcRectangularConcrete(svg, {
      x: rectX,
      y: rectY,
      width: rectWidth,
      height: rectHeight,
    });

    if (geometry.hoop) {
      svg.appendChild(
        createSvgElement('rect', {
          x: sx(geometry.hoop.left),
          y: sy(geometry.hoop.top),
          width: (geometry.hoop.right - geometry.hoop.left) * scale,
          height: (geometry.hoop.bottom - geometry.hoop.top) * scale,
          fill: 'none',
          stroke: '#666',
          'stroke-width': 1.5,
          class: 'rc-column-hoop-outer',
        }),
      );
      const hoopLegGroup = createSvgElement('g', { class: 'rc-column-hoop-legs' });
      geometry.hoop.innerLegs.forEach((leg) => {
        const attrs = {
          x1: sx(leg.x1),
          y1: sy(leg.y1),
          x2: sx(leg.x2),
          y2: sy(leg.y2),
          stroke: '#999',
          'stroke-width': 1,
          class:
            leg.orientation === 'H'
              ? 'rc-column-hoop-leg rc-column-hoop-leg-x'
              : 'rc-column-hoop-leg rc-column-hoop-leg-y',
        };
        if (Number.isFinite(leg.anchorX)) attrs['data-anchor-x'] = sx(leg.anchorX);
        if (Number.isFinite(leg.anchorY)) attrs['data-anchor-y'] = sy(leg.anchorY);
        hoopLegGroup.appendChild(createSvgElement('line', attrs));
      });
      svg.appendChild(hoopLegGroup);
    }

    this.placeScheduleBars(svg, geometry.mainBars, sx, sy);
    this.placeScheduleBars(svg, geometry.coreBars, sx, sy);

    if (this.settings.showDimensions) {
      appendRcRectangularDimensions(svg, {
        sectionWidth: geometry.width,
        sectionHeight: geometry.height,
        rectX,
        rectY,
        rectWidth,
        rectHeight,
      });
    }

    svg.setAttribute('data-cover-start-x', String(geometry.coverFaces.startX));
    svg.setAttribute('data-cover-end-x', String(geometry.coverFaces.endX));
    svg.setAttribute('data-cover-start-y', String(geometry.coverFaces.startY));
    svg.setAttribute('data-cover-end-y', String(geometry.coverFaces.endY));
    return svg;
  }

  renderCircularToElement(sectionData, renderOptions = {}) {
    if (renderOptions.scheduleProfile) this.setScheduleProfile(renderOptions.scheduleProfile);
    const geometry = buildColumnScheduleGeometry(sectionData, {
      coverFaces: this.coverFaces,
      sharedSlotCounts: renderOptions.sharedSlotCounts,
    });
    if (!geometry) return this.renderEmptyToElement();

    const { svg, scale } = this.createScheduleSvg(geometry, renderOptions);
    const { sx, sy } = createRcSectionProjection({
      sectionWidth: geometry.width,
      sectionHeight: geometry.height,
      padding: this.settings.padding,
      scale,
    });
    const center = geometry.diameter / 2;

    svg.appendChild(
      createSvgElement('circle', {
        cx: sx(center),
        cy: sy(center),
        r: center * scale,
        fill: '#f8f8f8',
        stroke: 'black',
        'stroke-width': 2,
      }),
    );

    if (geometry.hoop?.radius > 0) {
      svg.appendChild(
        createSvgElement('circle', {
          cx: sx(geometry.hoop.cx),
          cy: sy(geometry.hoop.cy),
          r: geometry.hoop.radius * scale,
          fill: 'none',
          stroke: '#666',
          'stroke-width': 1.5,
          class: 'rc-column-hoop-outer',
        }),
      );
    }

    this.placeScheduleBars(svg, geometry.mainBars, sx, sy);
    this.placeScheduleBars(svg, geometry.coreBars, sx, sy);

    if (this.settings.showDimensions) {
      const text = createSvgElement('text', {
        x: sx(center),
        y: sy(0) - 6,
        'text-anchor': 'middle',
        'font-size': '10px',
        'font-family': 'sans-serif',
        fill: '#666',
      });
      text.textContent = `φ${geometry.diameter}`;
      svg.appendChild(text);
    }

    svg.setAttribute('data-cover-average', String(averageColumnCoverFaces(geometry.coverFaces)));
    return svg;
  }
}

export default ConfiguredRcColumnVisualRenderer;
