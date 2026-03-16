import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, "..");

function logStep(label) {
  console.log(`\n== ${label}`);
}

function fail(message) {
  console.error(`\nRelease gate failed: ${message}`);
  process.exit(1);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isSemverLike(version) {
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    version,
  );
}

function normalizePackPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function readJson(filePath, label) {
  let raw;

  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`Unable to read ${label} at ${filePath}: ${error.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Unable to parse ${label} at ${filePath}: ${error.message}`);
  }
}

function findPackageManager(startDir) {
  let currentDir = startDir;

  while (true) {
    if (existsSync(join(currentDir, "pnpm-lock.yaml"))) {
      return "pnpm";
    }

    if (existsSync(join(currentDir, "yarn.lock"))) {
      return "yarn";
    }

    if (
      existsSync(join(currentDir, "bun.lockb")) ||
      existsSync(join(currentDir, "bun.lock"))
    ) {
      return "bun";
    }

    if (
      existsSync(join(currentDir, "package-lock.json")) ||
      existsSync(join(currentDir, "npm-shrinkwrap.json"))
    ) {
      return "npm";
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  return "npm";
}

function packageManagerArgs(packageManager, scriptName) {
  if (packageManager === "yarn") {
    return ["run", scriptName];
  }

  return ["run", scriptName];
}

function run(command, args, cwd = pluginRoot) {
  console.log(`$ ${command} ${args.join(" ")}`);

  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    fail(`Unable to start "${command}": ${result.error.message}`);
  }

  if (result.status !== 0) {
    fail(`Command exited with status ${result.status}: ${command} ${args.join(" ")}`);
  }
}

function runCapture(command, args, cwd = pluginRoot) {
  console.log(`$ ${command} ${args.join(" ")}`);

  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.error) {
    fail(`Unable to start "${command}": ${result.error.message}`);
  }

  if (result.status !== 0) {
    const details = result.stderr || result.stdout || "no output";
    fail(`Command exited with status ${result.status}: ${details.trim()}`);
  }

  return result.stdout;
}

function findManifest(packageJson) {
  const extensionEntries = packageJson.openclaw?.extensions;

  if (Array.isArray(extensionEntries)) {
    for (const extensionEntry of extensionEntries) {
      if (!isObject(extensionEntry) || !isNonEmptyString(extensionEntry.manifest)) {
        continue;
      }

      const manifestPath = resolve(pluginRoot, extensionEntry.manifest);
      if (existsSync(manifestPath)) {
        return { extensionEntry, manifestPath };
      }
    }

    const firstConfiguredEntry = extensionEntries.find(
      (entry) => isObject(entry) && isNonEmptyString(entry.manifest),
    );

    if (firstConfiguredEntry) {
      return {
        extensionEntry: firstConfiguredEntry,
        manifestPath: resolve(pluginRoot, firstConfiguredEntry.manifest),
      };
    }
  }

  const fallbackPath = resolve(pluginRoot, "openclaw.plugin.json");
  if (existsSync(fallbackPath)) {
    return {
      extensionEntry: null,
      manifestPath: fallbackPath,
    };
  }

  fail(
    'Unable to find an OpenClaw manifest. Expected "openclaw.plugin.json" in the plugin root and "package.json > openclaw.extensions" entry files.',
  );
}

function findSingleFile(rootDir, matcher) {
  return readdirSync(rootDir).find((name) => matcher.test(name));
}

function isPackFileReference(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }

  return !(
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("node:") ||
    value.startsWith("npm:") ||
    value.startsWith("#")
  );
}

function collectExportPaths(value, filePaths) {
  if (typeof value === "string") {
    if (isPackFileReference(value)) {
      filePaths.add(normalizePackPath(value));
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectExportPaths(entry, filePaths);
    }
    return;
  }

  if (isObject(value)) {
    for (const nestedValue of Object.values(value)) {
      collectExportPaths(nestedValue, filePaths);
    }
  }
}

