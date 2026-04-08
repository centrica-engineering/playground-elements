/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {LitElement} from 'lit';
import {property, state} from 'lit/decorators.js';
import {PlaygroundProject} from './playground-project.js';

/**
 * Base class that connects an element to a playground-project element.
 */
export class PlaygroundConnectedElement extends LitElement {
  /**
   * The project that this element is associated with. Either the
   * `playground-project` node itself, or its `id` in the host scope.
   */
  @property()
  set project(elementOrId: PlaygroundProject | string | undefined) {
    if (typeof elementOrId === 'string') {
      const resolve = () => {
        const root = this.getRootNode() as ShadowRoot | Document;
        return (
          (root.getElementById(elementOrId) as PlaygroundProject | null) ??
          undefined
        );
      };

      // Try to resolve immediately first. This avoids missing early events
      // (e.g. initial compileStart/urlChanged) when the project already exists.
      const immediate = resolve();
      if (immediate) {
        this._project = immediate;
        return;
      }

      // If the host renders this element before the project element, defer to
      // a rAF and try again.
      requestAnimationFrame(() => {
        this._project = resolve();
      });
    } else {
      this._project = elementOrId;
    }
  }

  /**
   * The actual `playground-project` node, determined by the `project`
   * property.
   */
  @state()
  protected _project?: PlaygroundProject;
}
