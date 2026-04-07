/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {html, css, PropertyValues} from 'lit';
import {customElement, property, query} from 'lit/decorators.js';

import '@material/web/menu/menu.js';
import '@material/web/menu/menu-item.js';
import '@material/web/dialog/dialog.js';
import '@material/web/textfield/outlined-text-field.js';
import '@material/web/button/filled-button.js';
import '@material/web/button/outlined-button.js';

import type {Menu} from '@material/web/menu/menu.js';
import type {MdOutlinedTextField} from '@material/web/textfield/outlined-text-field.js';
import type {MdDialog} from '@material/web/dialog/dialog.js';

import {PlaygroundConnectedElement} from './playground-connected-element.js';

/**
 * Floating controls for creating, deleting, and renaming files in playground
 * virtual file system.
 */
@customElement('playground-file-system-controls')
export class PlaygroundFileSystemControls extends PlaygroundConnectedElement {
  static override styles = css`
    :host {
      /* Used by Material Web components for theming. */
      --md-sys-color-primary: var(
        --playground-floating-controls-color,
        var(--playground-highlight-color, #6200ee)
      );
    }

    md-menu {
      min-width: 160px;
    }

    .actions {
      margin-top: 18px;
      display: flex;
      justify-content: flex-end;
    }

    .actions > * {
      margin-left: 12px;
    }
  `;

  /**
   * The element that these controls will be positioned adjacent to.
   */
  @property({attribute: false})
  anchorElement?: HTMLElement;

  /**
   * The kind of control to display:
   *
   * -  closed: Hidden.
   * -    menu: Menu with "Rename" and "Delete" items.
   * -  rename: Control for renaming an existing file.
   * - newfile: Control for creating a new file.
   */
  @property()
  state: 'closed' | 'menu' | 'rename' | 'newfile' = 'closed';

  /**
   * When state is "menu" or "newfile", the name of the relevant file.
   */
  @property()
  filename?: string;

  @query('md-menu')
  private _menu!: Menu;

  @query('md-dialog')
  private _dialog!: MdDialog;

  @query('.filename-input')
  private _filenameInput?: MdOutlinedTextField;

  private _postStateChangeRenderDone = false;

  override update(changedProperties: PropertyValues) {
    if (changedProperties.has('state')) {
      this._postStateChangeRenderDone = false;
    }
    super.update(changedProperties);
  }

  override render() {
    return html`
      <md-menu
        positioning="fixed"
        quick
        anchorCorner="end-start"
        menuCorner="start-start"
        .anchorElement=${this.anchorElement ?? null}
        .open=${this.state === 'menu'}
        @closed=${this._onSurfaceClosed}
      >
        <md-menu-item id="renameButton" @click=${this._onMenuSelectRename}>
          <svg
            slot="start"
            height="24"
            viewBox="0 0 24 24"
            width="24"
            fill="currentcolor"
          >
            <path
              d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
            />
          </svg>
          <div slot="headline">Rename</div>
        </md-menu-item>
        <md-menu-item id="deleteButton" @click=${this._onMenuSelectDelete}>
          <svg
            slot="start"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="currentcolor"
          >
            <path
              d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
            />
          </svg>
          <div slot="headline">Delete</div>
        </md-menu-item>
      </md-menu>

      <md-dialog
        .open=${this.state === 'rename' || this.state === 'newfile'}
        @closed=${this._onDialogClosed}
      >
        <div slot="headline">
          ${this.state === 'rename' ? 'Rename file' : 'Create file'}
        </div>
        <div slot="content">
          <md-outlined-text-field
            class="filename-input"
            label="Filename"
            .value=${this.state === 'rename' ? this.filename || '' : ''}
            @input=${this._onFilenameInputChange}
            @keydown=${this._onFilenameInputKeydown}
          ></md-outlined-text-field>
        </div>
        <div class="actions" slot="actions">
          <md-outlined-button @click=${this._onClickCancel}
            >Cancel</md-outlined-button
          >
          <md-filled-button
            class="submit-button"
            ?disabled=${!this._filenameInputValid}
            @click=${this.state === 'rename'
              ? this._onSubmitRename
              : this._onSubmitNewFile}
            >${this.state === 'rename' ? 'Rename' : 'Create'}</md-filled-button
          >
        </div>
      </md-dialog>
    `;
  }

  override async updated() {
    if (this._postStateChangeRenderDone) {
      return;
    }
    if (this.state === 'menu') {
      // Focus the first menu item so that keyboard controls work.
      const menu = this._menu;
      if (menu) {
        await menu.updateComplete;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (menu as any).items?.[0]?.focus?.();
      }
    } else if (this.state === 'rename' || this.state === 'newfile') {
      // Focus the filename input.
      const input = this._filenameInput;
      if (input) {
        await input.updateComplete;
        if (this.state === 'newfile') {
          // When opening the "create file" dialog, always start with an empty
          // field. Lit won't necessarily re-assign the same value (""), so we
          // clear imperatively on the state transition.
          input.value = '';
          this.requestUpdate();
        }
        input.focus();
        if (this.state === 'rename') {
          // Pre-select just the basename (e.g. "foo" in "foo.html"), since
          // users typically don't want to edit the extension.
          const end = input.value.lastIndexOf('.');
          if (end > 0) {
            input.selectionStart = 0;
            input.selectionEnd = end;
          }
        }
      }
    }
    this._postStateChangeRenderDone = true;
  }

  private _onSurfaceClosed() {
    this.state = 'closed';
  }

  private _onDialogClosed() {
    // If we were editing, return to closed.
    if (this.state === 'rename' || this.state === 'newfile') {
      this.state = 'closed';
    }
  }

  private _onClickCancel() {
    if (this.state === 'menu') {
      void this._menu?.close();
    } else {
      void this._dialog?.close();
    }
  }

  private _onMenuSelectRename() {
    void this._menu?.close();
    this.state = 'rename';
  }

  private _onMenuSelectDelete() {
    void this._menu?.close();
    if (this._project && this.filename) {
      this._project.deleteFile(this.filename);
    }
  }

  private _onFilenameInputChange() {
    // Force re-evaluation of the _filenameInputValid getter (instead of managing
    // an internal property).
    this.requestUpdate();
  }

  private get _filenameInputValid(): boolean {
    return !!(
      this._project &&
      this._filenameInput &&
      this._project.isValidNewFilename(this._filenameInput.value)
    );
  }

  private _onFilenameInputKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && this._filenameInputValid) {
      event.preventDefault();
      if (this.state === 'rename') {
        this._onSubmitRename();
      } else if (this.state === 'newfile') {
        this._onSubmitNewFile();
      }
    }
  }

  private _onSubmitRename() {
    void this._dialog?.close();
    const oldFilename = this.filename;
    const newFilename = this._filenameInput?.value;
    if (this._project && oldFilename && newFilename) {
      this._project.renameFile(oldFilename, newFilename);
    }
  }

  private _onSubmitNewFile() {
    void this._dialog?.close();
    const filename = this._filenameInput?.value;
    if (this._project && filename) {
      this._project.addFile(filename);
      this.dispatchEvent(
        new CustomEvent<{filename: string}>('newFile', {
          detail: {filename},
        }),
      );
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'playground-file-system-controls': PlaygroundFileSystemControls;
  }
}