function collectExpectedPackageFiles(packageJson, manifestPath, manifest) {
  const expectedFiles = new Set([
    "package.json",
    normalizePackPath(relative(pluginRoot, manifestPath)),
  ]);

  const readmeFile = findSingleFile(pluginRoot, /^readme(?:\..+)?$/i);
  if (readmeFile) {
    expectedFiles.add(normalizePackPath(readmeFile));
  }

  const licenseFile = findSingleFile(pluginRoot, /^(license|licence)(?:\..+)?$/i);
  if (licenseFile) {
    expectedFiles.add(normalizePackPath(licenseFile));
  }

  const directEntries = [
    packageJson.main,
    packageJson.module,
    packageJson.types,
    packageJson.typings,
    manifest.entry,
  ];

  for (const entry of directEntries) {
    if (isPackFileReference(entry)) {
      expectedFiles.add(normalizePackPath(entry));
    }
  }

  if (typeof packageJson.bin === "string" && isPackFileReference(packageJson.bin)) {
    expectedFiles.add(normalizePackPath(packageJson.bin));
  }

  if (isObject(packageJson.bin)) {
    for (const entry of Object.values(packageJson.bin)) {
      if (isPackFileReference(entry)) {
        expectedFiles.add(normalizePackPath(entry));
      }
    }
  }

  collectExportPaths(packageJson.exports, expectedFiles);

  return expectedFiles;
}

