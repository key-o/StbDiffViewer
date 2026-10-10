/**
 * @fileoverview 図面SVG上の選択候補をTabキーで巡回する。
 * 3D表示と同じ selectionCandidateSession を使い、カーソル直下で重なる部材を
 * 候補プレビュー(--color-selection-candidate)で示す。クリックで現在の候補を選択する。
 */
import { createSelectionCandidateSession } from '../../../app/controllers/interaction/selectionCandidateSession.js';
import { eventBus, ToastEvents } from '../../../data/events/index.js';

const MEMBER_SELECTOR = '.stb-drawing-member';
const CANDIDATE_LIMIT = 6;

export class PdfOverlayCandidateController {
  /**
   * @param {{surface: HTMLElement, isEnabled: () => boolean, describe: (elementKey: string) => string}} options
   */
  constructor({ surface, isEnabled, describe }) {
    this.surface = surface;
    this.isEnabled = isEnabled;
    this.session = createSelectionCandidateSession({
      config: { candidateLimit: CANDIDATE_LIMIT },
      raycast: ({ clientX, clientY }) => this.membersAt(clientX, clientY),
      getMessageKey: (member, index) => `${index}|${member.dataset.elementKey}`,
      applyPreview: (member) => {
        member.classList.add('is-candidate');
        return true;
      },
      restorePreview: (member) => member.classList.remove('is-candidate'),
      formatCandidateMessage: (member, index, count) =>
        `選択候補 ${index + 1}/${count}: ${describe(member.dataset.elementKey)}`,
      showCandidate: ({ message }) =>
        eventBus.emit(ToastEvents.SHOW_INFO, {
          message,
          options: { duration: 1500, closable: false },
        }),
    });
    surface.addEventListener('pointermove', (event) => this.onPointerMove(event));
    surface.addEventListener('pointerleave', () => this.clear());
    // 3D表示と同様、windowのcaptureでTabを受ける。
    globalThis.addEventListener?.('keydown', (event) => this.onKeyDown(event), true);
    globalThis.addEventListener?.('blur', () => this.clear());
  }

  membersAt(clientX, clientY) {
    const doc = this.surface.ownerDocument;
    const members = [];
    for (const node of doc.elementsFromPoint?.(clientX, clientY) || []) {
      const member = node.closest?.(MEMBER_SELECTOR);
      if (member && this.surface.contains(member) && !members.includes(member)) {
        // selectionCandidateSession は「退避したmaterialがある候補」だけプレビューを復元する。
        // DOM候補にはmaterialが無いため、復元を有効にするマーカーを置く。
        member.material = true;
        members.push(member);
      }
    }
    return members;
  }

  onPointerMove(event) {
    if (!this.isEnabled()) return;
    this.session.updatePointer(event);
    this.session.refresh(null, event);
    this.session.syncPreview();
  }

  onKeyDown(event) {
    if (!this.isEnabled()) return;
    // ポインタが図面上にある間だけTabを奪う。サイドバー等のキーボード操作は妨げない。
    if (event.key === 'Tab' && !this.session.getState().pointer.isInsideCanvas) return;
    this.session.handleKeyDown(event);
  }

  /** クリック確定時: 現在の候補の部材キーを返し、プレビューを解除する。 */
  consumeCandidateKey() {
    const { currentCandidate } = this.session.getState();
    const key = currentCandidate?.dataset?.elementKey ?? null;
    this.clear();
    return key;
  }

  /** SVG再生成などで候補DOMが失効したとき。 */
  clear() {
    this.session.setPointerInsideCanvas(false);
    this.session.clear();
  }
}
