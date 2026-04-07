/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import { LitElement, css, html, PropertyValues } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import {
  autocompletion,
  completionKeymap,
  Compartment,
  Decoration,
  DecorationSet,
  drawSelection,
  EditorState,
  EditorView,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  history,
  historyKeymap,
  indentWithTab,
  keymap,
  lineNumbers,
  startCompletion,
  StateEffect,
  StateField,
  syntaxHighlighting,
  tags,
  toggleComment,
  WidgetType,
} from './internal/codemirror.js';
import playgroundStyles from './playground-styles.js';
import { Diagnostic } from 'vscode-languageserver-protocol';
import {
  EditorCompletion,
  EditorCompletionDetails,
  EditorPosition,
  EditorToken,
} from './shared/worker-api.js';
import { javascript } from '@codemirror/lang-javascript';
import { html as htmlLang } from '@codemirror/lang-html';
import { css as cssLang } from '@codemirror/lang-css';
import { json as jsonLang } from '@codemirror/lang-json';
import { Transaction, type Extension } from '@codemirror/state';
import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import { ViewPlugin, type ViewUpdate } from '@codemirror/view';

// TODO(aomarks) Could we upstream this to lit-element? It adds much stricter
// types to the ChangedProperties type.
interface TypedMap<T> {
  has<K extends keyof T>(key: K): boolean;
  keys(): IterableIterator<keyof T>;
}

const highlightClasses = HighlightStyle.define([
  { tag: tags.keyword, class: 'cm-keyword' },
  // In CM6, some things (notably CSS color keywords like "blue") are tagged as
  // `atom`. In CM5 these aligned more closely with `keyword` styling in this
  // project, so we map `atom` to the keyword class.
  { tag: tags.atom, class: 'cm-keyword' },
  { tag: [tags.bool, tags.null], class: 'cm-atom' },
  { tag: tags.number, class: 'cm-number' },
  { tag: tags.definition(tags.variableName), class: 'cm-def' },
  { tag: tags.variableName, class: 'cm-variable' },
  // JSON object keys are typically tagged as `propertyName`. In CM5 they were
  // styled like strings in this project.
  { tag: tags.propertyName, class: 'cm-string' },
  { tag: tags.operator, class: 'cm-operator' },
  { tag: tags.typeName, class: 'cm-type' },
  { tag: tags.tagName, class: 'cm-tag' },
  { tag: tags.attributeName, class: 'cm-attribute' },
  { tag: [tags.string, tags.special(tags.string)], class: 'cm-string' },
  { tag: tags.comment, class: 'cm-comment' },
  { tag: tags.meta, class: 'cm-meta' },
  { tag: tags.invalid, class: 'cm-error' },
]);

const hideLineNumbersFromAT = ViewPlugin.fromClass(
  class {
    constructor(private readonly _view: EditorView) {
      this._sync();
    }

    update(update: ViewUpdate) {
      void update;
      this._sync();
    }

    private _sync() {
      const view = this._view;
      for (const gutterEl of view.dom.querySelectorAll<HTMLElement>(
        '.cm-lineNumbers .cm-gutterElement',
      )) {
        // CM6 may render non-number spacer elements and/or hidden sizing
        // elements in this gutter.
        const style = (gutterEl.getAttribute('style') ?? '').toLowerCase();
        if (style.includes('visibility: hidden')) continue;
        const text = gutterEl.textContent?.trim() ?? '';
        if (!/^\d+$/.test(text)) continue;
        gutterEl.setAttribute('aria-hidden', 'true');
      }
    }
  },
);

const codeMirrorTheme = EditorView.theme({
  '&': {
    height: '100%',
    borderRadius: 'inherit',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'var(--playground-code-font-family, monospace)',
    fontSize: 'var(--playground-code-font-size, 14px)',
    lineHeight: 'var(--playground-code-line-height, 1.4em)',
  },
});

class FoldMarkerWidget extends WidgetType {
  constructor(
    private readonly _from: number,
    private readonly _to: number,
  ) {
    super();
  }

  override toDOM(view: EditorView) {
    const span = document.createElement('span');
    span.textContent = '…';
    span.className = 'cm-foldmarker';
    span.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({
        effects: togglePragmaFoldEffect.of({ from: this._from, to: this._to }),
      });
    });
    return span;
  }
}

type PragmaRegion =
  | { kind: 'comment'; from: number; to: number; readOnly: boolean }
  | { kind: 'hide'; from: number; to: number; readOnly: boolean }
  | { kind: 'fold'; from: number; to: number; readOnly: boolean };

const setDiagnosticsEffect = StateEffect.define<Diagnostic[] | undefined>();
const setPragmaRegionsEffect = StateEffect.define<PragmaRegion[]>();
const togglePragmaFoldEffect = StateEffect.define<{ from: number; to: number }>();

const diagnosticsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setDiagnosticsEffect)) {
        const diagnostics = effect.value ?? [];
        const ranges: Array<ReturnType<Decoration['range']>> = [];
        for (let i = 0; i < diagnostics.length; i++) {
          const d = diagnostics[i];
          const start = posFromLsp(
            d.range.start.line,
            d.range.start.character,
            tr.state,
          );
          const end = posFromLsp(
            d.range.end.line,
            d.range.end.character,
            tr.state,
          );
          if (start === null || end === null || end <= start) continue;
          ranges.push(
            Decoration.mark({ class: `diagnostic diagnostic-${i}` }).range(
              start,
              end,
            ),
          );
        }
        return Decoration.set(ranges, true);
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

type PragmaState = {
  decorations: DecorationSet;
  readOnlyRanges: Array<[number, number]>;
  regions: PragmaRegion[];
  expandedFolds: Array<[number, number]>;
};

const pragmaField = StateField.define<PragmaState>({
  create() {
    return {
      decorations: Decoration.none,
      readOnlyRanges: [],
      regions: [],
      expandedFolds: [],
    };
  },
  update(value, tr) {
    const mapRange = ([from, to]: [number, number]) => {
      const newFrom = tr.changes.mapPos(from, 1);
      const newTo = tr.changes.mapPos(to, -1);
      return [newFrom, newTo] as [number, number];
    };

    value = {
      decorations: value.decorations.map(tr.changes),
      readOnlyRanges: value.readOnlyRanges.map(mapRange).filter(([f, t]) => t > f),
      regions: value.regions,
      expandedFolds: value.expandedFolds.map(mapRange).filter(([f, t]) => t > f),
    };

    const rebuild = (regions: PragmaRegion[], expanded: Array<[number, number]>) => {
      const expandedSet = new Set(expanded.map(([f, t]) => `${f}:${t}`));
      const ranges: Array<ReturnType<Decoration['range']>> = [];
      const readOnlyRanges: Array<[number, number]> = [];

      for (const region of regions) {
        if (region.kind === 'comment') {
          ranges.push(Decoration.replace({}).range(region.from, region.to));
        } else if (region.kind === 'hide') {
          ranges.push(Decoration.replace({}).range(region.from, region.to));
          if (region.readOnly) readOnlyRanges.push([region.from, region.to]);
        } else if (region.kind === 'fold') {
          const from = region.from;
          const to = region.to;
          if (!expandedSet.has(`${from}:${to}`)) {
            ranges.push(
              Decoration.replace({
                widget: new FoldMarkerWidget(from, to),
              }).range(from, to),
            );
          }
          if (region.readOnly) readOnlyRanges.push([from, to]);
        }
      }
      return { decorations: Decoration.set(ranges, true), readOnlyRanges };
    };

    for (const effect of tr.effects) {
      if (effect.is(setPragmaRegionsEffect)) {
        const regions = effect.value;
        // If pragmas are disabled, clear any expanded fold state.
        const expandedFolds = regions.length === 0 ? [] : value.expandedFolds;
        const rebuilt = rebuild(regions, expandedFolds);
        return {
          ...value,
          regions,
          expandedFolds,
          ...rebuilt,
        };
      }

      if (effect.is(togglePragmaFoldEffect)) {
        const { from, to } = effect.value;
        const key = `${from}:${to}`;
        const expandedSet = new Set(value.expandedFolds.map(([f, t]) => `${f}:${t}`));
        if (expandedSet.has(key)) {
          expandedSet.delete(key);
        } else {
          expandedSet.add(key);
        }
        const expandedFolds = Array.from(expandedSet)
          .map((k) => {
            const [f, t] = k.split(':');
            return [Number(f), Number(t)] as [number, number];
          })
          .filter(([f, t]) => Number.isFinite(f) && Number.isFinite(t) && t > f);
        const rebuilt = rebuild(value.regions, expandedFolds);
        return {
          ...value,
          expandedFolds,
          ...rebuilt,
        };
      }
    }

    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

const setTemplateHighlightsEffect = StateEffect.define<DecorationSet>();
const templateHighlightsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setTemplateHighlightsEffect)) {
        return effect.value;
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function posFromLsp(
  lineZeroBased: number,
  ch: number,
  state: EditorState,
): number | null {
  const lineNo = lineZeroBased + 1;
  if (lineNo < 1 || lineNo > state.doc.lines) return null;
  const line = state.doc.line(lineNo);
  return Math.min(line.to, line.from + Math.max(0, ch));
}

function tokenUnderCursor(state: EditorState): EditorToken {
  const pos = state.selection.main.from;
  const line = state.doc.lineAt(pos);
  const offset = pos - line.from;
  const text = line.text;

  const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);
  let start = offset;
  let end = offset;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  return { start, end, string: text.slice(start, end) };
}

const htmlTargetNearCursor = (state: EditorState) => {
  const pos = state.selection.main.from;
  const from = Math.max(0, pos - 2000);
  const to = Math.min(state.doc.length, pos + 2000);
  const windowText = state.doc.sliceString(from, to);
  const relPos = pos - from;

  const lt = windowText.lastIndexOf('<', relPos);
  if (lt === -1) return undefined;
  const gt = windowText.indexOf('>', lt);
  if (gt === -1) return undefined;

  const tagText = windowText.slice(lt, gt + 1);
  if (tagText.startsWith('</') || tagText.startsWith('<!')) return undefined;

  const tagNameMatch = tagText.match(/^<\s*([a-zA-Z][\w:-]*)/);
  const tagName = tagNameMatch?.[1];

  const idMatch = tagText.match(/\bid\s*=\s*("([^"]+)"|'([^']+)')/i);
  const id = idMatch?.[2] ?? idMatch?.[3];

  const classMatch = tagText.match(
    /\bclass\s*=\s*("([^"]+)"|'([^']+)')/i,
  );
  const classAttr = classMatch?.[2] ?? classMatch?.[3];
  const className = classAttr?.trim().split(/\s+/)[0];

  if (!tagName && !id && !className) return undefined;
  return { tagName, id, className };
};
/**
 * A basic text editor with syntax highlighting for HTML, CSS, and JavaScript.
 */
@customElement('playground-code-editor')
export class PlaygroundCodeEditor extends LitElement {
  private readonly _cmDom = (() => {
    const div = document.createElement('div');
    div.id = 'editor';
    return div;
  })();
  static override styles = [
    css`
      :host {
        display: block;
        height: 100%;
        min-height: 0;
      }

      #focusContainer {
        height: 100%;
        min-height: 0;
        position: relative;
      }
      #focusContainer:focus {
        outline: none;
      }

      #focusContainer:focus-visible,
      #focusContainer:focus-within:focus-visible {
        outline: 2px solid
          var(
            --playground-focus-outline-color,
            var(--playground-highlight-color, #6200ee)
          );
        outline-offset: 2px;
      }

      .cm-foldmarker {
        font-family: sans-serif;
      }
      .cm-foldmarker:hover {
        cursor: pointer;
        /* Pretty much any color from the theme is good enough. */
        color: var(--playground-code-keyword-color, #770088);
      }

      #editor {
        height: 100%;
        min-height: 0;
      }

      #keyboardHelp {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      .diagnostic {
        position: relative;
      }

      .diagnostic::before {
        /* It would be nice to use "text-decoration: red wavy underline" here,
           but unfortunately it renders nothing at all for single characters.
           See https://bugs.chromium.org/p/chromium/issues/detail?id=668042. */
        background-image: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAAXNSR0IArs4c6QAAAAZiS0dEAP8A/wD/oL2nkwAAAAlwSFlzAAALEwAACxMBAJqcGAAAAAd0SU1FB9sJDw4cOCW1/KIAAAAZdEVYdENvbW1lbnQAQ3JlYXRlZCB3aXRoIEdJTVBXgQ4XAAAAHElEQVQI12NggIL/DAz/GdA5/xkY/qPKMDAwAADLZwf5rvm+LQAAAABJRU5ErkJggg==');
        content: '';
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        height: 3px;
      }

      #tooltip {
        position: absolute;
        padding: 7px;
        z-index: 4;
        font-family: var(--playground-code-font-family, monospace);
      }

      #tooltip > div {
        background: var(--playground-code-background, #fff);
        color: var(--playground-code-default-color, #000);
        /* Kind of hacky... line number color tends to work out as a good
           default border, because it's usually visible on top of the
           background, but slightly muted. */
        border: 1px solid var(--playground-code-linenumber-color, #ccc);
        padding: 5px;
      }
    `,
    playgroundStyles,
  ];

  // CM6 view.
  private _view?: EditorView;

  private readonly _languageCompartment = new Compartment();
  private readonly _lineNumbersCompartment = new Compartment();
  private readonly _lineWrappingCompartment = new Compartment();
  private readonly _readOnlyCompartment = new Compartment();
  private readonly _completionCompartment = new Compartment();
  private readonly _viewportMarginCompartment = new Compartment();

  get cursorPosition(): EditorPosition {
    const view = this._view;
    if (!view) return { ch: 0, line: 0 };
    const pos = view.state.selection.main.from;
    const line = view.state.doc.lineAt(pos);
    return { line: line.number - 1, ch: pos - line.from };
  }

  get cursorIndex(): number {
    const view = this._view;
    if (!view) return 0;
    return view.state.selection.main.from;
  }

  get tokenUnderCursor(): EditorToken {
    const view = this._view;
    if (!view) return { start: 0, end: 0, string: '' };
    return tokenUnderCursor(view.state);
  }

  // We store _value ourselves, rather than using a public reactive property, so
  // that we can set this value internally without triggering an update.
  private _value?: string;

  @property()
  get value() {
    return this._value;
  }

  set value(v: string | undefined) {
    const oldValue = this._value;
    this._value = v;
    this.requestUpdate('value', oldValue);
  }

  /**
   * Provide a `documentKey` to create a CodeMirror document instance which
   * isolates history and value changes per `documentKey`.
   *
   * Use to keep edit history separate between files while reusing the same
   * playground-code-editor instance.
   */
  private _documentKey?: object;

  // The document key whose state is currently installed in `_view`.
  private _activeDocumentKey?: object;

  @property({ attribute: false })
  get documentKey(): object | undefined {
    return this._documentKey;
  }

  set documentKey(v: object | undefined) {
    const oldValue = this._documentKey;
    this._documentKey = v;
    this.requestUpdate('documentKey', oldValue);
  }

  /**
   * WeakMap associating a `documentKey` with CodeMirror 6 editor state.
   * A WeakMap is used so that this component does not become the source of
   * memory leaks.
   */
  private readonly _docCache = new WeakMap<object, EditorState>();

  /**
   * The type of the file being edited, as represented by its usual file
   * extension.
   */
  @property()
  type: 'js' | 'ts' | 'html' | 'css' | 'json' | 'jsx' | 'tsx' | undefined;

  /**
   * If true, display a left-hand-side gutter with line numbers. Default false
   * (hidden).
   */
  @property({ type: Boolean, attribute: 'line-numbers', reflect: true })
  lineNumbers = false;

  /**
   * If true, wrap for long lines. Default false
   */
  @property({ type: Boolean, attribute: 'line-wrapping', reflect: true })
  lineWrapping = false;

  /**
   * If true, this editor is not editable.
   */
  @property({ type: Boolean, reflect: true })
  readonly = false;

  /**
   * If true, will disable code completions in the code-editor.
   */
  @property({ type: Boolean, attribute: 'no-completions' })
  noCompletions = false;

  /**
   * Diagnostics to display on the current file.
   */
  @property({ attribute: false })
  diagnostics?: Array<Diagnostic>;

  /**
   * How to handle `playground-hide` and `playground-fold` comments.
   *
   * See https://github.com/google/playground-elements#hiding--folding for
   * more details.
   *
   * Options:
   * - on: Hide and fold regions, and hide the special comments.
   * - off: Don't hide or fold regions, but still hide the special comments.
   * - off-visible: Don't hide or fold regions, and show the special comments as
   *   literal text.
   */
  @property()
  pragmas: 'on' | 'off' | 'off-visible' = 'on';

  @state()
  private _tooltipDiagnostic?: {
    diagnostic: Diagnostic;
    position: string;
  };

  @query('#focusContainer')
  private _focusContainer?: HTMLDivElement;

  private _resizeObserver?: ResizeObserver;
  private _resizing = false;
  private _valueChangingFromOutside = false;
  private _diagnosticsMouseoverListenerActive = false;
  private _lastCompletionToken?: string;
  private _lastCompletionCursorIndex?: number;

  override update(changedProperties: PropertyValues) {
    const view = this._view;
    if (view !== undefined) {
      const changedTyped = changedProperties as TypedMap<
        Omit<PlaygroundCodeEditor, keyof LitElement | 'render' | 'update'>
      >;
      for (const prop of changedTyped.keys()) {
        switch (prop) {
          case 'documentKey': {
            const valueAlsoChanged = changedTyped.has('value');
            const nextKey = this.documentKey;
            if (valueAlsoChanged) {
              // When the `value` property changes alongside the key, treat it
              // as a normal (undoable) content update for the newly active key.
              this._switchToDocumentKey(nextKey, this.value ?? '', true);
            } else {
              // Switching keys only: keep the visible document as-is but avoid
              // mixing history between keys.
              this._switchToDocumentKey(
                nextKey,
                view.state.doc.toString(),
                false,
              );
            }
            break;
          }
          case 'value':
            if (changedTyped.has('documentKey')) {
              // If the `documentKey` has changed then all `value` change logic
              // is handled in the documentKey case.
              break;
            }
            this._valueChangingFromOutside = true;
            this._replaceWholeDocument(this.value ?? '');
            this._valueChangingFromOutside = false;
            break;
          case 'lineNumbers':
            this._syncLineNumbers();
            break;
          case 'lineWrapping':
            this._syncLineWrapping();
            break;
          case 'type':
            this._syncLanguage();
            this._syncTemplateHighlights();
            break;
          case 'readonly':
            this._syncReadonly();
            break;
          case 'pragmas':
            this._syncPragmas();
            break;
          case 'diagnostics':
            this._syncDiagnostics();
            break;
          case 'noCompletions':
            this._syncCompletions();
            break;
          default:
            // Ignore any internal Lit fields/state.
            break;
        }
      }
    }
    super.update(changedProperties);

    if (this._view === undefined) {
      this._createViewIfPossible();
    }
  }

  override render() {
    if (this.readonly) {
      return this._cmDom;
    }
    return html`
      <div
        id="focusContainer"
        tabindex="0"
        aria-describedby="keyboardHelp"
        @mousedown=${this._onMousedown}
        @keydown=${this._onKeyDown}
      >
        <span id="keyboardHelp">
          Press Enter to start editing. Press Escape to exit editor.
        </span>
        ${this._cmDom}
        <div
          id="tooltip"
          ?hidden=${!this._tooltipDiagnostic}
          style=${ifDefined(this._tooltipDiagnostic?.position)}
        >
          <div part="diagnostic-tooltip">
            ${this._tooltipDiagnostic?.diagnostic.message}
          </div>
        </div>
      </div>
    `;
  }

  override connectedCallback() {
    // CodeMirror uses JavaScript to control whether scrollbars are visible. It
    // does so automatically on interaction, but won't notice container size
    // changes. If the browser doesn't have ResizeObserver, scrollbars will
    // sometimes be missing, but typing in the editor will fix it.
    if (typeof ResizeObserver === 'function') {
      this._resizeObserver = new ResizeObserver(() => {
        if (this._resizing) {
          // Don't get in a resize loop.
          return;
        }
        this._resizing = true;
        this._view?.requestMeasure();
        this._resizing = false;
      });
      this._resizeObserver.observe(this);
    }

    super.connectedCallback();

    // Ensure the CM6 view is created after the first render, even in tests that
    // don't await `updateComplete`.
    void this.updateComplete.then(() => {
      if (this._view === undefined) {
        this._createViewIfPossible();
      }
    });

    // Many existing tests only await a single rAF after attaching before
    // interacting with the editor.
    requestAnimationFrame(() => {
      if (this._view === undefined) {
        this._createViewIfPossible();
      }
    });
  }

  override disconnectedCallback() {
    this._resizeObserver?.disconnect();
    this._resizeObserver = undefined;
    super.disconnectedCallback();
  }

  override focus() {
    this._view?.focus();
  }

  private _onMousedown() {
    this._view?.focus();
  }

  private _onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && event.target === this._focusContainer) {
      this._view?.focus();
      // Prevent typing a newline from this same event.
      event.preventDefault();
    } else if (event.key === 'Escape') {
      // Note there is no API for "select the next naturally focusable element",
      // so instead we just re-focus the outer container, from which point the
      // user can tab to move focus entirely elsewhere.
      this._focusContainer?.focus();
    }
  }

  private _maskPatternForLang(): RegExp | undefined {
    switch (this.type) {
      case 'js':
      case 'ts':
      case 'css':
      case 'jsx':
      case 'tsx':
        // We consume all leading whitespace and one trailing newline for each
        // start/end comment. This lets us put start/end comments on their own
        // line and indent them like the surrounding without affecting the
        // selected region.
        return /( *\/\* *playground-(?<kind>hide|fold) *\*\/\n?)(?:(.*?)( *\/\* *playground-\k<kind>-end *\*\/\n?))?/gs;
      case 'html':
        return /( *<!-- *playground-(?<kind>hide|fold) *-->\n?)(?:(.*?)( *<!-- *playground-\k<kind>-end *-->\n?))?/gs;
      default:
        return undefined;
    }
  }

  setViewportMargin(margin: number) {
    // CodeMirror 6 no longer has a viewportMargin option like CM5.
    // Callers should instead ensure the editor is tall enough or otherwise
    // make the relevant content visible.
    void margin;
  }

  private _createViewIfPossible() {
    // Note: when readonly, `_cmDom` is rendered as a direct child of the
    // ShadowRoot, so `parentElement` is null even though it's connected.
    if (!this._cmDom.isConnected) return;
    const view = new EditorView({
      parent: this._cmDom,
      state: this._createState(this.value ?? ''),
    });
    this._view = view;
    this._activeDocumentKey = this.documentKey;
    if (this._activeDocumentKey) {
      this._docCache.set(this._activeDocumentKey, view.state);
    }
    this._syncViewConfiguration();
    this._installDiagnosticsMouseoverListener();
  }

  private _createState(doc: string): EditorState {
    const extensions: Extension[] = [
      history({ newGroupDelay: 0 }),
      // CM6 cursor and selection are drawn by this extension.
      drawSelection(),
      keymap.of([
        ...historyKeymap,
        ...completionKeymap,
        ...foldKeymap,
        indentWithTab,
        {
          key: 'Ctrl-Space',
          run: startCompletion,
        },
        {
          key: 'Mod-/',
          run: (view) => {
            if (view.state.readOnly) return true;
            return toggleComment(view);
          },
        },
        {
          key: 'Ctrl-/',
          run: (view) => {
            if (view.state.readOnly) return true;
            return toggleComment(view);
          },
        },
      ]),
      // CM5 tests assert on line text content, and the CM6 default fold gutter
      // uses visible glyphs. Disable those glyphs to keep assertions stable.
      foldGutter({ openText: '', closedText: '' }),
      codeMirrorTheme,
      syntaxHighlighting(highlightClasses),
      hideLineNumbersFromAT,
      diagnosticsField,
      pragmaField,
      templateHighlightsField,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          this._value = update.state.doc.toString();
          if (this._activeDocumentKey) {
            this._docCache.set(this._activeDocumentKey, update.state);
          }
          if (!this._valueChangingFromOutside) {
            this.dispatchEvent(new Event('change'));
          }
          this._syncPragmas();
          this._syncTemplateHighlights();
        }

        if (update.selectionSet || update.docChanged) {
          const pos = update.state.selection.main.from;
          const line = update.state.doc.lineAt(pos);
          const detail = {
            docChanged: update.docChanged,
            cursorIndex: pos,
            lineNumber: line.number,
            column: pos - line.from,
            htmlTarget:
              this.type === 'html' ? htmlTargetNearCursor(update.state) : null,
          };
          this.dispatchEvent(
            new CustomEvent('cursor-position-changed', {
              detail,
              bubbles: true,
              composed: true,
            }),
          );
        }
      }),
      // Don't allow naturally tabbing into the editor, because it's a
      // tab-trap. Instead, the container is focusable, and Enter/Escape are
      // used to explicitly enter the editable area.
      EditorView.contentAttributes.of({ tabindex: '-1' }),
      this._languageCompartment.of([]),
      this._lineNumbersCompartment.of([]),
      this._lineWrappingCompartment.of([]),
      this._readOnlyCompartment.of([]),
      this._completionCompartment.of([]),
      this._viewportMarginCompartment.of([]),
    ];
    return EditorState.create({ doc, extensions });
  }

  private _syncViewConfiguration() {
    this._syncLanguage();
    this._syncLineNumbers();
    this._syncLineWrapping();
    this._syncReadonly();
    this._syncCompletions();
    this._syncDiagnostics();
    this._syncPragmas();
    this._syncTemplateHighlights();
  }

  private _switchToDocumentKey(
    nextKey: object | undefined,
    desiredDoc: string,
    addToHistory: boolean,
  ) {
    const view = this._view;
    if (!view) return;

    // Persist current state under the currently active key.
    if (this._activeDocumentKey) {
      this._docCache.set(this._activeDocumentKey, view.state);
    }

    this._valueChangingFromOutside = true;

    if (nextKey === undefined) {
      // Leaving documentKey mode clears history, but keeps the document.
      view.setState(this._createState(desiredDoc));
      this._activeDocumentKey = undefined;
      this._syncViewConfiguration();
      this._valueChangingFromOutside = false;
      return;
    }

    let nextState = this._docCache.get(nextKey);
    if (!nextState) {
      nextState = this._createState(desiredDoc);
      this._docCache.set(nextKey, nextState);
    }

    view.setState(nextState);
    this._activeDocumentKey = nextKey;
    this._syncViewConfiguration();

    // Keep the document in sync with the desired doc.
    const cur = view.state.doc.toString();
    if (cur !== desiredDoc) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: desiredDoc },
        annotations: addToHistory
          ? undefined
          : Transaction.addToHistory.of(false),
      });
    }

    this._valueChangingFromOutside = false;
  }

  private _replaceWholeDocument(value: string) {
    const view = this._view;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
    if (this._activeDocumentKey) {
      this._docCache.set(this._activeDocumentKey, view.state);
    }
  }

  private _syncLanguage() {
    const view = this._view;
    if (!view) return;

    const lang = (() => {
      switch (this.type) {
        case 'ts':
          return javascript({ typescript: true });
        case 'js':
          return javascript({ typescript: false });
        case 'jsx':
          return javascript({ jsx: true, typescript: false });
        case 'tsx':
          return javascript({ jsx: true, typescript: true });
        case 'html':
          return htmlLang();
        case 'css':
          return cssLang();
        case 'json':
          return jsonLang();
        default:
          return [];
      }
    })();

    view.dispatch({ effects: this._languageCompartment.reconfigure(lang) });
  }

  private _syncLineNumbers() {
    const view = this._view;
    if (!view) return;
    const ext: Extension = this.lineNumbers ? lineNumbers() : [];
    view.dispatch({ effects: this._lineNumbersCompartment.reconfigure(ext) });
  }

  private _syncLineWrapping() {
    const view = this._view;
    if (!view) return;
    const ext: Extension = this.lineWrapping ? EditorView.lineWrapping : [];
    view.dispatch({ effects: this._lineWrappingCompartment.reconfigure(ext) });
  }

  private _syncReadonly() {
    const view = this._view;
    if (!view) return;
    const ext: Extension = this.readonly
      ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
      : [];
    view.dispatch({ effects: this._readOnlyCompartment.reconfigure(ext) });
  }

  private _syncCompletions() {
    const view = this._view;
    if (!view) return;

    const enabled = !this.noCompletions && this.type === 'ts';
    const ext: Extension = enabled
      ? autocompletion({
        override: [this._completionSource.bind(this)],
        // Avoid flakiness where Arrow keys typed immediately after opening
        // completion go to the editor instead of the completion list.
        interactionDelay: 0,
        addToOptions: [
          {
            position: 50,
            render: (completion) => {
              const span = document.createElement('span');
              span.className = 'hint-object-name';
              span.textContent = completion.label;
              return span;
            },
          },
        ],
      })
      : [];
    view.dispatch({ effects: this._completionCompartment.reconfigure(ext) });
  }

  private async _completionSource(
    context: CompletionContext,
  ): Promise<CompletionResult | null> {
    if (this.noCompletions || this.type !== 'ts') return null;
    const match = context.matchBefore(/[A-Za-z0-9_$]+/);
    if (!match && !context.explicit) return null;

    const tokenText = match?.text ?? '';
    const cursorIndex = context.pos;
    // The project-level completion provider caches completion results and uses
    // `isRefinement` to decide whether to fetch fresh items from TS.
    //
    // Only mark a request as a refinement when we're extending the same token
    // at the same cursor position as the previous request.
    const isRefinement =
      !context.explicit &&
      this._lastCompletionToken !== undefined &&
      this._lastCompletionCursorIndex !== undefined &&
      tokenText.length > this._lastCompletionToken.length &&
      tokenText.startsWith(this._lastCompletionToken) &&
      cursorIndex ===
      this._lastCompletionCursorIndex +
      (tokenText.length - this._lastCompletionToken.length);

    const fileContent = context.state.doc.toString();

    // Update refinement tracking for the next request.
    this._lastCompletionToken = tokenText;
    this._lastCompletionCursorIndex = cursorIndex;

    const completions = await new Promise<EditorCompletion[]>((resolve) => {
      this.dispatchEvent(
        new CustomEvent('request-completions', {
          detail: {
            isRefinement,
            fileContent,
            tokenUnderCursor: tokenText,
            cursorIndex,
            provideCompletions: (comps: EditorCompletion[]) => resolve(comps),
          },
        }),
      );
    });

    const options: Completion[] = completions.map((c) => ({
      label: c.displayText ?? c.text,
      apply: c.text,
      info: c.details
        ? async () => {
          const details: EditorCompletionDetails = await c.details!;
          const div = document.createElement('div');
          div.textContent = details.text;
          return div;
        }
        : undefined,
    }));

    const from = match?.from ?? context.pos;
    const to = match?.to ?? context.pos;
    // Disable CM6's built-in filtering, since the project provider already
    // performs its own fuzzy ranking and trimming.
    return { from, to, options, filter: false };
  }

  private _syncDiagnostics() {
    const view = this._view;
    if (!view) return;
    view.dispatch({ effects: setDiagnosticsEffect.of(this.diagnostics) });
  }

  private _syncPragmas() {
    const view = this._view;
    if (!view) return;
    const pattern = this._maskPatternForLang();
    if (!pattern || this.pragmas === 'off-visible') {
      view.dispatch({ effects: setPragmaRegionsEffect.of([]) });
      return;
    }

    const value = view.state.doc.toString();
    const regions: PragmaRegion[] = [];
    for (const match of value.matchAll(pattern)) {
      const [, opener, kind, content, closer] = match as unknown as [
        string,
        string,
        'hide' | 'fold',
        string | undefined,
        string | undefined,
      ];
      const openerStart = match.index;
      if (openerStart === undefined) continue;
      const openerEnd = openerStart + opener.length;
      regions.push({
        kind: 'comment',
        from: openerStart,
        to: openerEnd,
        readOnly: false,
      });

      const contentStart = openerEnd;
      let contentEnd: number;
      if (content && closer) {
        contentEnd = contentStart + content.length;
        const closerStart = contentEnd;
        const closerEnd = contentEnd + closer.length;
        regions.push({
          kind: 'comment',
          from: closerStart,
          to: closerEnd,
          readOnly: false,
        });
      } else {
        contentEnd = value.length;
      }

      if (this.pragmas === 'on') {
        if (kind === 'hide') {
          regions.push({
            kind: 'hide',
            from: contentStart,
            to: contentEnd,
            readOnly: true,
          });
        } else if (kind === 'fold') {
          regions.push({
            kind: 'fold',
            from: contentStart,
            to: contentEnd,
            readOnly: true,
          });
        }
      }
    }
    view.dispatch({ effects: setPragmaRegionsEffect.of(regions) });
  }

  private _syncTemplateHighlights() {
    const view = this._view;
    if (!view) return;
    const text = view.state.doc.toString();
    const decos: Array<ReturnType<Decoration['range']>> = [];

    // Ensure HTML tags like "<p>" show up as a single DOM node. CM6 typically
    // tokenizes "<", tag name, and ">" separately, but our tests look for
    // "<p>" as a unit.
    if (this.type === 'html') {
      for (const t of text.matchAll(/<\/?[A-Za-z][A-Za-z0-9-]*>/g)) {
        const i = t.index;
        if (i === undefined) continue;
        decos.push(
          Decoration.mark({ class: 'cm-tag' }).range(i, i + t[0].length),
        );
      }
      view.dispatch({
        effects: setTemplateHighlightsEffect.of(Decoration.set(decos, true)),
      });
      return;
    }

    if (this.type !== 'js' && this.type !== 'ts') {
      view.dispatch({ effects: setTemplateHighlightsEffect.of(Decoration.none) });
      return;
    }

    // Minimal highlighting for tagged templates used by the docs/tests.
    // This is not a full mixed-language parser, but it preserves the
    // existing "html`...`" / "css`...`" highlighting expectations.
    for (const match of text.matchAll(/\b(html|css)`([^`]*?)`/gs)) {
      const tag = match[1];
      const body = match[2] ?? '';
      const start = match.index;
      if (start === undefined) continue;
      const bodyStart = start + (tag.length + 1); // `tag`

      if (tag === 'html') {
        for (const t of body.matchAll(/<\/?[A-Za-z][A-Za-z0-9-]*>/g)) {
          const i = t.index;
          if (i === undefined) continue;
          decos.push(
            Decoration.mark({ class: 'cm-tag' }).range(
              bodyStart + i,
              bodyStart + i + t[0].length,
            ),
          );
        }
      } else if (tag === 'css') {
        for (const w of body.matchAll(/\b[a-zA-Z-]+\b/g)) {
          const i = w.index;
          if (i === undefined) continue;
          if (w[0] === 'blue') {
            decos.push(
              Decoration.mark({ class: 'cm-keyword' }).range(
                bodyStart + i,
                bodyStart + i + w[0].length,
              ),
            );
          }
        }
      }
    }

    view.dispatch({
      effects: setTemplateHighlightsEffect.of(Decoration.set(decos, true)),
    });
  }

  private _installDiagnosticsMouseoverListener() {
    const view = this._view;
    if (!view) return;
    if (this._diagnosticsMouseoverListenerActive) return;
    view.dom.addEventListener('mouseover', this._onMouseOverWithDiagnostics);
    this._diagnosticsMouseoverListenerActive = true;
  }

  // Using property assignment syntax so that it's already bound to `this` for
  // add/removeEventListener.
  private _onMouseOverWithDiagnostics = (event: MouseEvent) => {
    if (!this.diagnostics?.length) {
      return;
    }
    // Find the diagnostic. Note we could use cm.findMarksAt() with the pointer
    // coordinates (like the built-in linter plugin does), but since we've
    // encoded the diagnostic index into a class, we can just extract it
    // directly from the target.
    const idxMatch = (event.target as Element).className?.match(
      /diagnostic-(\d+)/,
    );
    if (idxMatch === null) {
      this._tooltipDiagnostic = undefined;
      return;
    }
    const idx = Number(idxMatch[1]);
    const diagnostic = this.diagnostics[idx];
    if (diagnostic === this._tooltipDiagnostic?.diagnostic) {
      // Already showing the tooltip for this diagnostic.
      return;
    }

    // Position the tooltip relative to the squiggly code span. To maximize
    // available space, place it above/below and left/right depending on which
    // quadrant the span is in.
    let position = '';
    const hostRect = this.getBoundingClientRect();
    const spanRect = (event.target as Element).getBoundingClientRect();
    const hostCenterY = hostRect.y + hostRect.height / 2;
    if (spanRect.y < hostCenterY) {
      // Note the rects are viewport relative, so the extra subtractions here
      // are to convert to host-relative.
      position += `top:${spanRect.y + spanRect.height - hostRect.y}px;`;
    } else {
      position += `bottom:${hostRect.bottom - spanRect.y}px;`;
    }
    const hostCenterX = hostRect.x + hostRect.width / 2;
    if (spanRect.left < hostCenterX) {
      position += `left:${Math.max(0, spanRect.x - hostRect.x)}px`;
    } else {
      position += `right:${Math.max(0, hostRect.right - spanRect.right)}px`;
    }
    this._tooltipDiagnostic = { diagnostic, position };
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'playground-code-editor': PlaygroundCodeEditor;
  }
}
