/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

export {
  EditorState,
  StateEffect,
  StateField,
  Compartment,
} from '@codemirror/state';
export {
  EditorView,
  keymap,
  Decoration,
  WidgetType,
  lineNumbers,
  drawSelection,
  type DecorationSet,
} from '@codemirror/view';
export {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
  undoDepth,
  redoDepth,
  toggleComment,
} from '@codemirror/commands';
export {foldGutter, foldKeymap} from '@codemirror/language';
export {
  autocompletion,
  completionKeymap,
  startCompletion,
} from '@codemirror/autocomplete';
export {HighlightStyle, syntaxHighlighting} from '@codemirror/language';
export {tags} from '@lezer/highlight';
