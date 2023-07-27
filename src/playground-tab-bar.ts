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
      border: none;
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
    }

    :host([editable-file-system]) playground-internal-tab:not([data-filename="index.html"])::part(button) {
      /* The 24px drag indicator and menu button with opacity 0 now serve as padding-left and padding-right. */
      padding-left: 0;
      padding-right: 0;
    }
    
    .drag-indicator {
      color: var(--mdc-theme-text-disabled-on-light,rgba(0,0,0,0.1));
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
    
    .drop-zone {
      width: 8px;
      height: 100%;
      background-color: transparent;
    }

    .drop-zone.active {
      background-color: #6200ee;
    }

    .add-file-button {
      margin: 0 4px;
      opacity: 70%;
      --mdc-icon-button-size: 24px;
      --mdc-icon-size: 24px;
    }

    .add-file-button:hover {
      opacity: 1;
    }

    playground-internal-tab::part(button) {
      width: max-content;
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
  private _dragged: HTMLElement | null = null;

  @state()
  private _dragoverCount = 0;

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
      ({ name, label }) =>
        html`<playground-internal-tab
              .active=${name === this._activeFileName}
              data-filename=${name}
              @dragstart=${(event: DragEvent) => this._originTabDragStart(event)}
              @dragend=${() => this._originTabDragEnd}
              @dragover=${(event: DragEvent) => this._targetTabDragOver(event)}
              @dragleave=${(event: DragEvent) => this._targetTabDragLeave(event)}
              @drop=${(event: DragEvent) => this._targetTabDrop(event)}
            >
            ${this.editableFileSystem && name !== 'index.html'
            ? html`<mwc-icon-button
                    class="drag-indicator"
                    @mouseover=${() => this._dragIndicatorMouseOver(name)}
                    @mouseout=${() => this._dragIndicatorMouseOut(name)}
                    @dragover=${(event: DragEvent) => this._childDragOver(event)}
                    @dragleave=${(event: DragEvent) => this._childDragLeave(event)}
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
                    @click=${this._onOpenMenu}
                    @dragover=${(event: DragEvent) => this._childDragOver(event)}
                    @dragleave=${(event: DragEvent) => this._childDragLeave(event)}
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
            </playground-internal-tab>
            <div class="drop-zone"
              @dragover=${(event: DragEvent) => this._dropZoneDragOver(event)}
              @dragleave=${(event: DragEvent) => this._dropZoneDragLeave(event)}
              @drop=${(event: DragEvent) => this._dropZoneDrop(event)}
            >
            </div>`
    )}
      </playground-internal-tab-bar>

      <mwc-icon-button
        aria-label="View tabs"
        @click=${this._onOpenTabPanel}
      >
        <!-- Source: https://material.io/resources/icons/?icon=menu&style=baseline -->
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="currentcolor"
        >
          <path d="M0 0h24v24H0z" fill="none"/>
          <path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/>
        </svg>
      </mwc-icon-button>

      <mwc-menu-surface
      fixed
      quick
      .open=${false}
      corner="BOTTOM_START"
      ><div class="wrapper">
      <mwc-list class="menu-list">
      ${this._visibleFiles.map(({ name }) =>
      html`
        <mwc-list-item @click=${this._updateActive}>
          ${name}
        </mwc-list-item>
      `
    )}
      </mwc-list>
      </div></mwc-menu-surface>

      ${this.editableFileSystem
        ? html`
            <playground-file-system-controls
              .project=${this._project}
              @newFile=${this._onNewFile}
            >
            </playground-file-system-controls>
          `
        : nothing
      }
    `;
  }

  private _originTabDragStart(event: DragEvent) {
    this._dragged = event.target as HTMLElement;
    event.dataTransfer!.effectAllowed = "move";
  }

  private _originTabDragEnd() {
    this._dragged = null;
  }

  private _targetTabDragOver(event: DragEvent) {
    const target = event.target as HTMLElement;

    // Don't indicate a drop zone next to the dragged element itself.
    if (target === this._dragged) {
      return;
    }

    const rect = target.getBoundingClientRect();
    const dropLeft = event.clientX < rect.left + rect.width / 2;

    const leftDropZone = target.previousElementSibling as HTMLElement;
    const rightDropZone = target.nextElementSibling as HTMLElement;

    if (dropLeft) {
      rightDropZone?.classList.remove("active");

      // Don't indicate a drop zone next to the dragged element itself.
      if (leftDropZone && leftDropZone.previousElementSibling !== this._dragged) {
        leftDropZone.classList.add("active");
      }
    } else {
      leftDropZone?.classList.remove("active");

      // Don't indicate a drop zone next to the dragged element itself.
      if (rightDropZone && rightDropZone.nextElementSibling !== this._dragged) {
        rightDropZone.classList.add("active");
      }
    }

    this._incrementDragoverCount(event);
  }

  private _targetTabDragLeave(event: DragEvent) {
    this._decrementDragoverCount(event);
    if (this._dragoverCount === 0) {
      const dropZone = this.shadowRoot!.querySelector(".drop-zone.active");
      dropZone?.classList.remove("active");
    }
  }

  private _targetTabDrop(event: DragEvent) {
    const dropZone = this.shadowRoot!.querySelector(".drop-zone.active");

    if (!dropZone) {
      return;
    }

    const draggedFileName = this._dragged!.dataset["filename"]!;
    const targetFileName = (dropZone.previousElementSibling as HTMLElement).dataset["filename"]!;

    if (this._project) {
      this._project.moveFileAfter(draggedFileName, targetFileName);
    }

    dropZone.classList.remove("active");

    event.preventDefault();
  }

  private _dragIndicatorMouseOver(name: string) {
    const parent = this.shadowRoot!.querySelector(`[data-filename="${name}"]`) as HTMLElement;
    parent.draggable = true
  }

  private _dragIndicatorMouseOut(name: string) {
    const parent = this.shadowRoot!.querySelector(`[data-filename="${name}"]`) as HTMLElement;
    parent.draggable = false;
  }

  private _childDragOver(event: DragEvent) {
    if (this._dragged === null) {
      return;
    }
    this._incrementDragoverCount(event);
  }

  private _childDragLeave(event: DragEvent) {
    if (this._dragged === null) {
      return;
    }
    this._decrementDragoverCount(event);
  }

  private _dropZoneDragOver(event: DragEvent) {
    const dropZone = event.target as HTMLElement;

    // Don't indicate a drop zone next to the dragged element itself.
    if (dropZone.previousElementSibling === this._dragged || dropZone.nextElementSibling === this._dragged) {
      return;
    }

    dropZone.classList.add("active");

    event.preventDefault(); // Needed for drop to work.
  }

  private _dropZoneDragLeave(event: DragEvent) {
    const dropZone = event.target as HTMLElement;
    dropZone.classList.remove("active");
  }

  private _dropZoneDrop(event: DragEvent) {
    const dropZone = event.target as HTMLElement;

    const draggedFileName = this._dragged!.dataset["filename"]!;
    const targetFileName = (dropZone.previousElementSibling as HTMLElement).dataset["filename"]!;

    if (this._project) {
      this._project.moveFileAfter(draggedFileName, targetFileName);
    }

    dropZone.classList.remove("active");

    event.preventDefault();
  }

  private _incrementDragoverCount(event: DragEvent) {
    event.preventDefault();
    this._dragoverCount++;
  }

  private _decrementDragoverCount(event: DragEvent) {
    event.preventDefault();
    this._dragoverCount--;
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

  private _updateActive(event: Event) {
    const target = event.target as HTMLElement;
    const name = target.innerText;
    this._activeFileName = name;
    this._setNewActiveFile();

    if (this._tabPanel) {
      this._tabPanel.open = false;
    }
  }

  private _onOpenMenu(
    event: CustomEvent<{ index: number; anchor: HTMLElement }>
  ) {
    const controls = this._fileSystemControls;
    if (!controls) {
      return;
    }
    controls.state = 'menu';
    // Figure out which file the open menu should be associated with. It's not
    // necessarily the active tab, since you can click on the menu button for a
    // tab without activating that tab.
    //
    // We're looking for a "data-filename" attribute in the event path, which
    // should be on the <playground-internal-tab>.
    //
    // Note that we can't be sure what the target of the click event will be.
    // Between MWC v0.25.1 and v0.25.2, when clicking on an <mwc-icon-button>,
    // the target changed from the <mwc-icon-button> to its internal <svg>.
    for (const el of event.composedPath()) {
      if (el instanceof HTMLElement && el.dataset['filename']) {
        controls.filename = el.dataset['filename'];
        break;
      }
    }
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
