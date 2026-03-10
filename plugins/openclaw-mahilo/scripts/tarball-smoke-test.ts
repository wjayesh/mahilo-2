import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface JsonRecord {
  [key: string]: unknown;
}

interface NpmPackFile {
  path?: string;
}

interface NpmPackResult {
  filename?: string;
  files?: NpmPackFile[];
}

interface RecordedHook {
  execute: unknown;
  name: string;
}

interface RecordedHttpRoute {
  path?: string;
}

interface ScratchConfig {
  openclaw: {
    extensions: string[];
  };
  plugins: {
    entries: {
      mahilo: {
        config: Record<string, unknown>;
        enabled: boolean;
      };
    };
  };
}

export interface TarballSmokeSummary {
  commandNames: string[];
  dryRunFiles: string[];
  extensionName: string;
  hookNames: string[];
  manifestEntry: string;
  packageExtensionEntry: string;
  requiredConfigKeys: string[];
  routePaths: string[];
  tarballFileName: string;
  toolNames: string[];
}

const EXPECTED_COMMAND_NAMES = [
  "mahilo reconnect",
  "mahilo review",
  "mahilo setup",
  "mahilo status"
];

const EXPECTED_HOOK_NAMES = [
  "after_tool_call",
  "agent_end",
  "before_prompt_build"
];

const EXPECTED_REQUIRED_CONFIG_KEYS = ["baseUrl", "apiKey"];

const EXPECTED_ROUTE_PATHS = ["/mahilo/incoming"];

const EXPECTED_TOOL_NAMES = [
  "mahilo_boundaries",
  "mahilo_message",
  "mahilo_network"
];

const FORBIDDEN_PACK_PATH_PREFIXES = [
  "dist-probe/",
  "scripts/",
  "src/",
  "tests/",
  "types/"
];

function normalizePackPath(filePath: string): string {
  return filePath.replace(/^\.\//, "");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function readJsonFile(filePath: string): JsonRecord {
  const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;

  if (!isRecord(value)) {
    throw new Error(`expected ${filePath} to contain a JSON object`);
  }

  return value;
}

function parsePackResults(stdout: string, commandLabel: string): NpmPackResult[] {
  const jsonStart = stdout.indexOf("[");

  if (jsonStart < 0) {
    throw new Error(`${commandLabel} did not return JSON output`);
  }

  return JSON.parse(stdout.slice(jsonStart)) as NpmPackResult[];
}

function runCommand(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`,
        result.stdout.trim(),
        result.stderr.trim()
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return result.stdout;
}

function assertStringArrayEquals(
  actualValues: string[],
  expectedValues: string[],
  label: string
): void {
  const actual = [...actualValues].sort();
  const expected = [...expectedValues].sort();

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} mismatch.\nexpected: ${expected.join(", ")}\nreceived: ${actual.join(", ")}`
    );
  }
}

function assertPackContents(packageDir: string, dryRunFiles: string[]): void {
  const packageJson = readJsonFile(join(packageDir, "package.json"));
  const manifest = readJsonFile(join(packageDir, "openclaw.plugin.json"));
  const exports = packageJson.exports;
  const rootExport = isRecord(exports) ? exports["."] : undefined;
  const requiredPaths = new Set<string>();

  if (typeof packageJson.main === "string") {
    requiredPaths.add(normalizePackPath(packageJson.main));
  }

  if (typeof packageJson.types === "string") {
    requiredPaths.add(normalizePackPath(packageJson.types));
  }

  if (typeof packageJson.pluginManifest === "string") {
    requiredPaths.add(normalizePackPath(packageJson.pluginManifest));
  }

  if (isRecord(rootExport) && typeof rootExport.import === "string") {
    requiredPaths.add(normalizePackPath(rootExport.import));
  }

  if (isRecord(rootExport) && typeof rootExport.types === "string") {
    requiredPaths.add(normalizePackPath(rootExport.types));
  }

  if (typeof manifest.entry === "string") {
    requiredPaths.add(normalizePackPath(manifest.entry));
  }

  requiredPaths.add("LICENSE");
  requiredPaths.add("README.md");
  requiredPaths.add("RELEASING.md");
  requiredPaths.add("PUBLISH-CHECKLIST.md");
  requiredPaths.add("docs/ask-your-contacts.md");
  requiredPaths.add("docs/boundaries-and-trust.md");
  requiredPaths.add("docs/build-your-circle.md");
  requiredPaths.add("docs/listing-copy.md");
  requiredPaths.add("dist/index.d.ts");
  requiredPaths.add("dist/openclaw-plugin-sdk-core.d.ts");
  requiredPaths.add("index.d.ts");
  requiredPaths.add("openclaw.plugin.json");
  requiredPaths.add("package.json");

  const dryRunFileSet = new Set(dryRunFiles);

  for (const requiredPath of requiredPaths) {
    if (!dryRunFileSet.has(requiredPath)) {
      throw new Error(`npm pack --dry-run is missing required packaged file ${requiredPath}`);
    }
  }

  for (const filePath of dryRunFiles) {
    for (const prefix of FORBIDDEN_PACK_PATH_PREFIXES) {
      if (filePath.startsWith(prefix)) {
        throw new Error(`npm pack --dry-run unexpectedly included ${filePath}`);
      }
    }
  }
}

