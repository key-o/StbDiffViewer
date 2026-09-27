/**
 * @fileoverview RC梁断面リスト向けビジュアルレンダラー
 *
 * 梁リストの配筋位置は beamScheduleModel のmm座標を唯一の基準とする。
 * 本クラスは共通モデルをSVGへ投影するだけとし、独自の配筋配置計算を持たない。
 */

import { createSvgElement } from '../rcColumnVisual/rebarSymbolDefs.js';
import {
  appendRcRectangularConcrete,
  appendRcRectangularDimensions,
  createRcSectionProjection,
  createRcSectionSvg,
  placeRcBarSymbol,
  serializeRcSvg,
} from '../rcVisualSvg.js';
import { buildBeamScheduleGeometry, normalizeBeamScheduleBarLayers } from './beamScheduleModel.js';

const BEAM_BAR_PREFIX = 'beam-bar';

/**
 * RC梁断面リスト専用レンダラー。
 * UIとDXFは同じ buildBeamScheduleGeometry() の結果を使用する。
 */
export class RcBeamScheduleVisualRenderer {
  constructor(options = {}) {
    this.settings = {
      maxWidth: options.maxWidth || 120,
      maxHeight: options.maxHeight || 120,
      padding: options.padding || 20,
      showDimensions: options.showDimensions !== false,
    };
  }

  renderToString(beamData, renderOptions = {}) {
    return serializeRcSvg(this.renderToElement(beamData, renderOptions));
  }

  renderToElement(beamData, renderOptions = {}) {
    const geometry = buildBeamScheduleGeometry(beamData, {
      profile: renderOptions.scheduleProfile || {},
      drawingCoverOverride: renderOptions.drawingCoverOverride ?? null,
    });
    if (!geometry) return null;

    const { maxWidth, maxHeight, padding } = this.settings;
    const { svg, scale } = createRcSectionSvg({
      sectionWidth: geometry.width,
      sectionHeight: geometry.depth,
      maxWidth,
      maxHeight,
      padding,
      fixedScale: renderOptions.fixedScale,
      symbolPrefix: BEAM_BAR_PREFIX,
    });
    const { rectX, rectY, rectWidth, rectHeight, sx, sy } = createRcSectionProjection({
      sectionWidth: geometry.width,
      sectionHeight: geometry.depth,
      padding,
      scale,
    });

    if (geometry.estimatedCover) svg.setAttribute('data-cover-estimated', 'true');
    if (geometry.estimatedBarDia) svg.setAttribute('data-bar-dia-estimated', 'true');
    svg.setAttribute('data-schedule-placement', geometry.placementMode);

    appendRcRectangularConcrete(svg, {
      x: rectX,
      y: rectY,
      width: rectWidth,
      height: rectHeight,
    });

    if (geometry.stirrup) {
      svg.appendChild(
        createSvgElement('rect', {
          x: sx(geometry.stirrup.left),
          y: sy(geometry.stirrup.top),
          width: (geometry.stirrup.right - geometry.stirrup.left) * scale,
          height: (geometry.stirrup.bottom - geometry.stirrup.top) * scale,
          fill: 'none',
          stroke: '#666',
          'stroke-width': 1.5,
          class: 'rc-beam-stirrup-outer',
        }),
      );

      geometry.stirrup.innerLegs.forEach((leg) => {
        svg.appendChild(
          createSvgElement('line', {
            x1: sx(leg.x),
            y1: sy(leg.top),
            x2: sx(leg.x),
            y2: sy(leg.bottom),
            stroke: '#666',
            'stroke-width': 1.5,
            class: 'rc-beam-stirrup-leg',
            'data-anchor-x': sx(leg.anchorX),
          }),
        );
      });
    }

    const symbolOptions = {
      paperDiameterMm: geometry.profile.symbols.barPaperDiameterMm,
      scheduleProfile: geometry.profile,
    };
    geometry.mainBars.forEach((bar) => {
      placeRcBarSymbol(svg, bar.dia, sx(bar.x), sy(bar.y), {
        ...symbolOptions,
        prefix: BEAM_BAR_PREFIX,
        className: 'rc-beam-rebar',
        layer: bar.layer,
      });
    });

    geometry.webBars.forEach((bar) => {
      placeRcBarSymbol(svg, bar.dia, sx(bar.x), sy(bar.y), {
        ...symbolOptions,
        prefix: BEAM_BAR_PREFIX,
        className: 'rc-beam-rebar',
        layer: bar.layer,
      });
    });

    if (this.settings.showDimensions) {
      appendRcRectangularDimensions(svg, {
        sectionWidth: geometry.width,
        sectionHeight: geometry.depth,
        rectX,
        rectY,
        rectWidth,
        rectHeight,
        topOffset: 8,
        leftOffset: 12,
      });
    }

    return svg;
  }

  /**
   * 梁リスト表のスロット数集計用。正規化規則は beamScheduleModel に委譲する。
   */
  getRenderableBarLayers(bar) {
    return normalizeBeamScheduleBarLayers(bar);
  }
}

export default RcBeamScheduleVisualRenderer;
