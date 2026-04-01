/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import { assert } from '@esm-bundle/chai';
import { html, render } from 'lit';
import { PlaygroundIde } from '../playground-ide.js';
import '../playground-ide.js';
import { sendKeys, executeServerCommand } from '@web/test-runner-commands';

import { ReactiveElement } from '@lit/reactive-element';
import { PlaygroundCodeEditor } from '../playground-code-editor.js';
import { PlaygroundProject } from '../playground-project.js';
import { PlaygroundFileEditor } from '../playground-file-editor.js';
import { PlaygroundPreview } from '../playground-preview.js';
import { redo, undo, undoDepth } from '../internal/codemirror.js';
import type { EditorView } from '../internal/codemirror.js';

// There is browser variability with zero width spaces. This helper keeps tests
// consistent.
function innerTextWithoutSpaces(el?: HTMLElement | null): string {
  return el?.innerText.replace(/[\u200B\s]/g, '') ?? '';
}
suite('playground-ide', () => {
  let container: HTMLDivElement;
  let testRunning: boolean;

  setup(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    testRunning = true;
  });

  teardown(() => {
    container.remove();
    testRunning = false;
  });

  test('is registered', () => {
    assert.instanceOf(document.createElement('playground-ide'), PlaygroundIde);
  });

  const raf = async () => new Promise((r) => requestAnimationFrame(r));

  const waitForEditorView = async (editor: PlaygroundCodeEditor) => {
    for (let i = 0; i < 10; i++) {
      const view = (editor as unknown as { _view?: EditorView })._view;
      if (view) return view;
      await raf();
    }
    assert.fail('EditorView not initialized');
  };

  const getEditorValue = async (editor: PlaygroundCodeEditor) =>
    (await waitForEditorView(editor)).state.doc.toString();

  const setEditorValue = async (
    editor: PlaygroundCodeEditor,
    value: string,
  ) => {
    const view = await waitForEditorView(editor);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  };

  const pierce = async (...selectors: string[]) => {
    let node = document.body;
    for (const selector of selectors) {
      const result = (node.shadowRoot ?? node).querySelector(selector);
      assert.instanceOf(result, Element);
      if ((result as ReactiveElement).updateComplete) {
        await (result as ReactiveElement).updateComplete;
      }
      node = result as HTMLElement;
    }
    return node;
  };

  // TODO(aomarks) Use sendKeys instead
  // https://modern-web.dev/docs/test-runner/commands/#send-keys
  const updateCurrentFile = async (
    editor: PlaygroundCodeEditor,
    newValue: string,
  ) => {
    await setEditorValue(editor, newValue);
  };

  const waitForIframeLoad = (iframe: HTMLElement) =>
    new Promise<void>((resolve) => {
      iframe.addEventListener('load', () => resolve(), { once: true });
    });

  const assertPreviewContains = async (text: string) => {
    const iframe = (await pierce(
      'playground-ide',
      'playground-preview',
      'iframe',
    )) as HTMLIFrameElement;
    await waitForIframeLoad(iframe);
    // TODO(aomarks) Chromium and Webkit both fire iframe "load" after the
    // contentDocument has actually loaded, but Firefox fires it before. Why is
    // that? If not for that, we wouldn't need to poll here.
    await new Promise<void>((resolve) => {
      const check = () => {
        if (iframe.contentDocument?.body?.textContent?.includes(text)) {
          resolve();
        } else if (testRunning) {
          setTimeout(check, 10);
        }
      };
      check();
    });
  };

  const assertTabSelected = async (filename: string) => {
    await new Promise((r) => setTimeout(r));
    const tabBar = await pierce('playground-ide', 'playground-tab-bar');
    while (testRunning) {
      const selectedTab = tabBar.shadowRoot!.querySelector(
        'playground-internal-tab[active]',
      );
      if (selectedTab) {
        assert.include(
          selectedTab.textContent?.trim(),
          filename,
          `Selected tab did not contain '${filename}')`,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  test('renders HTML', async () => {
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/html" filename="index.html">
            <p>Hello HTML</p>
            <script>console.log('hello');&lt;/script>
          </script>
        </playground-ide>
      `,
      container,
    );
    await assertPreviewContains('Hello HTML');
  });

  test('handles multiple script tags', async () => {
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/html" filename="index.html">
            <script>console.log('hello');&lt;/script>
            <script>console.log('potato');&lt;/script>
          </script>
        </playground-ide>
      `,
      container,
    );

    const editor = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;
    // Wait for the editor to instantiate.
    await raf();

    assert.include(
      await getEditorValue(editor),
      `<script>console.log('hello');</script>`,
    );
    assert.include(
      await getEditorValue(editor),
      `<script>console.log('potato');</script>`,
    );
  });

  test('renders JS', async () => {
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/html" filename="index.html">
            <body>
              <script type="module" src="hello.js">&lt;/script>
            </body>
          </script>
          <script type="sample/js" filename="hello.js">
            document.body.textContent = 'Hello JS';
          </script>
        </playground-ide>
      `,
      container,
    );
    await assertPreviewContains('Hello JS');
  });

  test('renders TS', async () => {
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/html" filename="index.html">
            <body>
              <script type="module" src="hello.js">&lt;/script>
            </body>
          </script>
          <script type="sample/ts" filename="hello.ts">
            const hello: string = "Hello TS";
            document.body.textContent = hello;
          </script>
        </playground-ide>
      `,
      container,
    );
    await assertPreviewContains('Hello TS');
  });

  test('renders JSX', async () => {
    const ide = document.createElement('playground-ide');
    ide.sandboxBaseUrl = '/';
    ide.config = {
      files: {
        'index.html': {
          content: `
            <head>
              <script type="module" src="hello-react.js"></script>
            </head>
            <body></body>
          `,
        },
        'hello-react.jsx': {
          content: `
            import { React, ReactDOM } from "./mock-react.js";

            const container = document.querySelector('body');
            const root = ReactDOM.createRoot(container);
            root.render(<>hello react jsx!</>);
          `,
        },
        // `mock-react.js` avoids pulling `react` and `react-dom` from unpkg.
        // It expresses the a minimum subset required of the React API to append
        // a `TextNode` to the `body` of the playground html document.
        //
        // If more in depth integration tests are required, preact would be a
        // more robust alternative.
        'mock-react.js': {
          content: `
            class React {
              static Fragment = 'fragment';
              static createElement(
                  tag,
                  props,
                  children,
              ) {
                return document.createTextNode(children);
              }
            }

            class ReactRoot {
              root;
              constructor(root) {
                this.root = root;
              }
              render(children) {
                this.root.appendChild(children);
              }
            }

            class ReactDOM {
              static createRoot(root) {
                return new ReactRoot(root);
              }
            }

            export {React, ReactDOM};
          `,
        },
      },
    };
    container.appendChild(ide);
    await assertPreviewContains('hello react jsx!');
  });

  test('renders TSX', async () => {
    const ide = document.createElement('playground-ide');
    ide.sandboxBaseUrl = '/';
    ide.config = {
      files: {
        'index.html': {
          content: `
            <head>
              <script type="module" src="hello-react.js"></script>
            </head>
            <body></body>
          `,
        },
        'hello-react.tsx': {
          content: `
            import { React, ReactDOM } from "./mock-react.js";

            const container = document.querySelector('body');
            const root = ReactDOM.createRoot(container!);
            root.render(<>hello react tsx!</>);
          `,
        },
        // `mock-react.ts` avoids pulling `react` and `react-dom` from unpkg.
        // It expresses the a minimum subset required of the React API to append
        // a `TextNode` to the `body` of the playground html document.
        //
        // If more in depth integration tests are required, preact would be a
        // more robust alternative.
        'mock-react.ts': {
          content: `
            class React {
              static Fragment = 'fragment';
              static createElement(
                  tag: unknown,
                  props: unknown,
                  children: string,
              ) {
                return document.createTextNode(children);
              }
            }

            class ReactRoot {
              root: HTMLElement;
              constructor(root: HTMLElement) {
                this.root = root;
              }
              render(children: Element) {
                this.root.appendChild(children);
              }
            }

            class ReactDOM {
              static createRoot(root: HTMLElement): ReactRoot {
                return new ReactRoot(root);
              }
            }

            export {React, ReactDOM};
          `,
        },
      },
    };
    container.appendChild(ide);
    await assertPreviewContains('hello react tsx!');
  });

  test('re-renders HTML', async () => {
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/html" filename="index.html">
            <body>
              <p>Hello HTML 1</p>
            </body>
          </script>
        </playground-ide>
      `,
      container,
    );
    await assertPreviewContains('Hello HTML 1');

    const editor = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;
    updateCurrentFile(editor, 'Hello HTML 2');
    const project = (await pierce(
      'playground-ide',
      'playground-project',
    )) as PlaygroundProject;
    // Note we shouldn't await the save(), because assertPreviewContains waits
    // for an iframe load event, and we can legitimately get an iframe load
    // before the full compile is done since we serve each asset as soon as it
    // is ready.
    project.save();
    await assertPreviewContains('Hello HTML 2');
  });

  test('hidden file is not displayed in tab bar', async () => {
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/html" filename="index.html" hidden>
            <body>
              <script type="module" src="hello.js">&lt;/script>
            </body>
          </script>
          <script type="sample/js" filename="hello.js">
            document.body.textContent = 'Hello JS';
          </script>
        </playground-ide>
      `,
      container,
    );
    await assertPreviewContains('Hello JS');
    const tabBar = await pierce('playground-ide', 'playground-tab-bar');
    const tabs = tabBar.shadowRoot?.querySelectorAll('playground-internal-tab');
    assert.equal(tabs?.length, 1);
  });

  test('file label is displayed in tab bar', async () => {
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/html" filename="index.html" label="HTML">
            <body>
              <script type="module" src="hello.js">&lt;/script>
            </body>
          </script>
          <script type="sample/js" filename="hello.js" label="JS">
            document.body.textContent = 'Hello JS';
          </script>
        </playground-ide>
      `,
      container,
    );
    await assertPreviewContains('Hello JS');
    const tabBar = await pierce('playground-ide', 'playground-tab-bar');
    const tabs = tabBar.shadowRoot?.querySelectorAll('playground-internal-tab');
    const texts = Array.from(tabs ?? []).map((tab) => tab.textContent?.trim());
    assert.deepEqual(texts, ['HTML', 'JS']);
  });

  test('reads files from config property', async () => {
    const ide = document.createElement('playground-ide')!;
    ide.sandboxBaseUrl = '/';
    container.appendChild(ide);
    ide.config = {
      files: {
        'index.html': {
          content: 'Hello HTML',
        },
      },
    };
    await assertPreviewContains('Hello HTML');
  });

  test('line wrapping enabled', async () => {
    const ide = document.createElement('playground-ide');
    ide.sandboxBaseUrl = '/';
    ide.lineWrapping = true;
    ide.config = {
      files: {
        'index.html': {
          content: 'Foo\n    Bar that has an indent',
        },
      },
    };
    container.appendChild(ide);
    await assertPreviewContains('Foo\n    Bar that has an indent');

    const editor = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;

    const codeMirrorLongLine = editor.shadowRoot!.querySelectorAll(
      '.cm-line',
    )[1] as HTMLElement;

    const cmContent = editor.shadowRoot!.querySelector(
      '.cm-content',
    ) as HTMLElement;
    const allowedWhiteSpace = new Set(['pre-wrap', 'break-spaces']);
    assert.isTrue(
      allowedWhiteSpace.has(getComputedStyle(cmContent).whiteSpace),
    );
    assert.isTrue(
      allowedWhiteSpace.has(getComputedStyle(codeMirrorLongLine).whiteSpace),
    );
  });

  test('line wrapping enabled with line numbers', async () => {
    const ide = document.createElement('playground-ide');
    ide.sandboxBaseUrl = '/';
    ide.lineWrapping = true;
    ide.lineNumbers = true;
    ide.config = {
      files: {
        'index.html': {
          content: 'Foo\n    Bar that has an indent',
        },
      },
    };
    container.appendChild(ide);
    await assertPreviewContains('Foo\n    Bar that has an indent');

    const editor = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;

    const codeMirrorLongLine = editor.shadowRoot!.querySelectorAll(
      '.cm-line',
    )[1] as HTMLElement;

    const cmContent = editor.shadowRoot!.querySelector(
      '.cm-content',
    ) as HTMLElement;
    const allowedWhiteSpace = new Set(['pre-wrap', 'break-spaces']);
    assert.isTrue(
      allowedWhiteSpace.has(getComputedStyle(cmContent).whiteSpace),
    );
    assert.isTrue(
      allowedWhiteSpace.has(getComputedStyle(codeMirrorLongLine).whiteSpace),
    );
    assert.isNotNull(editor.shadowRoot!.querySelector('.cm-gutters'));
    assert.isNotNull(editor.shadowRoot!.querySelector('.cm-lineNumbers'));
  });

  test('a11y: is contenteditable', async () => {
    const ide = document.createElement('playground-ide');
    ide.sandboxBaseUrl = '/';
    ide.config = {
      files: {
        'index.html': {
          content: 'Foo',
        },
      },
    };
    container.appendChild(ide);
    await assertPreviewContains('Foo');

    const cmCode = await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
      '.cm-content',
    );

    assert.equal(cmCode.getAttribute('contenteditable'), 'true');
  });

  test('a11y: line numbers get aria-hidden attribute', async () => {
    const ide = document.createElement('playground-ide');
    ide.sandboxBaseUrl = '/';
    ide.lineNumbers = true;
    ide.config = {
      files: {
        'index.html': {
          content: 'Foo\nBar',
        },
      },
    };
    container.appendChild(ide);
    await assertPreviewContains('Foo\nBar');

    const editor = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;

    const queryHiddenLineNumbers = () =>
      [
        ...editor.shadowRoot!.querySelectorAll(
          '.cm-lineNumbers .cm-gutterElement',
        ),
      ].filter((gutter) => {
        const text = gutter.textContent?.trim() ?? '';
        return (
          /^\d+$/.test(text) && gutter.getAttribute('aria-hidden') === 'true'
        );
      });

    // Initial render with line-numbers enabled.
    assert.equal(queryHiddenLineNumbers().length, 2);

    // Disable line numbers.
    ide.lineNumbers = false;
    await raf();
    assert.equal(queryHiddenLineNumbers().length, 0);

    // Re-enable line numbers.
    ide.lineNumbers = true;
    await raf();
    assert.equal(queryHiddenLineNumbers().length, 2);

    // Add a line.
    await setEditorValue(editor, (editor.value ?? '') + '\nBaz');
    await raf();
    assert.equal(queryHiddenLineNumbers().length, 3);
  });

  test('a11y: focusing shows keyboard prompt', async () => {
    const ide = document.createElement('playground-ide');
    ide.sandboxBaseUrl = '/';
    ide.config = {
      files: {
        'index.html': {
          content: 'Foo',
        },
      },
    };
    container.appendChild(ide);
    await assertPreviewContains('Foo');

    const editor = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;
    const focusContainer = editor.shadowRoot!.querySelector(
      '#focusContainer',
    ) as HTMLElement;
    const editableRegion = editor.shadowRoot!.querySelector(
      '.cm-content',
    ) as HTMLElement;
    const keyboardHelp = 'Press Enter';

    const keyboardHelpEl = editor.shadowRoot!.querySelector(
      '#keyboardHelp',
    ) as HTMLElement;
    assert.ok(keyboardHelpEl);
    assert.equal(focusContainer.getAttribute('aria-describedby'), 'keyboardHelp');
    assert.include(keyboardHelpEl.textContent, keyboardHelp);

    // Focus the outer container.
    focusContainer.focus();
    await raf();
    assert.isTrue(focusContainer.matches(':focus'));

    // Press Enter to start editing
    focusContainer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await raf();
    assert.isTrue(editableRegion.matches(':focus'));

    // Press Escape to stop editing
    editableRegion.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await raf();
    assert.isTrue(focusContainer.matches(':focus'));

    // Focus something else entirely
    focusContainer.blur();
    await raf();
    assert.isFalse(focusContainer.matches(':focus'));
    assert.isFalse(editableRegion.matches(':focus'));
  });

  test('ignores query params when serving files', async () => {
    const ide = document.createElement('playground-ide');
    ide.sandboxBaseUrl = '/';
    ide.config = {
      files: {
        'index.html': {
          content: '<script>location.assign("./foo.html?xyz");</script>',
        },
        'foo.html': {
          content: 'foo.html loaded',
        },
      },
    };
    container.appendChild(ide);
    await assertPreviewContains('foo.html loaded');
  });

  test('create new files', async () => {
    const ide = document.createElement('playground-ide');
    ide.sandboxBaseUrl = '/';
    ide.config = {
      files: {
        'index.html': {
          content: 'Hello',
        },
        'package.json': {
          content: '{"dependencies":{}}',
          hidden: true,
        },
      },
    };
    container.appendChild(ide);
    const project = (await pierce(
      'playground-ide',
      'playground-project',
    )) as PlaygroundProject;
    // Need to defer another microtask for the config to initialize.
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // Already exists.
    assert.isFalse(project.isValidNewFilename('index.html'));

    // Does not exist.
    assert.isTrue(project.isValidNewFilename('newfile.ts'));
    project.addFile('newfile.ts');
    assert.isFalse(project.isValidNewFilename('newfile.ts'));

    // Exists but is hidden. Creating it unhides it and reveals the existing
    // content.
    assert.isTrue(project.isValidNewFilename('package.json'));
    project.addFile('package.json');
    assert.isFalse(project.isValidNewFilename('package.json'));
    const packageJson = project.files?.find(
      (file) => file.name === 'package.json',
    );
    assert.isFalse(packageJson?.hidden);
    assert.equal(packageJson?.content, '{"dependencies":{}}');
  });

  test('modified property', async () => {
    const ide = document.createElement('playground-ide');
    ide.sandboxBaseUrl = '/';
    ide.config = {
      files: {
        'index.html': {
          content: 'Old content',
        },
      },
    };
    container.appendChild(ide);

    const project = (await pierce(
      'playground-ide',
      'playground-project',
    )) as PlaygroundProject;

    const editor = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;

    // Need to defer another microtask for the config to initialize.
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // Note the double checks are here to add coverage for cached states.
    assert.isFalse(ide.modified);
    assert.isFalse(ide.modified);

    project.addFile('potato.html');
    assert.isTrue(ide.modified);
    assert.isTrue(ide.modified);

    project.deleteFile('potato.html');
    assert.isFalse(ide.modified);
    assert.isFalse(ide.modified);

    project.renameFile('index.html', 'potato.html');
    assert.isTrue(ide.modified);
    assert.isTrue(ide.modified);

    project.renameFile('potato.html', 'index.html');
    assert.isFalse(ide.modified);
    assert.isFalse(ide.modified);

    await setEditorValue(editor, 'New content');
    assert.isTrue(ide.modified);
    assert.isTrue(ide.modified);

    await setEditorValue(editor, 'Old content');
    assert.isFalse(ide.modified);
    assert.isFalse(ide.modified);

    project.addFile('potato.html');
    assert.isTrue(ide.modified);
    assert.isTrue(ide.modified);

    ide.config = {
      files: {
        'index.html': {
          content: 'Different content',
        },
      },
    };
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.isFalse(ide.modified);
    assert.isFalse(ide.modified);
  });

  test('reorder files', async () => {
    const ide = document.createElement('playground-ide');
    ide.sandboxBaseUrl = '/';
    ide.config = {
      files: {
        'index.html': {
          content: 'Hello',
        },
        'package.json': {
          content: '{"dependencies":{}}',
        },
        'foo.html': {
          content: 'foo content',
        },
        'bar.html': {
          content: 'bar content',
        },
      },
    };
    container.appendChild(ide);

    const project = (await pierce(
      'playground-ide',
      'playground-project',
    )) as PlaygroundProject;
    // Need to defer another microtask for the config to initialize.
    await new Promise((resolve) => requestAnimationFrame(resolve));

    assert.isNotNull(project);
    const files = project.files;
    assert.isNotNull(files);

    // Moving file forward.
    project.moveFileAfter(1, 2);
    assert.equal(files?.[0].name, 'index.html');
    assert.equal(files?.[1].name, 'foo.html');
    assert.equal(files?.[2].name, 'package.json');
    assert.equal(files?.[3].name, 'bar.html');

    // Moving file backward.
    project.moveFileAfter(3, 0);
    assert.equal(files?.[0].name, 'index.html');
    assert.equal(files?.[1].name, 'bar.html');
    assert.equal(files?.[2].name, 'foo.html');
    assert.equal(files?.[3].name, 'package.json');
  });

  test('reorder files resulting in no changes', async () => {
    const ide = document.createElement('playground-ide');
    ide.sandboxBaseUrl = '/';
    ide.config = {
      files: {
        'index.html': {
          content: 'Hello',
        },
        'package.json': {
          content: '{"dependencies":{}}',
        },
        'foo.html': {
          content: 'foo content',
        },
        'bar.html': {
          content: 'bar content',
        },
      },
    };
    container.appendChild(ide);

    const project = (await pierce(
      'playground-ide',
      'playground-project',
    )) as PlaygroundProject;
    // Need to defer another microtask for the config to initialize.
    await new Promise((resolve) => requestAnimationFrame(resolve));

    assert.isNotNull(project);

    const files = project.files;
    assert.isNotNull(files);

    // Moving file out of bounds.
    project.moveFileAfter(3, 4);
    assert.equal(files?.[0].name, 'index.html');
    assert.equal(files?.[1].name, 'package.json');
    assert.equal(files?.[2].name, 'foo.html');
    assert.equal(files?.[3].name, 'bar.html');

    // Moving file to same position.
    project.moveFileAfter(2, 2);
    assert.equal(files?.[0].name, 'index.html');
    assert.equal(files?.[1].name, 'package.json');
    assert.equal(files?.[2].name, 'foo.html');
    assert.equal(files?.[3].name, 'bar.html');

    // Moving file after immediate previous file.
    project.moveFileAfter(2, 1);
    assert.equal(files?.[0].name, 'index.html');
    assert.equal(files?.[1].name, 'package.json');
    assert.equal(files?.[2].name, 'foo.html');
    assert.equal(files?.[3].name, 'bar.html');

    // Moving out of bounds file to same position.
    project.moveFileAfter(4, 4);
    assert.equal(files?.[0].name, 'index.html');
    assert.equal(files?.[1].name, 'package.json');
    assert.equal(files?.[2].name, 'foo.html');
    assert.equal(files?.[3].name, 'bar.html');

    // Moving out of bounds file to out of bounds position.
    project.moveFileAfter(4, 5);
    assert.equal(files?.[0].name, 'index.html');
    assert.equal(files?.[1].name, 'package.json');
    assert.equal(files?.[2].name, 'foo.html');
    assert.equal(files?.[3].name, 'bar.html');

    // Moving out of bounds file to in bounds position.
    project.moveFileAfter(4, 1);
    assert.equal(files?.[0].name, 'index.html');
    assert.equal(files?.[1].name, 'package.json');
    assert.equal(files?.[2].name, 'foo.html');
    assert.equal(files?.[3].name, 'bar.html');
  });

  test('returns the correct cursor position and index', async () => {
    const ide = document.createElement('playground-ide');
    ide.sandboxBaseUrl = '/';
    ide.config = {
      files: {
        'index.js': {
          content: '',
        },
      },
    };
    container.appendChild(ide);

    const editor = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;

    const codeToAdd = `console.log("Foo");
    console.log("bar");`;

    await new Promise((resolve) => window.requestAnimationFrame(resolve));

    editor.focus();
    await sendKeys({
      type: codeToAdd,
    });

    assert.equal(editor.value, codeToAdd);
    assert.equal(editor.cursorIndex, codeToAdd.length);
    const cursorPosition = editor.cursorPosition;
    assert.equal(cursorPosition.line, 1);
    assert.equal(cursorPosition.ch, 23);
  });

  test('returns the token under cursor', async () => {
    const ide = document.createElement('playground-ide');
    ide.sandboxBaseUrl = '/';
    ide.config = {
      files: {
        'index.js': {
          content: 'console.log("Foo")',
        },
      },
    };
    container.appendChild(ide);

    const editor = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;

    await new Promise((resolve) => window.requestAnimationFrame(resolve));

    editor.focus();

    await sendKeys({
      press: 'ArrowRight',
    });

    const tokenUnderCursor = editor.tokenUnderCursor;

    assert.equal(tokenUnderCursor.start, 0);
    assert.equal(tokenUnderCursor.end, 7);
    assert.equal(tokenUnderCursor.string, 'console');
  });

  // TODO(aomarks) This test fails in Firefox.
  (navigator.userAgent.includes('Firefox') ? test.skip : test)(
    'reloading preview does not modify history',
    async () => {
      const historyLengthBefore = window.history.length;

      // NOTE: For some reason, the parent window's history only seems to be
      // affected when the iframe origin is different.
      const separateOrigin = (await executeServerCommand(
        'separate-origin',
      )) as string;

      render(
        html`
          <playground-ide sandbox-base-url="${separateOrigin}">
            <script type="sample/html" filename="index.html">
              <body>
                <p>Hello HTML 1</p>
              </body>
            </script>
          </playground-ide>
        `,
        container,
      );
      const iframe = (await pierce(
        'playground-ide',
        'playground-preview',
        'iframe',
      )) as HTMLIFrameElement;
      await waitForIframeLoad(iframe);

      const editor = (await pierce(
        'playground-ide',
        'playground-file-editor',
        'playground-code-editor',
      )) as PlaygroundCodeEditor;
      updateCurrentFile(editor, 'Hello HTML 2');

      const project = (await pierce(
        'playground-ide',
        'playground-project',
      )) as PlaygroundProject;
      project.save();
      await waitForIframeLoad(iframe);

      const historyLengthAfter = window.history.length;
      assert.equal(historyLengthAfter, historyLengthBefore);
    },
  );

  test('reloading preview does not create additional iframes', async () => {
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/html" filename="index.html">
            <body>
              <p>Hello HTML 1</p>
            </body>
          </script>
        </playground-ide>
      `,
      container,
    );

    const preview = (await pierce(
      'playground-ide',
      'playground-preview',
    )) as PlaygroundPreview;

    const iframe = preview.iframe!;

    await waitForIframeLoad(iframe);

    const editor = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;
    updateCurrentFile(editor, 'Hello HTML 2');

    const project = (await pierce(
      'playground-ide',
      'playground-project',
    )) as PlaygroundProject;

    await Promise.all([waitForIframeLoad(iframe), project.save()]);

    const newIframe = (await pierce(
      'playground-ide',
      'playground-preview',
      'iframe',
    )) as HTMLIFrameElement;

    assert.equal(newIframe, iframe);
  });

  test('delete file using menu', async () => {
    render(
      html`
        <playground-ide sandbox-base-url="/" editable-file-system>
          <script type="sample/html" filename="index.html">
            <body>
              <p>Hello HTML</p>
            </body>
          </script>
          <script type="sample/html" filename="foo.html">
            <body>
              <p>Foo HTML</p>
            </body>
          </script>
        </playground-ide>
      `,
      container,
    );
    await assertPreviewContains('Hello HTML');

    const project = (await pierce(
      'playground-ide',
      'playground-project',
    )) as PlaygroundProject;
    assert.lengthOf(project.files ?? [], 2);

    // Historically, clicking the tab bar icon button
    // the target changed from the element to its internal svg.
    const menuButtonSvg = await pierce(
      'playground-ide',
      'playground-tab-bar',
      '.menu-button > svg',
    );
    menuButtonSvg.dispatchEvent(new Event('click', { bubbles: true }));

    const deleteButton = await pierce(
      'playground-ide',
      'playground-tab-bar',
      'playground-file-system-controls',
      '#deleteButton',
    );
    deleteButton.click();

    assert.lengthOf(project.files ?? [], 1);
    assert.equal(project.files?.[0].name, 'index.html');
  });

  test('uses custom htmlFile property', async () => {
    const ide = document.createElement('playground-ide')!;
    ide.sandboxBaseUrl = '/';
    ide.htmlFile = 'src/index.html';
    container.appendChild(ide);
    ide.config = {
      files: {
        'src/index.html': {
          content: 'Hello HTML',
        },
        'other.html': {
          content: 'Other HTML',
        },
      },
    };
    await assertPreviewContains('Hello HTML');

    // test that the preview updates when the htmlFile property changes
    ide.htmlFile = 'other.html';
    await assertPreviewContains('Other HTML');
  });

  test('undo/redo changes to a file', async () => {
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/js" filename="hello.js">
            document.body.textContent = 'Hello JS';
          </script>
          <script type="sample/html" filename="index.html">
            <body>
              <script type="module" src="hello.js">&lt;/script>
            </body>
          </script>
        </playground-ide>
      `,
      container,
    );
    const codemirror = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;
    await assertPreviewContains('Hello JS');
    await setEditorValue(codemirror, "document.body.textContent = 'Hello 2'");
    await assertPreviewContains('Hello 2');
    undo(await waitForEditorView(codemirror));
    await assertPreviewContains('Hello JS');
    redo(await waitForEditorView(codemirror));
    await assertPreviewContains('Hello 2');
  });

  test('undo/redo should not cross project file boundaries', async () => {
    const JS_CONTENT = `document.body.textContent = 'Hello JS';`;
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/js" filename="hello.js">
            ${JS_CONTENT}
          </script>
          <script type="sample/html" filename="index.html">
            <body>
              <script type="module" src="hello.js">&lt;/script>
            </body>
          </script>
        </playground-ide>
      `,
      container,
    );
    const fileEditor = (await pierce(
      'playground-ide',
      'playground-file-editor',
    )) as PlaygroundFileEditor;

    const editor = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;

    await raf();
    assert.equal(fileEditor.filename, 'hello.js');
    assert.equal((await getEditorValue(editor)).trim(), JS_CONTENT);

    fileEditor.filename = 'index.html';
    await raf();
    undo(await waitForEditorView(editor));

    await raf();
    // Expect to still be on the html page.
    assert.notEqual((await getEditorValue(editor)).trim(), JS_CONTENT);
  });

  test('undo/redo history persists when files change', async () => {
    const JS_CONTENT = `document.body.textContent = 'Hello JS';`;
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/js" filename="hello.js">
            ${JS_CONTENT}
          </script>
          <script type="sample/html" filename="index.html">
            <body>
              <script type="module" src="hello.js">&lt;/script>
            </body>
          </script>
        </playground-ide>
      `,
      container,
    );
    const fileEditor = (await pierce(
      'playground-ide',
      'playground-file-editor',
    )) as PlaygroundFileEditor;

    const editor = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;

    await raf();
    assert.equal(fileEditor.filename, 'hello.js');
    assert.equal((await getEditorValue(editor)).trim(), JS_CONTENT);

    await setEditorValue(editor, "document.body.textContent = 'Hello 2'");

    fileEditor.filename = 'index.html';
    await raf();
    assert.include(
      (await getEditorValue(editor)).trim(),
      `<script type="module" src="hello.js">`,
    );
    await setEditorValue(
      editor,
      `<body>
    <script type="module" src="hello.js">&lt;/script>
    <p>Add this</p>
    </body>`,
    );
    await raf();

    fileEditor.filename = 'hello.js';
    await raf();
    assert.include(await getEditorValue(editor), `'Hello 2'`);

    for (let i = 0; i < 6; i++) {
      undo(await waitForEditorView(editor));
      await raf();
      assert.equal((await getEditorValue(editor)).trim(), JS_CONTENT);
    }
    redo(await waitForEditorView(editor));
    await raf();
    assert.include(await getEditorValue(editor), `'Hello 2'`);

    fileEditor.filename = 'index.html';
    await raf();

    const view = await waitForEditorView(editor);

    // index.html file still has history
    assert.isAtLeast(undoDepth(view.state), 1);
    assert.include(await getEditorValue(editor), `<p>Add this</p>`);

    undo(view);
    await raf();
    assert.isFalse((await getEditorValue(editor)).includes(`<p>Add this</p>`));
    assert.include(
      await getEditorValue(editor),
      `<script type="module" src="hello.js">`,
    );
  });

  test('rename file preserves history', async () => {
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/js" filename="hello.js">
            document.body.textContent = 'Hello JS';
          </script>
          <script type="sample/html" filename="index.html">
            <body>
              <script type="module" src="hello.js">&lt;/script>
            </body>
          </script>
        </playground-ide>
      `,
      container,
    );
    const project = (await pierce(
      'playground-ide',
      'playground-project',
    )) as PlaygroundProject;
    const codemirror = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;
    await raf();
    assert.include(await getEditorValue(codemirror), 'Hello JS');
    await setEditorValue(codemirror, "document.body.textContent = 'Hello 2'");
    project.renameFile('hello.js', 'potato.js');
    await raf();
    assert.include(await getEditorValue(codemirror), 'Hello 2');
    undo(await waitForEditorView(codemirror));
    await raf();
    assert.include(await getEditorValue(codemirror), 'Hello JS');
    redo(await waitForEditorView(codemirror));
    await raf();
    assert.include(await getEditorValue(codemirror), 'Hello 2');
  });

  test('code remains folded when switching files', async () => {
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/js" filename="hello.js">
            /* playground-fold */
              document.body.textContent = 'Hello JS';
            /* playground-fold-end */

            console.log('potato');
          </script>
          <script type="sample/html" filename="index.html">
            <body>
              <script type="module" src="hello.js">&lt;/script>
            </body>
          </script>
        </playground-ide>
      `,
      container,
    );
    const EXPECTED_FOLDED = "…console.log('potato');";
    const fileEditor = (await pierce(
      'playground-ide',
      'playground-file-editor',
    )) as PlaygroundFileEditor;
    const codemirror = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;
    await raf();
    assert.equal(
      innerTextWithoutSpaces(
        codemirror?.shadowRoot?.querySelector<HTMLElement>('.cm-content'),
      ),
      EXPECTED_FOLDED,
    );
    fileEditor.filename = 'index.html';
    await raf();
    assert.include(
      innerTextWithoutSpaces(
        codemirror?.shadowRoot?.querySelector<HTMLElement>('.cm-content'),
      ),
      `src="hello.js"></script>`,
    );
    fileEditor.filename = 'hello.js';
    await raf();
    assert.equal(
      innerTextWithoutSpaces(
        codemirror?.shadowRoot?.querySelector<HTMLElement>('.cm-content'),
      ),
      EXPECTED_FOLDED,
    );
  });

  test('code remains folded when switching files that both have folds', async () => {
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/js" filename="hello.js">
            /* playground-fold */
              document.body.textContent = 'Hello JS';
            /* playground-fold-end */

            console.log('potato');
          </script>
          <script type="sample/html" filename="index.html">
            <body>
              <!-- playground-fold -->
              <script type="module" src="hello.js">&lt;/script>
              <!-- playground-fold-end -->
            </body>
          </script>
        </playground-ide>
      `,
      container,
    );
    const EXPECTED_FOLDED = "…console.log('potato');";
    const fileEditor = (await pierce(
      'playground-ide',
      'playground-file-editor',
    )) as PlaygroundFileEditor;
    const codemirror = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;
    await raf();
    assert.equal(
      innerTextWithoutSpaces(
        codemirror?.shadowRoot?.querySelector<HTMLElement>('.cm-content'),
      ),
      EXPECTED_FOLDED,
    );
    fileEditor.filename = 'index.html';
    await raf();
    assert.equal(
      innerTextWithoutSpaces(
        codemirror?.shadowRoot?.querySelector<HTMLElement>('.cm-content'),
      ),
      '<body>…</body>',
    );
    fileEditor.filename = 'hello.js';
    await raf();
    assert.equal(
      innerTextWithoutSpaces(
        codemirror?.shadowRoot?.querySelector<HTMLElement>('.cm-content'),
      ),
      EXPECTED_FOLDED,
    );
  });

  test('code remains folded on value change and undo', async () => {
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/js" filename="hello.js">
            /* playground-fold */
              document.body.textContent = 'Hello JS';
            /* playground-fold-end */

            console.log('potato');
          </script>
          <script type="sample/html" filename="index.html">
            <body>
              <script type="module" src="hello.js">&lt;/script>
            </body>
          </script>
        </playground-ide>
      `,
      container,
    );
    const EXPECTED_FOLDED = "…console.log('potato');";
    const codemirror = (await pierce(
      'playground-ide',
      'playground-file-editor',
      'playground-code-editor',
    )) as PlaygroundCodeEditor;
    await raf();
    assert.equal(
      innerTextWithoutSpaces(
        codemirror?.shadowRoot?.querySelector<HTMLElement>('.cm-content'),
      ),
      EXPECTED_FOLDED,
    );
    codemirror.value = `/* playground-fold */
document.body.textContent = 'Hello JS';
/* playground-fold-end */

console.log('tomato');`;
    await raf();
    assert.equal(
      innerTextWithoutSpaces(
        codemirror?.shadowRoot?.querySelector<HTMLElement>('.cm-content'),
      ),
      "…console.log('tomato');",
    );

    undo(await waitForEditorView(codemirror));
    await raf();

    assert.equal(
      innerTextWithoutSpaces(
        codemirror?.shadowRoot?.querySelector<HTMLElement>('.cm-content'),
      ),
      EXPECTED_FOLDED,
    );
  });

  test('focuses file with selected flag, from config', async () => {
    const ide = document.createElement('playground-ide')!;
    ide.sandboxBaseUrl = '/';
    container.appendChild(ide);
    // Start with a.html selected
    ide.config = {
      files: {
        'index.html': {
          content: 'index',
        },
        'a.html': {
          content: 'A',
          selected: true,
        },
        'b.html': {
          content: 'B',
        },
      },
    };
    await assertTabSelected('a.html');
    // Change to b.html selected
    ide.config = {
      files: {
        'index.html': {
          content: 'index',
        },
        'a.html': {
          content: 'A',
        },
        'b.html': {
          content: 'B',
          selected: true,
        },
      },
    };
    await assertTabSelected('b.html');
    // Nothing selected; should stay on b.html
    ide.config = {
      files: {
        'index.html': {
          content: 'index',
        },
        'b.html': {
          content: 'B',
        },
        'a.html': {
          content: 'A',
        },
      },
    };
    await assertTabSelected('b.html');
  });

  test('focuses file with selected flag, from slots', async () => {
    // Start with a.html selected
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/html" filename="index.html">
            index
          </script>
          <script type="sample/html" filename="a.html" selected>
            A
          </script>
          <script type="sample/html" filename="b.html">
            B
          </script>
        </playground-ide>
      `,
      container,
    );
    const ide = container.firstElementChild as PlaygroundIde;
    await assertTabSelected('a.html');
    // Change to b.html selected
    ide.textContent = '';
    render(
      html`
        <script type="sample/html" filename="index.html">
          index
        </script>
        <script type="sample/html" filename="a.html">
          A
        </script>
        <script type="sample/html" filename="b.html" selected>
          B
        </script>
      `,
      ide,
    );
    await assertTabSelected('b.html');
    // Nothing selected; should stay on b.html
    render(
      html`
        <script type="sample/html" filename="index.html">
          index
        </script>
        <script type="sample/html" filename="a.html">
          A
        </script>
        <script type="sample/html" filename="b.html">
          B
        </script>
      `,
      ide,
    );
    await assertTabSelected('b.html');
  });
});
