/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import { html, css, PropertyValues, nothing } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';

import '@material/mwc-icon-button';

import './internal/tab-bar.js';
import './internal/tab.js';
import './playground-file-system-controls.js';
import '@material/mwc-menu/mwc-menu-surface.js';

import { MenuSurface } from '@material/mwc-menu/mwc-menu-surface.js';
import { PlaygroundConnectedElement } from './playground-connected-element.js';

import { PlaygroundFileEditor } from './playground-file-editor.js';
import { PlaygroundFileSystemControls } from './playground-file-system-controls.js';
import { FilesChangedEvent, PlaygroundProject } from './playground-project.js';
import { PlaygroundInternalTab } from './internal/tab.js';

/**
 * A horizontal bar of tabs for switching between playground files, with
 * optional controls for create/delete/rename.
 */
@customElement('playground-tab-bar')
export class PlaygroundTabBar extends PlaygroundConnectedElement {
  static override styles = css`
    :host {
      display: flex;
      font-size: var(--playground-tab-bar-font-size, 14px);
      height: var(--playground-bar-height, 40px);
      background: var(--playground-tab-bar-background, #eaeaea);
      align-items: center;
    }

    playground-internal-tab-bar {
      height: var(--playground-bar-height, 40px);
    }

    playground-internal-tab {
      color: var(--playground-tab-bar-foreground-color, #000);
      border-right: 4px solid transparent;
    }

    playground-internal-tab.drop-zone {
      border-right: 4px solid #6200ee;
    }

    playground-internal-tab[active] {
      color: var(
        --playground-tab-bar-active-color,
        var(--playground-highlight-color, #6200ee)
      );
      background: var(--playground-tab-bar-active-background, transparent);
    }

    playground-internal-tab::part(button) {
      box-sizing: border-box;
      padding: 0 24px 0 24px;
      width: max-content;
    }

    playground-internal-tab.draggable::part(button) {
      /* The 24px drag indicator and menu button with opacity 0 now serve as padding-left and padding-right. */
      padding-left: 0 !important;
      padding-right: 0 !important;
    }
    
    .drag-indicator {
      color: var(--mdc-theme-text-disabled-on-light, rgba(0, 0, 0, 0.1));
      --mdc-icon-button-size: 24px;
      --mdc-icon-size: 24px;
    }

    .menu-button {
      visibility: hidden;
      --mdc-icon-button-size: 24px;
      --mdc-icon-size: 24px;
    }

    playground-internal-tab:hover > .menu-button,
    playground-internal-tab:focus-within > .menu-button {
      visibility: visible;
    }

    mwc-icon-button {
      color: var(--playground-tab-bar-foreground-color);
    }
  `;

  /**
   * Allow the user to add, remove, and rename files in the project's virtual
   * filesystem. Disabled by default.
   */
  @property({ type: Boolean, attribute: 'editable-file-system', reflect: true })
  editableFileSystem = false;

  @state()
  private _activeFileName = '';

  @state()
  private _activeFileIndex = 0;

  @state()
  private _draggableFileIndex: number | undefined = undefined;

  @state()
  private _draggedFileIndex: number | undefined = undefined;

  @state()
  private _targetFileIndex: number | undefined = undefined;

  @query('playground-file-system-controls')
  private _fileSystemControls?: PlaygroundFileSystemControls;

  @query('mwc-menu-surface')
  private _tabPanel?: MenuSurface;

  /**
   * The actual `<playground-file-editor>` node, determined by the `editor`
   * property.
   */
  @state()
  private _editor?: PlaygroundFileEditor;

  /**
   * The editor that this tab bar controls. Either the
   * `<playground-file-editor>` node itself, or its `id` in the host scope.
   */
  @property()
  set editor(elementOrId: PlaygroundFileEditor | string) {
    if (typeof elementOrId === 'string') {
      // Defer querying the host to a rAF because if the host renders this
      // element before the one we're querying for, it might not quite exist
      // yet.
      requestAnimationFrame(() => {
        const root = this.getRootNode() as ShadowRoot | Document;
        this._editor =
          (root.getElementById(elementOrId) as PlaygroundFileEditor | null) ??
          undefined;
      });
    } else {
      this._editor = elementOrId;
    }
  }

  private get _visibleFiles() {
    return (this._project?.files ?? []).filter(({ hidden }) => !hidden);
  }

