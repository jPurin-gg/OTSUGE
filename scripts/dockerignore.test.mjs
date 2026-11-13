import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);

// Simulate the current root-level Dockerignore rules, including ordered negation.
// Fail on unsupported syntax so future rules cannot silently weaken this check.
function isExcluded(filename, rules) {
  let excluded = false;
  for (const rule of rules) {
    const negated = rule.startsWith("!");
    const pattern = negated ? rule.slice(1) : rule;
    assert.match(pattern, /^[\w.*-]+$/u, `Unsupported rule: ${rule}`);
    if (matchesGlob(filename, pattern)) excluded = !negated;
  }
  return excluded;
}

for (const app of ["backend", "frontend"]) {
  test(`${app}: README env names are excluded and examples/source remain`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `otsuge-${app}-dockerignore-`));
    try {
      const readme = await readFile(new URL("README.md", root), "utf8");
      const rules = (await readFile(new URL(`${app}/.dockerignore`, root), "utf8"))
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      const envNames = [`${app}.env`, `${app}.prod.env`];
      const examples = envNames.map((name) => `${name}.example`);
      for (const name of [...envNames, ...examples]) {
        assert.ok(readme.includes(`${app}/${name}`), `README must name ${app}/${name}`);
      }
      const excluded = [...envNames, ".env", ".prod.env", "node_modules", ".next"];
      const included = [...examples, "package.json", "Dockerfile", "page.tsx"];
      // Only generated fixtures are read/listed; real env files are never accessed.
      for (const name of [...excluded, ...included]) {
        await writeFile(join(directory, name), "PLACEHOLDER=example\n");
      }
      const context = (await readdir(directory)).filter((name) => !isExcluded(name, rules));
      assert.deepEqual(context.sort(), included.sort());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
