import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = findPolicyCoreSource(pluginRoot);
const targetRoot = join(pluginRoot, "node_modules", "@mahilo", "policy-core");

ensurePolicyCoreDist(sourceRoot);
syncPolicyCorePackage(sourceRoot, targetRoot);

function findPolicyCoreSource(startDir: string): string {
  let current = startDir;

  while (true) {
    const candidate = join(current, "packages", "policy-core");
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error(
    "Unable to locate packages/policy-core from this plugin checkout",
  );
}

function ensurePolicyCoreDist(sourceDir: string): void {
  if (!existsSync(join(sourceDir, "dist", "index.d.ts"))) {
    throw new Error(
      "packages/policy-core is missing dist output. Build @mahilo/policy-core before packaging.",
    );
  }
}

function syncPolicyCorePackage(sourceDir: string, targetDir: string): void {
  rmSync(targetDir, { force: true, recursive: true });
  mkdirSync(dirname(targetDir), { recursive: true });

  cpSync(join(sourceDir, "dist"), join(targetDir, "dist"), { recursive: true });
  cpSync(join(sourceDir, "src"), join(targetDir, "src"), { recursive: true });
  cpSync(join(sourceDir, "package.json"), join(targetDir, "package.json"));

  const packageJsonPath = join(targetDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<
    string,
    unknown
  >;
  delete packageJson.scripts;
  delete packageJson.devDependencies;

  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}