function createScratchConfig(scratchDir: string): ScratchConfig {
  const config: ScratchConfig = {
    openclaw: {
      extensions: ["@mahilo/openclaw-mahilo"]
    },
    plugins: {
      entries: {
        mahilo: {
          config: {
            apiKey: "mhl_test",
            baseUrl: "https://mahilo.example"
          },
          enabled: true
        }
      }
    }
  };

  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(
    join(scratchDir, "openclaw.config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(
    join(scratchDir, "package.json"),
    `${JSON.stringify({ name: "mahilo-openclaw-scratch", private: true, type: "module" }, null, 2)}\n`,
    "utf8"
  );

  return config;
}

function createMockOpenClawApi(pluginConfig: Record<string, unknown>): {
  api: Record<string, unknown>;
  commandNames: string[];
  hookNames: string[];
  routePaths: string[];
  toolNames: string[];
} {
  const commandNames: string[] = [];
  const hookNames: string[] = [];
  const routePaths: string[] = [];
  const toolNames: string[] = [];

  const api = {
    id: "mahilo",
    logger: {
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: () => {}
    },
    name: "Mahilo",
    on: (name: string, execute: unknown) => {
      const hook: RecordedHook = { execute, name };
      hookNames.push(hook.name);
    },
    pluginConfig,
    registerChannel: () => {},
    registerCli: () => {},
    registerCommand: (...args: unknown[]) => {
      if (typeof args[0] === "string") {
        commandNames.push(args[0]);
        return;
      }

      const candidate = args[0];
      if (isRecord(candidate) && typeof candidate.name === "string") {
        commandNames.push(candidate.name);
      }
    },
    registerContextEngine: () => {},
    registerGatewayMethod: () => {},
    registerHook: (...args: unknown[]) => {
      if (typeof args[0] === "string") {
        hookNames.push(args[0]);
        return;
      }

      const candidate = args[0];
      if (isRecord(candidate) && typeof candidate.name === "string") {
        hookNames.push(candidate.name);
      }
    },
    registerHttpRoute: (route: RecordedHttpRoute) => {
      if (typeof route.path === "string") {
        routePaths.push(route.path);
      }
    },
    registerProvider: () => {},
    registerService: () => {},
    registerTool: (tool: { name?: string }) => {
      if (typeof tool.name === "string") {
        toolNames.push(tool.name);
      }
    },
    resolvePath: (input: string) => input,
    runtime: {
      system: {
        enqueueSystemEvent: () => true,
        requestHeartbeatNow: () => {}
      }
    },
    source: "scratch-openclaw",
    version: "1.2.3"
  };

  return {
    api,
    commandNames,
    hookNames,
    routePaths,
    toolNames
  };
}

function removeGeneratedArtifacts(packageDir: string): void {
  rmSync(join(packageDir, "dist"), { force: true, recursive: true });
  rmSync(join(packageDir, "node_modules"), { force: true, recursive: true });

  for (const fileName of readdirSync(packageDir)) {
    if (/\.tgz$/i.test(fileName)) {
      rmSync(join(packageDir, fileName), { force: true });
    }
  }
}

function resolveInstalledPackageDir(scratchDir: string, extensionName: string): string {
  const pathSegments = extensionName.split("/");
  return join(scratchDir, "node_modules", ...pathSegments);
}

function readPackFilePaths(stdout: string, commandLabel: string): string[] {
  const results = parsePackResults(stdout, commandLabel);
  const fileEntries = Array.isArray(results[0]?.files) ? results[0]?.files : [];

  return fileEntries
    .map((file) => file.path)
    .filter((filePath): filePath is string => typeof filePath === "string")
    .map(normalizePackPath)
    .sort();
}

function readTarballFileName(stdout: string): string {
  const results = parsePackResults(stdout, "npm pack --json");
  const fileName = results[0]?.filename;

  if (typeof fileName !== "string" || fileName.length === 0) {
    throw new Error("npm pack --json did not report a tarball filename");
  }

  return fileName;
}

export async function runTarballSmokeTest(sourceDir: string): Promise<TarballSmokeSummary> {
  const tempRoot = mkdtempSync(join(tmpdir(), "mahilo-openclaw-tarball-smoke-"));
  const stagedPackageDir = join(tempRoot, "package");
  const scratchDir = join(tempRoot, "scratch-openclaw");

  cpSync(sourceDir, stagedPackageDir, { recursive: true });
  removeGeneratedArtifacts(stagedPackageDir);
  createScratchConfig(scratchDir);

  try {
    const dryRunStdout = runCommand("npm", ["pack", "--dry-run", "--json"], stagedPackageDir);
    const dryRunFiles = readPackFilePaths(dryRunStdout, "npm pack --dry-run --json");
    assertPackContents(stagedPackageDir, dryRunFiles);

    const packStdout = runCommand("npm", ["pack", "--json"], stagedPackageDir);
    const tarballFileName = readTarballFileName(packStdout);
    const tarballPath = join(stagedPackageDir, tarballFileName);
    const scratchConfig = readJsonFile(join(scratchDir, "openclaw.config.json")) as ScratchConfig;
    const extensionName = scratchConfig.openclaw.extensions[0];

    runCommand("npm", ["install", "--prefix", scratchDir, tarballPath], stagedPackageDir);

    const installedPackageDir = resolveInstalledPackageDir(scratchDir, extensionName);
    const installedPackageJson = readJsonFile(join(installedPackageDir, "package.json"));
    const manifest = readJsonFile(join(installedPackageDir, "openclaw.plugin.json"));
    const installedOpenClaw = installedPackageJson.openclaw;

    if (!isRecord(installedOpenClaw) || !Array.isArray(installedOpenClaw.extensions)) {
      throw new Error("installed package.json is missing openclaw.extensions");
    }

    const packageExtensionEntry = installedOpenClaw.extensions[0];
    if (typeof packageExtensionEntry !== "string") {
      throw new Error("installed package.json did not declare a valid OpenClaw extension entry");
    }

    if (typeof manifest.entry !== "string") {
      throw new Error("installed openclaw.plugin.json did not declare a valid entry");
    }

    if (packageExtensionEntry !== manifest.entry) {
      throw new Error(
        `manifest entry ${manifest.entry} does not match package OpenClaw entry ${packageExtensionEntry}`
      );
    }

    const configSchema = manifest.configSchema;
    if (!isRecord(configSchema) || !Array.isArray(configSchema.required)) {
      throw new Error("installed openclaw.plugin.json is missing configSchema.required");
    }

    const requiredConfigKeys = configSchema.required.filter(
      (value): value is string => typeof value === "string"
    );
    assertStringArrayEquals(
      requiredConfigKeys,
      EXPECTED_REQUIRED_CONFIG_KEYS,
      "required config keys"
    );

    const entryModulePath = join(installedPackageDir, packageExtensionEntry);
    const entryModule = (await import(pathToFileURL(entryModulePath).href)) as Record<
      string,
      unknown
    >;
    const pluginFactory =
      typeof entryModule.createMahiloOpenClawPlugin === "function"
        ? (entryModule.createMahiloOpenClawPlugin as () => { register: (api: unknown) => unknown })
        : undefined;
    const plugin =
      pluginFactory?.() ??
      (entryModule.default as { register?: (api: unknown) => unknown } | undefined);

    if (!plugin || typeof plugin.register !== "function") {
      throw new Error(
        "installed entry module did not expose a registerable plugin definition"
      );
    }

    const { api, commandNames, hookNames, routePaths, toolNames } = createMockOpenClawApi(
      scratchConfig.plugins.entries.mahilo.config
    );

    await plugin.register(api);

    assertStringArrayEquals(toolNames, EXPECTED_TOOL_NAMES, "tool names");
    assertStringArrayEquals(commandNames, EXPECTED_COMMAND_NAMES, "command names");
    assertStringArrayEquals(hookNames, EXPECTED_HOOK_NAMES, "hook names");
    assertStringArrayEquals(routePaths, EXPECTED_ROUTE_PATHS, "route paths");

    return {
      commandNames: [...commandNames].sort(),
      dryRunFiles,
      extensionName,
      hookNames: [...hookNames].sort(),
      manifestEntry: manifest.entry,
      packageExtensionEntry,
      requiredConfigKeys: [...requiredConfigKeys].sort(),
      routePaths: [...routePaths].sort(),
      tarballFileName,
      toolNames: [...toolNames].sort()
    };
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function formatSummary(summary: TarballSmokeSummary): string {
  return [
    "Tarball smoke test passed.",
    `dry-run files: ${summary.dryRunFiles.join(", ")}`,
    `extension: ${summary.extensionName} -> ${summary.packageExtensionEntry}`,
    `manifest entry: ${summary.manifestEntry}`,
    `tools: ${summary.toolNames.join(", ")}`,
    `hooks: ${summary.hookNames.join(", ")}`,
    `routes: ${summary.routePaths.join(", ")}`,
    `commands: ${summary.commandNames.join(", ")}`,
    `required config keys: ${summary.requiredConfigKeys.join(", ")}`,
    `tarball: ${summary.tarballFileName}`
  ].join("\n");
}

if (import.meta.main) {
  const sourceDir = fileURLToPath(new URL("../", import.meta.url));
  const jsonOutput = process.argv.includes("--json");

  try {
    const summary = await runTarballSmokeTest(sourceDir);
    console.log(jsonOutput ? JSON.stringify(summary, null, 2) : formatSummary(summary));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}
