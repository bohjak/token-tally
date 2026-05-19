#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const home = homedir();

const useColor = process.stdout.isTTY;
const color = {
  gray: useColor ? "\u001b[90m" : "",
  green: useColor ? "\u001b[0;32m" : "",
  yellow: useColor ? "\u001b[1;33m" : "",
  red: useColor ? "\u001b[0;31m" : "",
  cyan: useColor ? "\u001b[0;36m" : "",
  bold: useColor ? "\u001b[1m" : "",
  reset: useColor ? "\u001b[0m" : "",
};

const dataDir = join(process.env.XDG_DATA_HOME ?? join(home, ".local/share"), "token-tally");
const configDir = join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "token-tally");
const stateDir = join(process.env.XDG_STATE_HOME ?? join(home, ".local/state"), "token-tally");
const manifestPath = join(configDir, "install.json");

type ComponentId = "tray" | "piWriter" | "piUsage" | "claudeCode" | "cursor" | "webExplorer";
type Component = {
  id: ComponentId;
  summaryName: string;
  displayName: string;
  details: string;
  description: string;
  selected: boolean;
  available: boolean;
  detect: () => boolean;
};

type ComponentResult = {
  ok: boolean;
  skipped: boolean;
  message: string;
};

type InstallState = {
  storeOk: boolean;
  storeDbPath: string;
  storeSchemaVersion: number;
  trayVersion: string;
  claudeCodeVersion: string;
  components: Record<ComponentId, ComponentResult>;
};

function info(message: string): void {
  console.log(`  ${color.green}✓${color.reset}  ${message}`);
}

function warn(message: string): void {
  console.log(`  ${color.yellow}!${color.reset}  ${message}`);
}

function err(message: string): void {
  console.error(`  ${color.red}✗${color.reset}  ${message}`);
}

function section(title: string): void {
  console.log(`\n${color.bold}${title}${color.reset}`);
}

function usage(): string {
  return `Usage: scripts/install.sh [--all|--no-tui] [--help]

By default, an interactive component picker is shown when stdin/stdout are a
terminal. Non-interactive runs install the default component set; harness
integrations are skipped unless their harness is detected.

Options:
  --all, --no-tui   Skip the picker and use the default component set
  --help            Show this help

Environment:
  TOKEN_TALLY_INSTALL_NO_TUI=1   Skip the picker and use the default component set`;
}

function parseArgs(argv: string[]): boolean {
  let useTui = true;
  for (const arg of argv) {
    if (["--all", "--no-tui", "--yes", "-y"].includes(arg)) {
      useTui = false;
      continue;
    }
    if (["--help", "-h"].includes(arg)) {
      console.log(usage());
      process.exit(0);
    }
    err(`Unknown option: ${arg}`);
    console.log(usage());
    process.exit(2);
  }

  if (process.env.TOKEN_TALLY_INSTALL_NO_TUI === "1") {
    useTui = false;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    useTui = false;
  }
  return useTui;
}

function commandExists(command: string): boolean {
  return spawnSync("bash", ["-lc", `command -v ${command} >/dev/null 2>&1`], {
    stdio: "ignore",
  }).status === 0;
}

function pathExists(path: string): boolean {
  return existsSync(path);
}

function piIsPresent(): boolean {
  return pathExists(join(home, ".pi/agent/extensions"));
}

function claudeCodeIsPresent(): boolean {
  return commandExists("claude") || pathExists(join(home, ".claude"));
}

function cursorIsPresent(): boolean {
  return commandExists("cursor") ||
    pathExists(join(home, ".cursor")) ||
    pathExists(join(home, "Library/Application Support/Cursor")) ||
    pathExists("/Applications/Cursor.app") ||
    pathExists(join(home, "Applications/Cursor.app"));
}

