/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import '../playground-ide.js';
import '../playground-code-editor.js';

import {assert} from '@esm-bundle/chai';
import {sendKeys} from '@web/test-runner-commands';
import {html, ReactiveElement, render} from 'lit';

import {PlaygroundCodeEditor} from '../playground-code-editor.js';
import {PlaygroundProject} from '../playground-project.js';

suite('completions', () => {
  let container: HTMLDivElement;
  let project: PlaygroundProject | undefined | null;
  let editor: PlaygroundCodeEditor | undefined | null;
  let testRunning: boolean;

  setup(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    testRunning = true;
    render(
      html`
        <playground-ide sandbox-base-url="/">
          <script type="sample/ts" filename="hello.ts"></script>
          <script type="sample/html" filename="index.html">
            <body>
              <script type="module" src="hello.js">&lt;/script>
            </body>
          </script>
        </playground-ide>
      `,
      container,
    );
    await assertPreviewContains('');

    project = document
      .querySelector('playground-ide')
      ?.shadowRoot?.querySelector('playground-project');

    editor = document
      .querySelector('playground-ide')
      ?.shadowRoot?.querySelector('playground-file-editor')
      ?.shadowRoot?.querySelector('playground-code-editor');
  });

  teardown(() => {
    container.remove();
    testRunning = false;
  });

  const emulateUser = async (word: string) => {
    const chars = word.split('');
    while (chars.length > 0) {
      const c = chars.shift();
      if (c) {
        await raf();
        await raf();
        await sendKeys({
          type: c,
        });
      }
    }
  };

  const waitForIframeLoad = (iframe: HTMLElement) =>
    new Promise<void>((resolve) => {
      iframe.addEventListener('load', () => resolve(), {once: true});
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

  const waitForElement = (
    parent: ParentNode | null | undefined,
    elementName: string,
  ) => {
    return new Promise((resolve, reject) => {
      (function tryToFindElem(attempt) {
        if (parent?.querySelector(elementName)) {
          return resolve('');
        }
        if (attempt > 50) {
          return reject();
        }
        setTimeout(() => tryToFindElem(attempt + 1), 100);
      })(1);
    });
  };

  const waitForCompletionsToAppear = () =>
    new Promise((resolve, reject) => {
      // Make sure we can grab the focuscontainer for observing
      if (!editor || !editor.shadowRoot) return reject();
      const focusContainer = editor.shadowRoot.querySelector('#focusContainer');
      if (!focusContainer) return reject();

      const config = {childList: true};
      // To avoid computer/dom specific timing errors in tests, we rely on
      // mutations
      const observer = new MutationObserver(async (mutationsList, obs) => {
        if (addedNodesContainsCompletionsMenu(mutationsList)) {
          obs.disconnect();
          resolve('');
        }
      });

      if (focusContainer) {
        observer.observe(focusContainer, config);
      }

      setTimeout(() => {
        observer.disconnect();
        resolve('');
      }, 10000);
    });
  const addedNodesContainsCompletionsMenu = (mutationsList: MutationRecord[]) =>
    mutationsList.some((mut) =>
      Array.from(mut.addedNodes).some(
        (node) =>
          node instanceof Element &&
          ((node as Element).matches('.cm-tooltip-autocomplete') ||
            (node as Element).querySelector('.cm-tooltip-autocomplete') !==
              null),
      ),
    );

  const openCompletions = async () => {
    // Make completions deterministic across browsers by explicitly opening the
    // tooltip (instead of depending on "activate on typing" timing).
    await sendKeys({press: 'Control+Space'});
    await raf();
  };
  const raf = async () => new Promise((r) => requestAnimationFrame(r));
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
  const waitForCompileDone = () =>
    new Promise((resolve) => {
      project?.addEventListener(
        'compileDone',
        async () => {
          resolve('');
        },
        {once: true},
      );
    });

  test('displays completion items on input', async () => {
    await waitForCompileDone();
    editor?.focus();
    await emulateUser('document.query');
    await openCompletions();
    await waitForCompletionsToAppear();
    await waitForElement(editor?.shadowRoot, '.cm-tooltip-autocomplete ul');

    const completionList = editor?.shadowRoot?.querySelector(
      '.cm-tooltip-autocomplete ul',
    );
    assert.isNotNull(completionList);

    const items = completionList!.querySelectorAll('li');
    assert.isAtLeast(items.length, 1, 'Completion list should not be empty');
    assert.isTrue(
      Array.from(items).some((li) => li.textContent?.includes('querySelector')),
      'Expected querySelector completion',
    );
  });

  test('can navigate the completion item list', async () => {
    await waitForCompileDone();
    editor?.focus();
    await emulateUser('document.que');
    await openCompletions();
    await waitForCompletionsToAppear();

    await sendKeys({
      press: 'ArrowDown',
    });
    await raf();
    await waitForElement(editor?.shadowRoot, 'li[aria-selected="true"]');

    const completionList = editor?.shadowRoot?.querySelector(
      '.cm-tooltip-autocomplete ul',
    );
    assert.isNotNull(completionList);
    const items = Array.from(completionList!.querySelectorAll('li'));
    const selectedIndex = items.findIndex(
      (li) => li.getAttribute('aria-selected') === 'true',
    );
    assert.equal(selectedIndex, 1, 'Second completion should be selected');
  });

  test('enter key confirms completion item selection', async () => {
    await waitForCompileDone();
    editor?.focus();
    await emulateUser('document.queryS');
    await openCompletions();
    await waitForCompletionsToAppear();

    const editorChange = new Promise((resolve) => {
      editor?.addEventListener('change', () => {
        resolve('');
      });
      setTimeout(() => {
        resolve('');
      }, 10000);
    });
    sendKeys({
      press: 'Enter',
    });

    await editorChange;

    assert.equal(
      editor?.value,
      'document.querySelector',
      'Completion should be visible in the code editor',
    );

    const completionItemList = editor?.shadowRoot?.querySelector(
      '.cm-tooltip-autocomplete',
    );
    assert.isNull(
      completionItemList,
      'Completion item list should disappear on completion confirmation',
    );
  });

  test('completions should contain local scoped items', async () => {
    await waitForCompileDone();
    editor?.focus();
    await emulateUser(`function reallySpecificFunctionName() {
            console.log("foo");
        }`);
    await sendKeys({press: 'Enter'});
    await emulateUser('reallySpecifi');

    await openCompletions();
    await waitForCompletionsToAppear();

    const completionList = editor?.shadowRoot?.querySelector(
      '.cm-tooltip-autocomplete ul',
    );
    assert.isNotNull(completionList);

    const items = Array.from(
      completionList!.querySelectorAll<HTMLElement>('.hint-object-name'),
    ).map((el) => el.innerText);
    assert.include(
      items,
      'reallySpecificFunctionName',
      'Completion list should include the created function',
    );
  });
});
