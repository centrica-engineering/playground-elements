/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

// Minimal theme support for CodeMirror 6.
//
// The configurator expects Lit `CSSResult`s so it can include them in the
// component stylesheet list. Themes are expressed as CSS custom properties on
// `.playground-theme-*` classes.

import dark from '../themes/dark.css.js';

export const themeNames = ['dark'] as const;

export const themeStyles = [dark] as const;
