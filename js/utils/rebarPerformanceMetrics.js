/**
 * @fileoverview RC 3D配筋の軽量な性能診断メトリクス。
 *
 * 通常時は無効で、E2E/手動診断時だけ有効化する。console出力は行わず、
 * カウンタと同期処理時間だけを保持する。
 */

const state = {
  enabled: false,
  counters: Object.create(null),
  timings: Object.create(null),
};

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function cloneRecord(record) {
  return Object.fromEntries(Object.entries(record));
}

/** 性能診断を有効/無効化する。 */
export function setRebarPerformanceMetricsEnabled(enabled = true) {
  state.enabled = Boolean(enabled);
  return state.enabled;
}

/** 収集済みメトリクスを破棄する。enabled状態は維持する。 */
export function resetRebarPerformanceMetrics() {
  state.counters = Object.create(null);
  state.timings = Object.create(null);
}

/** カウンタを加算する。無効時はno-op。 */
export function incrementRebarPerformanceCounter(name, amount = 1) {
  if (!state.enabled) return;
  const key = String(name);
  state.counters[key] = (state.counters[key] || 0) + amount;
}

/**
 * 同期処理の時間を計測する。無効時はそのまま実行する。
 * @template T
 * @param {string} name
 * @param {() => T} callback
 * @returns {T}
 */
export function measureRebarPerformance(name, callback) {
  if (!state.enabled) return callback();
  const startedAt = nowMs();
  try {
    return callback();
  } finally {
    const durationMs = Math.max(0, nowMs() - startedAt);
    const key = String(name);
    const current = state.timings[key] || {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      lastMs: 0,
    };
    current.count += 1;
    current.totalMs += durationMs;
    current.maxMs = Math.max(current.maxMs, durationMs);
    current.lastMs = durationMs;
    state.timings[key] = current;
  }
}

/** E2Eや手動計測用のスナップショット。 */
export function snapshotRebarPerformanceMetrics() {
  return {
    enabled: state.enabled,
    counters: cloneRecord(state.counters),
    timings: Object.fromEntries(
      Object.entries(state.timings).map(([key, value]) => [key, { ...value }]),
    ),
  };
}

// Playwrightからproductionコードへ侵入せず計測を制御するための診断bridge。
// 通常利用時はenabled=falseのため計測コストは分岐だけに限定される。
if (typeof globalThis !== 'undefined') {
  globalThis.__rebarPerformanceMetrics = {
    enable: () => setRebarPerformanceMetricsEnabled(true),
    disable: () => setRebarPerformanceMetricsEnabled(false),
    reset: resetRebarPerformanceMetrics,
    snapshot: snapshotRebarPerformanceMetrics,
  };
}
