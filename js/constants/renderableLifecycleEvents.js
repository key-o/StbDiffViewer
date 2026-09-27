/**
 * @fileoverview Renderable再生成ライフサイクルのイベント定数。
 *
 * Layer 0でイベント名を固定し、viewer・colorModes・UIが同じ契約を参照する。
 */

export const RenderableLifecycleEvents = Object.freeze({
  /** 要素groupのgeometry構成変更がバッチ単位で完了した */
  GEOMETRY_CHANGED: 'render:geometryChanged',
  /** Material差替えバッチが完了し、現在Renderableの表示Materialが確定した */
  MATERIALS_CHANGED: 'render:materialsChanged',
  /** element-ID局所再生成でRenderable参照が差し替わった */
  RENDERABLES_REPLACED: 'render:renderablesReplaced',
  /** 配筋meshが非表示または再生成で除去された */
  REBAR_MESHES_REMOVED: 'render:rebarMeshesRemoved',
});
