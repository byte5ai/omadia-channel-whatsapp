#!/usr/bin/env node
/**
 * test.mjs — run the TypeScript test suite with zero extra dependencies.
 *
 * Node's built-in runner (`node:test`) + assert drive the tests; esbuild (an
 * existing dev dependency) bundles each `tests/*.test.ts` into `.test-build/`
 * first. The `@omadia/*` packages are provided by the omadia host at runtime
 * and are not installed here, so the tests resolve them from a local omadia
 * checkout whose packages are built (`dist/`). Point at it with
 *
 *   OMADIA_CHANNEL_SDK_DIST   (default ../middleware/packages/harness-channel-sdk/dist/index.js)
 *   OMADIA_PLUGIN_API_DIST    (default ../middleware/packages/plugin-api/dist/index.js)
 *
 * Baileys stays external (installed from npm).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const testsDir = join(pkgRoot, 'tests');
const outDir = join(pkgRoot, '.test-build');

const sdkDist = resolve(
  pkgRoot,
  process.env.OMADIA_CHANNEL_SDK_DIST ?? '../middleware/packages/harness-channel-sdk/dist/index.js',
);
const pluginApiDist = resolve(
  pkgRoot,
  process.env.OMADIA_PLUGIN_API_DIST ?? '../middleware/packages/plugin-api/dist/index.js',
);

for (const [name, file] of [
  ['OMADIA_CHANNEL_SDK_DIST', sdkDist],
  ['OMADIA_PLUGIN_API_DIST', pluginApiDist],
]) {
  if (!existsSync(file)) {
    console.error(`${file} is missing — build the omadia packages and/or set ${name}`);
    process.exit(1);
  }
}

const entryPoints = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(testsDir, f));
if (entryPoints.length === 0) {
  console.error('no tests found in tests/');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
console.log(`▶ transpiling ${entryPoints.length} test file(s)`);
await build({
  entryPoints,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outExtension: { '.js': '.mjs' },
  alias: {
    '@omadia/channel-sdk': sdkDist,
    '@omadia/plugin-api': pluginApiDist,
  },
  external: ['@whiskeysockets/baileys', '@hapi/boom', 'qrcode', 'express'],
  logLevel: 'warning',
});

const files = readdirSync(outDir).filter((f) => f.endsWith('.test.mjs')).map((f) => join(outDir, f));
const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit', cwd: pkgRoot });
rmSync(outDir, { recursive: true, force: true });
process.exit(run.status ?? 1);