function makeComponents(): Component[] {
  const components: Component[] = [
    {
      id: "tray",
      summaryName: "tray",
      displayName: "Tray app",
      details: "/Applications/ToTally.app",
      description: "Menu-bar dashboard and launch-at-login app",
      selected: true,
      available: true,
      detect: () => true,
    },
    {
      id: "piWriter",
      summaryName: "pi-writer",
      displayName: "Pi writer",
      details: "~/.pi/agent/extensions/token-tally-writer",
      description: "Captures Pi analytics events into the local ToTally store",
      selected: true,
      available: true,
      detect: piIsPresent,
    },
    {
      id: "piUsage",
      summaryName: "pi-usage",
      displayName: "Pi usage cmd",
      details: "~/.pi/agent/extensions/token-tally-usage",
      description: "Adds a Pi command for viewing token usage from inside Pi",
      selected: true,
      available: true,
      detect: piIsPresent,
    },
    {
      id: "claudeCode",
      summaryName: "claude",
      displayName: "Claude Code",
      details: "~/.claude/settings.json hooks",
      description: "Hook commands merged into Claude Code settings",
      selected: true,
      available: true,
      detect: claudeCodeIsPresent,
    },
    {
      id: "cursor",
      summaryName: "cursor",
      displayName: "Cursor",
      details: "~/.cursor/hooks.json hooks",
      description: "Native Cursor hooks.json command integration",
      selected: true,
      available: true,
      detect: cursorIsPresent,
    },
  ];

  for (const component of components) {
    component.available = component.detect();
    if (!component.available) {
      component.selected = false;
    }
  }

  return components;
}

function paint(text: string, ansiColor: string): string {
  return `${ansiColor}${text}${color.reset}`;
}

function dim(text: string): string {
  return paint(text, color.gray);
}

function requiredLabel(): string {
  return paint("required".padEnd(12), color.gray);
}

function componentLabel(component: Component): string {
  if (!component.available) {
    return paint("not detected".padEnd(12), color.yellow);
  }
  if (component.selected) {
    return paint("selected".padEnd(12), color.green);
  }
  return paint("skipped".padEnd(12), color.yellow);
}

function checkbox(component: { selected: boolean; available: boolean }): string {
  if (!component.available) {
    return paint("[-]", color.gray);
  }
  return component.selected ? paint("[x]", color.green) : "[ ]";
}

function selector(selected: boolean): string {
  return selected ? paint("❯", color.cyan) : " ";
}

function renderRule(width: number): string {
  return paint(`  ${"─".repeat(width)}`, color.gray);
}

function renderPicker(components: Component[], selectedIndex: number): void {
  const ruleWidth = 94;
  const selectedComponent = components[selectedIndex];

  process.stdout.write("\u001b[H\u001b[2J");
  console.log(`${color.bold}ToTally installer${color.reset}`);
  console.log(renderRule(ruleWidth));
  console.log(`  ${dim("Repo")}  ${repoRoot}`);
  console.log();
  console.log("  Choose what to install. Store & CLI is required; unavailable harnesses are shown but disabled.");
  console.log(`  ${paint("↑/↓", color.cyan)} / ${paint("j/k", color.cyan)} move   ${paint("Space", color.cyan)} toggle   ${paint("Enter", color.cyan)} continue   ${paint("q", color.cyan)} cancel`);
  console.log();
  console.log(`  ${dim("Sel")} ${dim("Component".padEnd(17))} ${dim("Status".padEnd(12))} ${dim("Installs")}`);
  console.log(renderRule(ruleWidth));
  console.log(`  ${dim("---")} ${"Store & CLI".padEnd(17)} ${requiredLabel()} token-tally CLI + ${dataDir}/events.db`);

  components.forEach((component, index) => {
    const pointer = selector(selectedIndex === index);
    const name = component.available ? component.displayName.padEnd(17) : dim(component.displayName.padEnd(17));
    const details = component.available ? component.details : dim(component.details);
    console.log(`${pointer} ${checkbox(component)} ${name} ${componentLabel(component)} ${details}`);
  });

  console.log(renderRule(ruleWidth));
  console.log(`${selector(selectedIndex === components.length)} ${paint("Install selected components", color.bold)}`);
  console.log(`${selector(selectedIndex === components.length + 1)} ${dim("Cancel")}`);

  if (selectedComponent) {
    console.log();
    console.log(`  ${dim("Details")} ${selectedComponent.description}`);
    if (!selectedComponent.available) {
      console.log(`          ${paint("Not detected on this system; install the harness first to enable this row.", color.yellow)}`);
    }
  }
}

