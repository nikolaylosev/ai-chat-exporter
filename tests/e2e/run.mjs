// Runs the stands: `npm run e2e` for all, `npm run e2e -- gemini` for those whose
// name contains "gemini". Builds the extension into a temporary folder first.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExtension } from './harness.mjs';

const root = join(import.meta.dirname, '..', '..');
const filters = process.argv.slice(2);
const dir = join(import.meta.dirname, 'scenarios');
const scenarios = [];
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith('.mjs'))
  .sort()) {
  const { default: scenario } = await import(join(dir, file));
  if (!filters.length || filters.some((f) => scenario.name.includes(f))) scenarios.push(scenario);
}
if (!scenarios.length) {
  console.error(`No scenario matches ${filters.join(', ')}`);
  process.exit(1);
}

const build = mkdtempSync(join(tmpdir(), 'ai-chat-exporter-ext-'));
console.log('Building the extension…');
buildExtension(root, build);
let failed = 0;
for (const scenario of scenarios) {
  const start = Date.now();
  try {
    await scenario.run(build);
    console.log(`PASS ${scenario.name} (${Math.round((Date.now() - start) / 1000)} s)`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${scenario.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
rmSync(build, { recursive: true, force: true });
console.log(`${scenarios.length - failed} of ${scenarios.length} passed`);
process.exit(failed ? 1 : 0);
