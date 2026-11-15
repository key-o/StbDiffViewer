/**
 * Pointer gesture for a plan node grip.
 * Click selection remains independent; a real drag previews without changing the
 * Working Document, and pointerup commits at most one semantic Command.
 */
export function bindCadPlanNodeDrag(
  circle,
  {
    canStart = () => true,
    startContext,
    isCurrent,
    resolve,
    preview,
    reset,
    commit,
    fail,
    thresholdPx = 3,
  } = {},
) {
  if (!circle?.addEventListener || typeof startContext !== 'function')
    throw new TypeError('節点ドラッグの対象または開始処理が不正です。');
  const window = circle.ownerDocument?.defaultView;
  if (!window) throw new TypeError('節点ドラッグのイベント対象がありません。');
  if (!Number.isFinite(thresholdPx) || thresholdPx <= 0)
    throw new RangeError('節点ドラッグの開始距離が不正です。');

  let pending = null;
  let suppressClick = false;
  const suppressDragClick = (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const pointerDown = (event) => {
    suppressClick = false;
    if (
      event.button !== 0 ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !canStart(event)
    )
      return;
    // Prevent the sheet panning handler from taking ownership of the same pointer.
    event.preventDefault();
    event.stopPropagation();
    pending?.cancel();
    const context = startContext(event);
    if (!context) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let active = true;
    let dragged = false;
    const matches = (e) => pointerId == null || e?.pointerId == null || e.pointerId === pointerId;
    const delta = (e) => ({ dx: e.clientX - startX, dy: e.clientY - startY });
    const cleanUp = () => {
      if (!active) return false;
      active = false;
      pending = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('blur', cancel);
      return true;
    };
    const cancel = (e) => {
      if ((e?.type === 'pointercancel' && !matches(e)) || !cleanUp()) return;
      reset?.(context);
    };
    const move = (e) => {
      if (!active || !matches(e)) return;
      if (!isCurrent(context)) return cancel(e);
      const displacement = delta(e);
      if (!dragged && Math.hypot(displacement.dx, displacement.dy) < thresholdPx) return;
      dragged = true;
      try {
        preview?.(context, resolve(context, displacement));
      } catch (error) {
        cancel(e);
        fail?.(error);
      }
    };
    const up = (e) => {
      if (!active || !matches(e)) return;
      const current = isCurrent(context);
      const displacement = delta(e);
      const moved = dragged || Math.hypot(displacement.dx, displacement.dy) >= thresholdPx;
      cleanUp();
      if (!moved || !current) {
        reset?.(context);
        return;
      }
      suppressClick = true;
      e.preventDefault();
      e.stopPropagation();
      // A real browser can retarget click to the common SVG ancestor when
      // pointerup happens outside the source circle. Suppress only this click
      // task, never a subsequent unrelated user click.
      const blockClick = (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopImmediatePropagation();
        window.removeEventListener('click', blockClick, true);
      };
      window.addEventListener('click', blockClick, true);
      window.setTimeout(() => window.removeEventListener('click', blockClick, true), 0);
      try {
        const result = resolve(context, displacement);
        reset?.(context);
        if (Math.hypot(result.delta.x, result.delta.y, result.delta.z) > 1e-7)
          commit(context, result);
      } catch (error) {
        reset?.(context);
        fail?.(error);
      }
    };
    const keyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cancel(e);
    };
    pending = { cancel: () => cancel() };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('blur', cancel);
  };
  circle.addEventListener('pointerdown', pointerDown);
  circle.addEventListener('click', suppressDragClick, true);
  return () => {
    pending?.cancel();
    circle.removeEventListener('pointerdown', pointerDown);
    circle.removeEventListener('click', suppressDragClick, true);
  };
}
