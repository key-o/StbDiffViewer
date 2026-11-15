/**
 * @fileoverview イベントシステムの統一エクスポート（Layer 1: data層）
 *
 * EventBus（data/events/eventBus.js）とイベントタイプ定数（constants/eventTypes.js）を
 * まとめてエクスポートします。
 *
 * 使用例:
 * ```javascript
 * import { eventBus, ImportanceEvents } from '../data/events/index.js';
 *
 * eventBus.on(ImportanceEvents.SETTINGS_CHANGED, (data) => { ... });
 * eventBus.emit(ImportanceEvents.SETTINGS_CHANGED, { level: 'high' });
 * ```
 *
 * @module data/events
 */

// EventBus（data層）
export { EventBus, eventBus, default } from './eventBus.js';

// Event Types（constants層から再エクスポート）
export {
  EventTypes,
  ImportanceEvents,
  ComparisonEvents,
  RenderEvents,
  SceneEvents,
  AxisEvents,
  UIEvents,
  SelectionEvents,
  SettingsEvents,
  DiffStatusEvents,
  VersionEvents,
  ModelEvents,
  ViewEvents,
  ExportEvents,
  LoadEvents,
  ToastEvents,
  ClippingEvents,
  EditEvents,
  ValidationEvents,
  AppEvents,
  InteractionEvents,
  LoadingIndicatorEvents,
  FinalizationEvents,
  LabelEvents,
  MeasurementEvents,
  isValidEventType,
} from '../../constants/eventTypes.js';
