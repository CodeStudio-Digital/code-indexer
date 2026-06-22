/**
 * The change-marker toolbar, built as plain DOM (not React): it lives inside a
 * Monaco content widget, which is detached from the app's provider tree, so a
 * React root there would lose i18n/theme context. Theme CSS vars still inherit
 * through the DOM, and translated labels are passed in. Styling: `.mcp-change-tb*`
 * in index.css.
 *
 * Buttons: prev / next change, rollback to HEAD, copy original, toggle the
 * original-text preview, stage this block, and a commit affordance (message
 * field + send). A `✕` closes it.
 */

export interface ChangeToolbarLabels {
  prev: string;
  next: string;
  rollback: string;
  copy: string;
  showOriginal: string;
  stage: string;
  commit: string;
  commitPlaceholder: string;
  close: string;
}

export interface ChangeToolbarActions {
  onPrev(): void;
  onNext(): void;
  onRollback(): void;
  onCopy(): void;
  onStage(): void;
  onCommit(message: string): void;
  onClose(): void;
}

export interface ChangeToolbarHandle {
  element: HTMLElement;
  /** Refresh per-change bits: the preview text + whether an original exists. */
  update(state: { baselineText: string }): void;
  destroy(): void;
}

function btn(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mcp-change-tb-btn';
  b.textContent = glyph;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

function sep(): HTMLElement {
  const s = document.createElement('span');
  s.className = 'mcp-change-tb-sep';
  return s;
}

export function buildChangeToolbar(
  labels: ChangeToolbarLabels,
  actions: ChangeToolbarActions,
): ChangeToolbarHandle {
  const element = document.createElement('div');
  element.className = 'mcp-change-tb';

  const bar = document.createElement('div');
  bar.className = 'mcp-change-tb-row';

  const preview = document.createElement('pre');
  preview.className = 'mcp-change-tb-original';
  preview.hidden = true;

  const showBtn = btn('≡', labels.showOriginal, () => {
    preview.hidden = !preview.hidden;
    showBtn.classList.toggle('is-active', !preview.hidden);
  });

  // Commit affordance: a row that toggles open with a message field + send.
  const commitRow = document.createElement('div');
  commitRow.className = 'mcp-change-tb-commit';
  commitRow.hidden = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'mcp-change-tb-input';
  input.placeholder = labels.commitPlaceholder;
  const send = btn('✓', labels.commit, () => {
    const msg = input.value.trim();
    if (msg) actions.onCommit(msg);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const msg = input.value.trim();
      if (msg) actions.onCommit(msg);
    }
  });
  commitRow.append(input, send);

  const commitBtn = btn('⊕', labels.commit, () => {
    commitRow.hidden = !commitRow.hidden;
    commitBtn.classList.toggle('is-active', !commitRow.hidden);
    if (!commitRow.hidden) input.focus();
  });

  bar.append(
    btn('↑', labels.prev, actions.onPrev),
    btn('↓', labels.next, actions.onNext),
    sep(),
    btn('↩', labels.rollback, actions.onRollback),
    btn('⧉', labels.copy, actions.onCopy),
    showBtn,
    sep(),
    btn('⤓', labels.stage, actions.onStage),
    commitBtn,
    sep(),
    btn('✕', labels.close, actions.onClose),
  );

  element.append(bar, commitRow, preview);

  return {
    element,
    update({ baselineText }) {
      preview.textContent = baselineText;
      // A pure addition has no original — hide preview + reset commit field.
      showBtn.style.display = baselineText === '' ? 'none' : '';
      if (baselineText === '') preview.hidden = true;
      input.value = '';
      commitRow.hidden = true;
      commitBtn.classList.remove('is-active');
    },
    destroy() {
      element.remove();
    },
  };
}