  override update(changedProperties: PropertyValues) {
    if (changedProperties.has('_project')) {
      const oldProject = changedProperties.get('_project') as PlaygroundProject;
      if (oldProject) {
        oldProject.removeEventListener(
          'filesChanged',
          this._onProjectFilesChanged
        );
      }
      if (this._project) {
        this._handleFilesChanged(true);
        this._project.addEventListener(
          'filesChanged',
          this._onProjectFilesChanged
        );
      }
    }
    if (changedProperties.has('_activeFileName') && this._editor) {
      this._editor.filename = this._activeFileName;
      this._setNewActiveFile();
    }
    super.update(changedProperties);
  }

  override render() {
    return html`
      <playground-internal-tab-bar
        @tabchange=${this._onTabchange}
        label="File selector"
      >
        ${this._visibleFiles.map(
      ({ name, label }, index) =>
        html`<playground-internal-tab
              .active=${name === this._activeFileName}
              data-filename=${name}
              draggable=${this.editableFileSystem && index === this._draggableFileIndex && this._visibleFiles.length > 2}
              class=${this.editableFileSystem && this._visibleFiles.length > 2 ? `${name !== 'index.html' ? 'draggable' : ''} ${index === this._targetFileIndex ? 'drop-zone' : ''}` : ''}
              @dragstart=${(event: DragEvent) =>
            this._originTabDragStart(index, event)}
              @dragend=${() => this._originTabDragEnd()}
              @dragover=${(event: DragEvent) =>
            this._targetTabDragOver(index, event)}
              @dragleave=${(event: DragEvent) =>
            this._targetTabDragLeave(event)}
              @drop=${(event: DragEvent) => this._targetTabDrop(event)}
            >
              ${this.editableFileSystem && name !== 'index.html' && this._visibleFiles.length > 2
            ? html`<mwc-icon-button
                    class="drag-indicator"
                    @mouseover=${() => this._dragIndicatorMouseOver(index)}
                    @mouseout=${() => this._dragIndicatorMouseOut()}
                  >
                    <!-- Source: https://material.io/resources/icons/?icon=menu&style=baseline -->
                    <svg
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      fill="currentcolor"
                    >
                      <path
                        d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"
                      />
                    </svg>
                  </mwc-icon-button>`
            : nothing}
              ${label || name}
              ${this.editableFileSystem && name !== 'index.html'
            ? html`<mwc-icon-button
                    aria-label="File menu"
                    class="menu-button"
                    @click=${(event: CustomEvent) =>
                this._onOpenMenu(name, event)}
                  >
                    <!-- Source: https://material.io/resources/icons/?icon=menu&style=baseline -->
                    <svg
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      fill="currentcolor"
                    >
                      <path
                        d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"
                      />
                    </svg>
                  </mwc-icon-button>`
            : nothing}
            </playground-internal-tab>`
    )}
      </playground-internal-tab-bar>

      <mwc-icon-button aria-label="View tabs" @click=${this._onOpenTabPanel}>
        <!-- Source: https://material.io/resources/icons/?icon=menu&style=baseline -->
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentcolor">
          <path d="M0 0h24v24H0z" fill="none" />
          <path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z" />
        </svg>
      </mwc-icon-button>

      <mwc-menu-surface fixed quick .open=${false} corner="BOTTOM_START">
        <div class="wrapper">
          <mwc-list class="menu-list">
            ${this._visibleFiles.map(
      ({ name }) =>
        html`<mwc-list-item @click=${() => this._updateActive(name)}>
                  ${name}
                </mwc-list-item>`
    )}
          </mwc-list>
        </div>
      </mwc-menu-surface>

      ${this.editableFileSystem
        ? html`
            <playground-file-system-controls
              .project=${this._project}
              @newFile=${this._onNewFile}
            >
            </playground-file-system-controls>
          `
        : nothing}
    `;
  }

  private _originTabDragStart(index: number, event: DragEvent) {
    this._draggedFileIndex = index;
    event.dataTransfer!.effectAllowed = 'move';
  }

  private _originTabDragEnd() {
    this._draggedFileIndex = undefined;
  }

