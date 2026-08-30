type ImportanceManager = import('../app/importanceManager.js').default;
type OrbitControls = import('../viewer/controls/orbitLikeControlsShim.js').OrbitLikeControlsShim;

interface GlobalStateLike {
  get(path?: string): any;
  set(path: string, value: any): void;
  addListener?(path: string, listener: (...args: any[]) => void): void;
  removeListener?(path: string, listener: (...args: any[]) => void): void;
  registerFunction?(name: string, func: (...args: any[]) => any): void;
}

interface ViewerGlobal {
  scene?: import('three').Scene | null;
  camera?: import('three').Camera | null;
  renderer?: import('three').WebGLRenderer | null;
  controls?: any;
  [key: string]: any;
}

interface ToastApi {
  showSuccess(message: string, options?: any): void;
  showError(message: string, options?: any): void;
  showWarning(message: string, options?: any): void;
  showInfo(message: string, options?: any): void;
}

interface IdleRequestOptions {
  timeout?: number;
}

interface IdleDeadline {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}

type IdleRequestCallback = (deadline: IdleDeadline) => void;

declare function requestIdleCallback(
  callback: IdleRequestCallback,
  options?: IdleRequestOptions,
): number;
declare function cancelIdleCallback(handle: number): void;

interface Performance {
  memory?: {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
  };
}

interface EventTarget {
  checked?: boolean;
  classList?: DOMTokenList;
  clientX?: number;
  clientY?: number;
  config?: any;
  ctrlKey?: boolean;
  dataset?: DOMStringMap;
  disabled?: boolean;
  element?: any;
  files?: FileList | null;
  hasWheelListener?: boolean;
  isContentEditable?: boolean;
  metaKey?: boolean;
  node_ids?: any;
  options?: HTMLOptionsCollection;
  selectedIndex?: number;
  selectedOptions?: HTMLCollectionOf<HTMLOptionElement>;
  startCoords?: any;
  endCoords?: any;
  textContent?: string | null;
  type?: string;
  value?: string;
}

interface Event {
  clientX?: number;
  clientY?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

interface Navigator {
  xr?: XRSystem;
}

interface Window {
  envConfig?: {
    environment: string;
    features?: Record<string, any>;
    logging?: {
      level?: string;
      console?: boolean;
    };
  };
  viewer: ViewerGlobal;
  AppLogger?: any;
  FootingGenerator?: any;
  GeometryDebugger?: any;
  GeometryDiagnostics?: any;
  GeometryMismatchAnalyzer?: any;
  PileGenerator?: any;
  SlabGenerator?: any;
  WallGenerator?: any;
  app?: any;
  applyAxisClip?: (...args: any[]) => any;
  applyStoryClip?: (...args: any[]) => any;
  canExportStbToDxf?: (...args: any[]) => any;
  clearClippingPlanes?: (...args: any[]) => any;
  comparisonKeyManager?: any;
  controls?: any;
  debugLoadData?: (...args: any[]) => any;
  diffStatusFilter?: any;
  displayElementInfo?: (...args: any[]) => any;
  displayModeManager?: any;
  exportAllStoriesToDxf?: (...args: any[]) => any;
  exportAlongAllAxesBothDirections?: (...args: any[]) => any;
  exportAlongAllAxesToDxf?: (...args: any[]) => any;
  exportStbToDxf?: (...args: any[]) => any;
  getAvailableAxes?: (...args: any[]) => any;
  getAvailableStories?: (...args: any[]) => any;
  getLoadDisplayManager?: (...args: any[]) => any;
  getStbExportStats?: (...args: any[]) => any;
  globalState?: GlobalStateLike;
  handleCompareModelsClick?: (...args: any[]) => any;
  importanceDebug?: any;
  labelDisplayManager?: any;
  moduleMessenger?: any;
  regenerateAllLabels?: (...args: any[]) => any;
  requestRender?: () => void;
  resizeTimeout?: number | ReturnType<typeof setTimeout>;
  resetElementColors?: (...args: any[]) => any;
  resetImportanceColors?: (...args: any[]) => any;
  resetSchemaColors?: (...args: any[]) => any;
  runSectionComparison?: (options?: { limit?: number; [key: string]: any }) => any;
  runtimeImportanceColors?: Record<string, any> | null;
  scene?: import('three').Scene | null;
  showDirectoryPicker?(options?: any): Promise<any>;
  showImportancePerformanceStats?: (...args: any[]) => any;
  showNotification?: (...args: any[]) => any;
  showToast?: ToastApi;
  steelSections?: any;
  stbParsedData?: any;
  stbViewer?: any;
  toggleBulkOperations?: () => void;
  toggleDiffList?: () => void;
  toggleDiffStatusPanel?: () => void;
  toggleImportanceFilter?: () => void;
  toggleImportanceStatistics?: () => void;
  toggleLegend?: (...args: any[]) => any;
  updateCompareButtonLabel?: (...args: any[]) => any;
  xsdSchema?: Document | XMLDocument | null;
  requestIdleCallback?(callback: IdleRequestCallback, options?: IdleRequestOptions): number;
  cancelIdleCallback?(handle: number): void;
}

interface XRSystem {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, options?: any): Promise<XRSession>;
}

interface XRSession extends EventTarget {
  end(): Promise<void>;
  requestReferenceSpace(type: string): Promise<XRReferenceSpace>;
  requestHitTestSource?(options: any): Promise<XRHitTestSource>;
  updateRenderState?(state: any): void | Promise<void>;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

interface XRReferenceSpace extends EventTarget {}

interface XRHitTestSource {
  cancel?(): void;
}

interface XRFrame {
  getHitTestResults?(source: XRHitTestSource): any[];
  getViewerPose?(space: XRReferenceSpace): any;
}

interface XRRigidTransform {
  readonly matrix: ArrayLike<number>;
}

declare module 'camera-controls' {
  const CameraControls: any;
  export default CameraControls;
}

declare module 'encoding-japanese' {
  const Encoding: any;
  export default Encoding;
}

declare module 'html2canvas' {
  const html2canvas: any;
  export default html2canvas;
}

declare module 'jspdf' {
  export const jsPDF: any;
}