function parsePackOutput(rawOutput) {
  try {
    const jsonStart = rawOutput.indexOf("[");
    if (jsonStart < 0) {
      fail("npm pack --json did not return JSON output.");
    }

    const parsed = JSON.parse(rawOutput.slice(jsonStart));
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (error) {
    fail(`Unable to parse npm pack output: ${error.message}`);
  }
}

function validateManifest(packageJson, extensionEntry, manifestPath, manifest) {
  if (!isObject(manifest)) {
    fail("OpenClaw manifest must be a JSON object.");
  }

  if (!isNonEmptyString(packageJson.name)) {
    fail("package.json is missing a non-empty \"name\".");
  }

  if (!isNonEmptyString(packageJson.version)) {
    fail("package.json is missing a non-empty \"version\".");
  }

  if (!isSemverLike(packageJson.version)) {
    fail(`package.json version "${packageJson.version}" is not semver-like.`);
  }

  if (!Array.isArray(packageJson.openclaw?.extensions) || packageJson.openclaw.extensions.length === 0) {
    fail('package.json is missing "openclaw.extensions", which is required for plugin release.');
  }

  if (!isNonEmptyString(manifest.name)) {
    fail(`Manifest ${relative(pluginRoot, manifestPath)} is missing a non-empty "name".`);
  }

  if (!isNonEmptyString(manifest.description)) {
    fail(
      `Manifest ${relative(pluginRoot, manifestPath)} is missing a non-empty "description".`,
    );
  }

  if (!isNonEmptyString(manifest.version)) {
    fail(
      `Manifest ${relative(pluginRoot, manifestPath)} is missing a non-empty "version".`,
    );
  }

  if (!isSemverLike(manifest.version)) {
    fail(
      `Manifest ${relative(pluginRoot, manifestPath)} version "${manifest.version}" is not semver-like.`,
    );
  }

  if (manifest.version !== packageJson.version) {
    fail(
      `Version drift detected: package.json is ${packageJson.version} but ${relative(
        pluginRoot,
        manifestPath,
      )} is ${manifest.version}.`,
    );
  }

  const configuredManifestPath = normalizePackPath(
    isNonEmptyString(extensionEntry?.manifest)
      ? extensionEntry.manifest
      : packageJson.pluginManifest,
  );
  const actualManifestPath = normalizePackPath(relative(pluginRoot, manifestPath));

  if (configuredManifestPath !== actualManifestPath) {
    fail(
      `package.json points to ${configuredManifestPath} but the resolved manifest is ${actualManifestPath}.`,
    );
  }

  if (extensionEntry && !isNonEmptyString(extensionEntry.id)) {
    fail("package.json openclaw.extensions entry is missing a non-empty \"id\".");
  }

  if (
    extensionEntry &&
    isNonEmptyString(manifest.id) &&
    manifest.id !== extensionEntry.id
  ) {
    fail(
      `Manifest id "${manifest.id}" does not match package.json openclaw.extensions id "${extensionEntry.id}".`,
    );
  }

  if ("configSchema" in manifest && !isObject(manifest.configSchema)) {
    fail(`Manifest ${relative(pluginRoot, manifestPath)} has an invalid "configSchema".`);
  }

  if ("entry" in manifest && !isNonEmptyString(manifest.entry)) {
    fail(`Manifest ${relative(pluginRoot, manifestPath)} has an invalid "entry".`);
  }
}

function validateScripts(packageJson) {
  const scripts = packageJson.scripts;

  if (!isObject(scripts)) {
    fail("package.json is missing a scripts block.");
  }

  if (!isNonEmptyString(scripts.build)) {
    fail("package.json is missing a build script required for release checks.");
  }

  if (!isNonEmptyString(scripts.test)) {
    fail("package.json is missing a test script required for release checks.");
  }
}

function validatePublishPrerequisites(packageJson) {
  if (packageJson.private === true) {
    fail("package.json has private=true, so the package cannot be published.");
  }

  if (!isNonEmptyString(packageJson.description)) {
    fail("package.json is missing a non-empty \"description\".");
  }

  if (!isNonEmptyString(packageJson.license)) {
    fail("package.json is missing a non-empty \"license\".");
  }

  if (!packageJson.repository) {
    fail("package.json is missing a repository field.");
  }

  const readmeFile = findSingleFile(pluginRoot, /^readme(?:\..+)?$/i);
  if (!readmeFile) {
    fail("A README file is required before publish.");
  }

  if (packageJson.name.startsWith("@")) {
    const access = packageJson.publishConfig?.access;
    if (access !== "public") {
      fail(
        'Scoped packages must set "publishConfig.access" to "public" before release.',
      );
    }
  }
}

function main() {
  const packageJsonPath = resolve(pluginRoot, "package.json");
  const packageJson = readJson(packageJsonPath, "package.json");
  const { extensionEntry, manifestPath } = findManifest(packageJson);
  const manifest = readJson(manifestPath, "OpenClaw manifest");
  const packageManager = findPackageManager(pluginRoot);

  logStep("Manifest linkage and version sync");
  validateManifest(packageJson, extensionEntry, manifestPath, manifest);

  logStep("Build and test scripts");
  validateScripts(packageJson);
  run(packageManager, packageManagerArgs(packageManager, "build"));
  run(packageManager, packageManagerArgs(packageManager, "test"));

  logStep("Packaged contents");
  const packOutput = parsePackOutput(runCapture("npm", ["pack", "--json", "--dry-run"]));
  if (!packOutput || !Array.isArray(packOutput.files)) {
    fail("npm pack --dry-run did not return packaged file metadata.");
  }

  const packagedFiles = new Set(
    packOutput.files.map((entry) => normalizePackPath(entry.path)),
  );
  const expectedFiles = collectExpectedPackageFiles(
    packageJson,
    manifestPath,
    manifest,
  );
  const missingFiles = [...expectedFiles].filter((filePath) => !packagedFiles.has(filePath));

  if (missingFiles.length > 0) {
    fail(`Packaged tarball is missing: ${missingFiles.join(", ")}`);
  }

  console.log(
    `Validated ${packOutput.files.length} packaged files in ${packOutput.filename}.`,
  );

  logStep("Publish prerequisites");
  validatePublishPrerequisites(packageJson);
  run("npm", ["publish", "--dry-run"]);

  console.log("\nRelease gate passed.");
}

main();
