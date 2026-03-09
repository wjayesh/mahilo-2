#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type CliOptions = {
  workflowFile: string;
  name: string;
  load: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    workflowFile: "WORKFLOW.plugin.md",
    name: "plugin",
    load: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workflow" && argv[index + 1]) {
      options.workflowFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--name" && argv[index + 1]) {
      options.name = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--load") {
      options.load = true;
    }
  }

  return options;
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function buildPlist(options: CliOptions, repoRoot: string): string {
  const safeName = sanitizeName(options.name);
  const label = `ai.mahilo.orchestrator.${safeName}`;
  const stdoutPath = join(repoRoot, ".mahilo-orchestrator", `${safeName}-launchd.out.log`);
  const stderrPath = join(repoRoot, ".mahilo-orchestrator", `${safeName}-launchd.err.log`);
  const bunPath = process.execPath;
  const supervisorScript = resolve(repoRoot, "scripts", "orchestrator-supervisor.ts");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${bunPath}</string>
      <string>run</string>
      <string>${supervisorScript}</string>
      <string>run</string>
      <string>--workflow</string>
      <string>${options.workflowFile}</string>
      <string>--name</string>
      <string>${safeName}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${repoRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${stdoutPath}</string>
    <key>StandardErrorPath</key>
    <string>${stderrPath}</string>
  </dict>
</plist>
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const safeName = sanitizeName(options.name);
  const label = `ai.mahilo.orchestrator.${safeName}`;
  const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(join(repoRoot, ".mahilo-orchestrator"), { recursive: true });
  const plistPath = join(launchAgentsDir, `${label}.plist`);
  writeFileSync(plistPath, buildPlist(options, repoRoot));

  console.log(`Wrote ${plistPath}`);
  console.log(`Load with: launchctl bootstrap gui/$(id -u) ${plistPath}`);
  console.log(`Check with: launchctl print gui/$(id -u)/${label}`);
  console.log(`Unload with: launchctl bootout gui/$(id -u) ${plistPath}`);

  if (options.load) {
    const proc = Bun.spawn(["launchctl", "bootstrap", `gui/${process.getuid?.() ?? "$(id -u)"}`, plistPath], {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    });
    const code = await proc.exited;
    if (code !== 0) {
      process.exit(code);
    }
  }

  if (!existsSync(plistPath)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