async function promptComponentSelection(components: Component[]): Promise<void> {
  let selectedIndex = 0;
  renderPicker(components, selectedIndex);

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  await new Promise<void>((resolve) => {
    const onKeypress = (_str: string, key: readline.Key) => {
      const maxIndex = components.length + 1;
      if (key.name === "up" || key.name === "k") {
        selectedIndex = Math.max(0, selectedIndex - 1);
      } else if (key.name === "down" || key.name === "j") {
        selectedIndex = Math.min(maxIndex, selectedIndex + 1);
      } else if (key.name === "space") {
        const component = components[selectedIndex];
        if (component?.available) {
          component.selected = !component.selected;
        }
      } else if (key.name === "return") {
        if (selectedIndex === components.length + 1) {
          cleanupKeypress(onKeypress);
          console.log();
          warn("Install cancelled");
          process.exit(130);
        }
        cleanupKeypress(onKeypress);
        resolve();
        return;
      } else if (key.name === "q" || (key.ctrl && key.name === "c")) {
        cleanupKeypress(onKeypress);
        console.log();
        warn("Install cancelled");
        process.exit(130);
      }
      renderPicker(components, selectedIndex);
    };

    process.stdin.on("keypress", onKeypress);
  });

  process.stdout.write("\u001b[H\u001b[2J");
}

function cleanupKeypress(onKeypress: (str: string, key: readline.Key) => void): void {
  process.stdin.off("keypress", onKeypress);
  process.stdin.setRawMode(false);
  process.stdin.pause();
}

function printComponentPlan(components: Component[]): void {
  console.log("  Components:");
  console.log(`    store   ${requiredLabel()}`);
  for (const component of components) {
    console.log(`    ${component.summaryName.padEnd(7)} ${componentLabel(component)}`);
  }
}

