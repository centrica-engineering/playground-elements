/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as fs from 'fs/promises';

const inputPath = new URL('../playground-styles.css', import.meta.url);
const outputPath = new URL('../src/playground-styles.ts', import.meta.url);

const escapeForTemplateLiteral = (text) =>
  text.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const main = async () => {
  const css = await fs.readFile(inputPath, 'utf8');

  const out = `/**\n * Generated from playground-styles.css\n */\n\nimport {css} from 'lit';\n\nconst style = css\`\n${escapeForTemplateLiteral(css)}\n\`;\n\nexport default style;\n`;

  await fs.writeFile(outputPath, out, 'utf8');
};

await main();
