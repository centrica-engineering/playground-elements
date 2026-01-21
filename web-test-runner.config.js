/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import { playwrightLauncher } from '@web/test-runner-playwright';
import { puppeteerLauncher } from '@web/test-runner-puppeteer';
import { fakeCdnPlugin } from './test/fake-cdn-plugin.js';
import { startDevServer } from '@web/dev-server';

// For some tests we want a separate origin to use as the sandbox-base-url.
const separateOriginServer = await startDevServer({
  config: {
    rootDir: './',
    nodeResolve: true,
  },
});

// This plugin lets our tests discover the origin (this way we don't have to
// hard-code a port and assume it is available).
const separateOriginPlugin = () => ({
  name: 'separate-origin-plugin',
  executeCommand({ command }) {
    if (command === 'separate-origin') {
      const { hostname, port } = separateOriginServer.config;
      return `http://${hostname}:${port}/`;
    }
  },
});

// https://modern-web.dev/docs/test-runner/cli-and-configuration/
export default {
  rootDir: './',
  // Note this file list can be overridden by wtr command-line arguments.
  files: ['test/**/*_test.js'],
  nodeResolve: true,
  // Enable browser console log capture when debugging.
  // Usage: WTR_BROWSER_LOGS=1 WTR_BROWSERS=chromium npm run test:wtr -- --files test/playground-code-editor_test.js
  browserLogs: !!process.env.WTR_BROWSER_LOGS,
  browsers: (() => {
    // Useful for local iteration:
    //   WTR_BROWSERS=chromium npm run test:wtr -- --files test/playground-code-editor_test.js
    // Supports: chromium, webkit, firefox.
    //
    // Note: Puppeteer Firefox is experimental and has been flaky in CI/local
    // environments. For stability, this config does NOT run Firefox by
    // default. To include Firefox, explicitly request it:
    //   WTR_BROWSERS=firefox npm run test:wtr
    const requested = (process.env.WTR_BROWSERS ?? 'all')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    /** @type {import('@web/test-runner-core').BrowserLauncher[]} */
    const base = [
      playwrightLauncher({ product: 'chromium' }),
      playwrightLauncher({ product: 'webkit' }),
    ];

    const firefox = puppeteerLauncher({
      launchOptions: { product: 'firefox' },
    });

    const all = requested.some((r) => r.toLowerCase().includes('firefox'))
      ? [...base, firefox]
      : base;

    if (requested.length === 0 || requested.includes('all')) {
      return all;
    }

    return all.filter((launcher) => {
      const name = (launcher.name ?? '').toLowerCase();
      return requested.some((r) => name.includes(r.toLowerCase()));
    });
  })(),
  browserStartTimeout: 30000, // default 30000
  testsStartTimeout: 20000, // default 10000
  testsFinishTimeout: 90000, // default 20000
  testFramework: {
    // https://mochajs.org/api/mocha
    config: {
      ui: 'tdd',
      timeout: '30000', // default 2000
    },
  },
  plugins: [fakeCdnPlugin(), separateOriginPlugin()],
  filterBrowserLogs: ({ args }) =>
    // This warning will always happen because we use the same local server for
    // the elements and the service worker, and that's fine.
    !args.join('').includes('executing with the same origin as its parent'),
};