function createDirs(): void {
  mkdirSync(join(dataDir, "spool"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(stateDir, "logs"), { recursive: true });
}

function run(command: string, args: string[], cwd = repoRoot, env: Record<string, string> = {}): boolean {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  return result.status === 0;
}

function capture(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

function readInstalledAt(): number {
  if (existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as { installedAt?: unknown };
      if (typeof raw.installedAt === "number" && Number.isInteger(raw.installedAt)) {
        return raw.installedAt;
      }
    } catch {
      // Malformed manifests should not block reinstall; start a fresh timestamp.
    }
  }
  return Date.now();
}

function readStoreSchemaVersion(): number {
  if (!commandExists("token-tally")) {
    return 0;
  }

  const doctorJson = capture("token-tally", ["doctor", "--json"]);
  if (doctorJson.length === 0) {
    return 0;
  }

  try {
    const parsed = JSON.parse(doctorJson) as { findings?: Array<{ code?: string; detail?: { version?: unknown } }> };
    const schemaFinding = parsed.findings?.find((finding) => finding.code === "schema_ok");
    const version = schemaFinding?.detail?.version;
    if (typeof version === "number" && Number.isInteger(version)) {
      return version;
    }
    if (typeof version === "string" && /^\d+$/.test(version)) {
      return Number(version);
    }
  } catch {
    return 1;
  }

  return 1;
}

function initialInstallState(): InstallState {
  return {
    storeOk: false,
    storeDbPath: join(dataDir, "events.db"),
    storeSchemaVersion: 0,
    trayVersion: "unknown",
    claudeCodeVersion: "unknown",
    components: {
      tray: { ok: false, skipped: false, message: "" },
      piWriter: { ok: false, skipped: false, message: "" },
      piUsage: { ok: false, skipped: false, message: "" },
      claudeCode: { ok: false, skipped: false, message: "" },
      cursor: { ok: false, skipped: false, message: "" },
      webExplorer: { ok: false, skipped: false, message: "" },
    },
  };
}

function componentById(components: Component[], id: ComponentId): Component {
  const component = components.find((candidate) => candidate.id === id);
  if (!component) {
    throw new Error(`Unknown component: ${id}`);
  }
  return component;
}

function runOptionalComponent(
  components: Component[],
  state: InstallState,
  id: ComponentId,
  title: string,
  installerScript: string,
  successMessage: string,
  skippedUnavailableMessage: string,
  skippedUserMessage: string,
  failedMessage: string,
  installerArgs: string[] = [],
): void {
  section(title);
  const component = componentById(components, id);
  const result = state.components[id];

  if (!component.selected) {
    result.skipped = true;
    result.message = component.available ? skippedUserMessage : skippedUnavailableMessage;
    warn(result.message);
    return;
  }

  if (run(join(scriptDir, installerScript), [repoRoot, ...installerArgs])) {
    result.ok = true;
    info(successMessage);
    return;
  }

  result.message = failedMessage;
  warn(result.message);
}

// ---------------------------------------------------------------------------
// Web Explorer install
// ---------------------------------------------------------------------------

/**
 * Returns true when at least one selected component depends on the
 * shared `token-tally explore` launcher being available.
 */
function needsWebExplorer(components: Component[]): boolean {
  return components.some(
    (c) => c.selected && (c.id === "tray" || c.id === "piUsage"),
  );
}

/**
 * Build @token-tally/web-explorer and record the result in state.
 * Aborts the install if the build fails, because any client that was
 * about to be installed would be broken without the launcher.
 */
function runWebExplorerInstall(state: InstallState): void {
  section("Web Explorer");
  const ok = run("bash", [join(scriptDir, "install-web-explorer.sh")]);
  state.components.webExplorer = {
    ok,
    skipped: false,
    message: ok
      ? "Web Explorer built and verified."
      : "Web Explorer build failed.",
  };
  if (ok) {
    info(state.components.webExplorer.message);
    return;
  }
  err(
    "Web Explorer build failed. " +
    "Clients that depend on `token-tally explore` will not work correctly.",
  );
  process.exit(1);
}

function runPricingGeneration(): void {
  section("Pricing table");
  const pricingScript = join(repoRoot, "scripts/generate-pricing.ts");
  if (!existsSync(pricingScript)) {
    warn("scripts/generate-pricing.ts not found — skipping pricing table generation");
    return;
  }

  if (!run("node", ["--no-warnings=MODULE_TYPELESS_PACKAGE_JSON", pricingScript])) {
    err("Pricing table generation failed — aborting");
    process.exit(1);
  }
  info("Pricing table up to date (store/src/pricing/rates.json)");
}

function runStoreInstall(state: InstallState): void {
  section("Store & CLI");
  if (!run(join(scriptDir, "install-store.sh"), [repoRoot, dataDir])) {
    err("Store install failed — aborting");
    process.exit(1);
  }

  state.storeOk = true;
  info("Store installed and database migrated");
  state.storeSchemaVersion = readStoreSchemaVersion();
}

function runTrayInstall(components: Component[], state: InstallState): void {
  runOptionalComponent(
    components,
    state,
    "tray",
    "macOS Tray",
    "install-tray.sh",
    "ToTally.app installed to /Applications/ToTally.app",
    "Tray install skipped",
    "Tray install skipped by user",
    "Tray install failed — check output above",
  );

  if (state.components.tray.ok) {
    state.trayVersion = capture("defaults", ["read", "/Applications/ToTally.app/Contents/Info", "CFBundleShortVersionString"]) || "0.1.0";
  }
}

function runClaudeCodeInstall(components: Component[], state: InstallState): void {
  if (commandExists("claude")) {
    state.claudeCodeVersion = capture("claude", ["--version"]).split("\n")[0] || "unknown";
  }

  runOptionalComponent(
    components,
    state,
    "claudeCode",
    "Claude Code integration",
    "install-claude-code.sh",
    "Claude Code hooks installed",
    "Claude Code not detected — skipping hooks",
    "Claude Code install skipped by user",
    "Claude Code install failed or Claude Code not detected — check output above",
  );
}

function runAllOptionalInstalls(components: Component[], state: InstallState): void {
  runTrayInstall(components, state);
  runOptionalComponent(
    components,
    state,
    "piWriter",
    "Pi writer extension",
    "install-pi.sh",
    "Pi writer extension symlinked",
    "Pi not detected — skipping writer extension",
    "Pi writer extension skipped by user",
    "Pi writer extension install failed or Pi not detected — check output above",
    ["--writer"],
  );
  runOptionalComponent(
    components,
    state,
    "piUsage",
    "Pi usage command",
    "install-pi.sh",
    "Pi usage command symlinked",
    "Pi not detected — skipping usage command",
    "Pi usage command skipped by user",
    "Pi usage command install failed or Pi not detected — check output above",
    ["--usage"],
  );
  runClaudeCodeInstall(components, state);
  runOptionalComponent(
    components,
    state,
    "cursor",
    "Cursor integration",
    "install-cursor.sh",
    "Cursor hooks installed",
    "Cursor not detected — skipping hooks",
    "Cursor install skipped by user",
    "Cursor install failed — check output above",
  );
}

function writeManifest(state: InstallState): void {
  section("Install manifest");
  const installedAt = readInstalledAt();
  const updatedAt = Date.now();
  const data = {
    repoPath: repoRoot,
    nodePath: process.execPath,
    installedAt,
    updatedAt,
    components: {
      store: {
        installed: state.storeOk,
        databasePath: state.storeDbPath,
        schemaVersion: state.storeSchemaVersion,
        nodePath: process.execPath,
      },
      tray: {
        installed: state.components.tray.ok,
        path: "/Applications/ToTally.app",
        version: state.trayVersion,
      },
      pi: {
        installed: state.components.piWriter.ok || state.components.piUsage.ok,
        writerInstalled: state.components.piWriter.ok,
        usageCommandInstalled: state.components.piUsage.ok,
        writerExtensionPath: join(home, ".pi/agent/extensions/token-tally-writer"),
        usageCommandPath: join(home, ".pi/agent/extensions/token-tally-usage"),
        reason: state.components.piWriter.ok || state.components.piUsage.ok
          ? undefined
          : state.components.piWriter.message || state.components.piUsage.message || "Pi not detected or install failed",
      },
      claudeCode: state.components.claudeCode.ok ? {
        installed: true,
        hookBinPath: join(home, ".local/bin/token-tally-claude-hook"),
        settingsPath: join(home, ".claude/settings.json"),
        version: state.claudeCodeVersion,
      } : {
        installed: false,
        reason: state.components.claudeCode.message || "Claude Code not detected or install failed",
      },
      cursor: state.components.cursor.ok ? {
        installed: true,
        hookBinPath: join(home, ".local/bin/token-tally-cursor-hook"),
        hooksJsonPath: join(home, ".cursor/hooks.json"),
      } : {
        installed: false,
        reason: state.components.cursor.message || "Cursor not detected or install skipped",
      },
      // webExplorer is a shared infrastructure component, not a user-selectable
      // integration. It is built when tray or piUsage is selected and skipped
      // (with skipped:true) for store-only installs.
      webExplorer: state.components.webExplorer.skipped ? {
        installed: false,
        skipped: true,
        reason: state.components.webExplorer.message || "Not needed by selected components",
      } : {
        installed: state.components.webExplorer.ok,
        command: "token-tally explore",
        distServerPath: join(repoRoot, "clients/web-explorer/dist/server/index.js"),
        distClientPath: join(repoRoot, "clients/web-explorer/dist/client/index.html"),
        package: "@token-tally/web-explorer",
      },
    },
  };

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(data, null, 2)}\n`);
  info(`Manifest written to ${manifestPath}`);
}

function resultLabel(result: ComponentResult): string {
  if (result.ok) {
    return `${color.green}ok${color.reset}`;
  }
  if (result.skipped) {
    return `${color.yellow}skipped${color.reset}`;
  }
  return `${color.yellow}failed${color.reset}`;
}

function printSummary(state: InstallState): void {
  section("Summary");
  const storeLabel = state.storeOk ? `${color.green}ok${color.reset}` : `${color.red}failed${color.reset}`;
  console.log(`  store     ${storeLabel}`);
  console.log(`  web-exp   ${resultLabel(state.components.webExplorer)}`);
  console.log(`  tray      ${resultLabel(state.components.tray)}`);
  console.log(`  pi-write  ${resultLabel(state.components.piWriter)}`);
  console.log(`  pi-usage  ${resultLabel(state.components.piUsage)}`);
  console.log(`  claude    ${resultLabel(state.components.claudeCode)}`);
  console.log(`  cursor    ${resultLabel(state.components.cursor)}`);
  console.log();

  if (state.storeOk) {
    console.log(`  ${color.green}ToTally installed successfully.${color.reset}`);
    console.log("  Run 'make doctor' to verify component health.");
    console.log("  Run 'git pull && make install' to update.");
    return;
  }

  console.log(`  ${color.red}Install incomplete.${color.reset}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const useTui = parseArgs(process.argv.slice(2));
  const components = makeComponents();

  if (useTui) {
    await promptComponentSelection(components);
  }

  section("ToTally installer");
  console.log(`  Repo: ${repoRoot}`);
  printComponentPlan(components);

  createDirs();
  info("Directories created (data, config, state)");

  const state = initialInstallState();
  runPricingGeneration();
  runStoreInstall(state);

  // Web Explorer is built only when at least one selected component needs the
  // shared `token-tally explore` launcher (currently: tray, Pi usage command).
  // Store-only installs skip this step to keep install time short.
  if (needsWebExplorer(components)) {
    runWebExplorerInstall(state);
  } else {
    section("Web Explorer");
    const result = state.components.webExplorer;
    result.skipped = true;
    result.message = "Web explorer not needed by selected components — skipping build.";
    warn(result.message);
  }

  runAllOptionalInstalls(components, state);
  writeManifest(state);
  printSummary(state);
}

main().catch((error: unknown) => {
  if (process.stdin.isTTY && process.stdin.isRaw) {
    process.stdin.setRawMode(false);
  }
  err(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