  private _targetTabDragOver(index: number, event: DragEvent) {
    // Don't indicate a drop zone next to the dragged element itself.
    if (index === this._draggedFileIndex) {
      this._targetFileIndex = undefined;
      return;
    }

    let dropLeft = true;

    const target = event.target as HTMLElement;
    if (target instanceof PlaygroundInternalTab) {
      const rect = target.getBoundingClientRect();
      dropLeft = event.clientX < rect.left + rect.width / 2;
    }

    if (dropLeft) {
      // Don't indicate a drop zone next to the dragged element itself.
      if (index - 1 !== this._draggedFileIndex) {
        this._targetFileIndex = index - 1;
      } else {
        this._targetFileIndex = undefined;
      }
    } else {
      // Don't indicate a drop zone next to the dragged element itself.
      if (index + 1 !== this._draggedFileIndex) {
        this._targetFileIndex = index;
      } else {
        this._targetFileIndex = undefined;
      }
    }

    event.preventDefault();
  }

  private _targetTabDragLeave(event: DragEvent) {
    if (!(event.target as HTMLElement).contains(event.relatedTarget as Node)) {
      this._targetFileIndex = undefined;
    }
  }

  private _targetTabDrop(event: DragEvent) {
    if (
      !this._draggedFileIndex ||
      (!this._targetFileIndex && this._targetFileIndex !== 0)
    ) {
      return;
    }

    this._project!.moveFileAfter(this._draggedFileIndex, this._targetFileIndex);
    this._targetFileIndex = undefined;

    event.preventDefault();
  }

  private _dragIndicatorMouseOver(index: number) {
    this._draggableFileIndex = index;
  }

  private _dragIndicatorMouseOut() {
    this._draggableFileIndex = undefined;
  }

  private _onProjectFilesChanged = (event: FilesChangedEvent) => {
    this._handleFilesChanged(event.projectLoaded);
  };

  private _handleFilesChanged(newProjectLoaded = false) {
    if (newProjectLoaded) {
      const fileToSelect = this._visibleFiles.find(
        (file) => file.selected
      )?.name;
      if (fileToSelect !== undefined) {
        this._activeFileName = fileToSelect;
      }
    }
    this._setNewActiveFile();
    this.requestUpdate();
  }

  private _onTabchange(
    event: CustomEvent<{
      tab?: PlaygroundInternalTab;
      previous?: PlaygroundInternalTab;
    }>
  ) {
    const tab = event.detail.tab;
    if (!tab) {
      return;
    }
    const name = tab.dataset['filename']!;
    const index = tab.index!;
    if (name !== this._activeFileName) {
      this._activeFileName = name;
      this._activeFileIndex = index;
    }
  }

  private _onOpenTabPanel(
    event: CustomEvent<{ index: number; anchor: HTMLElement }>
  ) {
    const panel = this._tabPanel;
    if (!panel) {
      return;
    }
    panel.open = true;

    panel.anchor = event.target as HTMLElement;
    event.stopPropagation();
  }

  private _updateActive(filename: string) {
    this._activeFileName = filename;
    this._setNewActiveFile();

    if (this._tabPanel) {
      this._tabPanel.open = false;
    }
  }

  private _onOpenMenu(
    filename: string,
    event: CustomEvent<{ index: number; anchor: HTMLElement }>
  ) {
    const controls = this._fileSystemControls;
    if (!controls) {
      return;
    }
    controls.state = 'menu';
    controls.filename = filename;
    controls.anchorElement = event.target as HTMLElement;
    event.stopPropagation();
  }

  private _onNewFile(event: CustomEvent<{ filename: string }>) {
    this._activeFileName = event.detail.filename;
    // TODO(aomarks) We should focus the editor here. However,
    // CodeMirror.focus() isn't working for some reason.
  }

  /**
   * Whenever a file is created, deleted, or renamed, figure out what the best
   * new active tab should be.
   */
  private _setNewActiveFile() {
    // Stay on the same filename if it's still around, even though its index
    // might have changed.
    if (this._activeFileName) {
      const index = this._visibleFiles.findIndex(
        (file) => file.name === this._activeFileName
      );
      if (index >= 0) {
        this._activeFileIndex = index;
        return;
      }
    }

    // Stay on the same index, or the nearest one to the left of where we were
    // before.
    for (let i = this._activeFileIndex; i >= 0; i--) {
      const file = this._visibleFiles[i];
      if (file && !file.hidden) {
        this._activeFileName = file.name;
        return;
      }
    }

    // No visible file to display.
    this._activeFileIndex = 0;
    this._activeFileName = '';
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'playground-tab-bar': PlaygroundTabBar;
  }
}
