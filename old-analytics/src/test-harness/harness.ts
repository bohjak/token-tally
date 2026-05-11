/**
 * harness.ts — In-process test rig for the pi analytics extension.
 *
 * Provides FakeExtensionAPI and FakeExtensionContext: programmable stubs of
 * pi's ExtensionAPI / ExtensionContext that let tests drive T6–T10 event
 * handlers without a live pi process.
 *
 * Design principles:
 * - No real I/O, no real git/gh/exec calls.
 * - All async exec() calls are answered from a programmable canned-reply map.
 * - All registration methods are record-only stubs (capture args, do nothing).
 * - emit() awaits each registered listener in order, matching pi's serial
 *   dispatch guarantee for a single event name.
 * - FakeExtensionContext carries both ExtensionContext AND
 *   ExtensionCommandContext methods so the same instance works in both
 *   event handlers and command handlers.
 *
 * Usage:
 *   const api = new FakeExtensionAPI();
 *   const ctx = new FakeExtensionContext("/tmp/repo");
 *   api.setExecReply("git", "rev-parse", { stdout: "/repo\n", stderr: "", exitCode: 0 });
 *   api.on("session_start", async (event, ctx) => { ... });
 *   const results = await api.emit("session_start", { reason: "startup" }, ctx);
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Canned response shape for a seeded exec() call. exitCode maps to pi's `code`. */
export type ExecReply = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/** Discriminated record of every ui.* call made by a handler under test. */
export type UiCall =
  | { kind: "notify"; message: string; type: string }
  | { kind: "setStatus"; id: string; text: string | null }
  | { kind: "setWidget"; id: string; lines: string[] }
  | { kind: "confirm"; title: string; message: string }
  | { kind: "select"; title: string; options: string[] }
  | { kind: "input"; title: string; placeholder?: string };

/** Minimal session entry shape compatible with pi's session format. */
export type SessionEntry = {
  type: string;
  id?: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// FakeUi
// ---------------------------------------------------------------------------

/**
 * Records all ui.* calls for assertions and returns programmable answers from
 * pre-seeded queues. When a queue is exhausted:
 *   confirm() → true
 *   select()  → null
 *   input()   → null
 */
export class FakeUi {
  readonly calls: UiCall[] = [];
  private readonly _confirmQueue: boolean[] = [];
  private readonly _selectQueue: (string | null)[] = [];
  private readonly _inputQueue: (string | null)[] = [];

  notify(message: string, type: string = "info"): void {
    this.calls.push({ kind: "notify", message, type });
  }

  setStatus(id: string, text: string | null): void {
    this.calls.push({ kind: "setStatus", id, text });
  }

  setWidget(id: string, lines: string[]): void {
    this.calls.push({ kind: "setWidget", id, lines });
  }

  async confirm(title: string, message: string): Promise<boolean> {
    this.calls.push({ kind: "confirm", title, message });
    return this._confirmQueue.shift() ?? true;
  }

  async select(title: string, options: string[]): Promise<string | null> {
    this.calls.push({ kind: "select", title, options });
    return this._selectQueue.shift() ?? null;
  }

  async input(title: string, placeholder?: string): Promise<string | null> {
    this.calls.push({ kind: "input", title, placeholder });
    return this._inputQueue.shift() ?? null;
  }

  /** Pre-seed answers for the next N confirm() calls (consumed in FIFO order). */
  seedConfirm(...answers: boolean[]): void {
    this._confirmQueue.push(...answers);
  }

  /** Pre-seed answers for the next N select() calls. */
  seedSelect(...answers: (string | null)[]): void {
    this._selectQueue.push(...answers);
  }

  /** Pre-seed answers for the next N input() calls. */
  seedInput(...answers: (string | null)[]): void {
    this._inputQueue.push(...answers);
  }
}

// ---------------------------------------------------------------------------
// FakeSessionManager
// ---------------------------------------------------------------------------

/**
 * In-memory stub of pi's SessionManager.
 * Tests mutate it directly via addEntry() / setSessionFile() to seed state.
 */
export class FakeSessionManager {
  private _sessionFile: string | null;
  private _entries: SessionEntry[] = [];
  private _leafId: string | null = null;

  constructor(sessionFile: string | null = null) {
    this._sessionFile = sessionFile;
  }

  getSessionFile(): string | null {
    return this._sessionFile;
  }

  setSessionFile(path: string | null): void {
    this._sessionFile = path;
  }

  getEntries(): SessionEntry[] {
    return [...this._entries];
  }

  getBranch(): SessionEntry[] {
    return [...this._entries];
  }

  getLeafId(): string | null {
    return this._leafId;
  }

  setLeafId(id: string | null): void {
    this._leafId = id;
  }

  /**
   * Returns the entry whose id matches getLeafId(), or undefined.
   * Provided for compatibility with extensions that call getLeafEntry().
   */
  getLeafEntry(): SessionEntry | undefined {
    if (!this._leafId) return undefined;
    return this._entries.find((e) => e.id === this._leafId);
  }

  /** Append a fake entry and update leafId if the entry has an id field. */
  addEntry(entry: SessionEntry): void {
    this._entries.push(entry);
    if (typeof entry.id === "string") {
      this._leafId = entry.id;
    }
  }

  /** Clear all entries and reset leafId. */
  reset(): void {
    this._entries = [];
    this._leafId = null;
  }
}

// ---------------------------------------------------------------------------
// FakeExtensionContext
// ---------------------------------------------------------------------------

/**
 * Stub of pi's ExtensionContext + ExtensionCommandContext.
 *
 * Event handlers receive an ExtensionContext; command handlers receive an
 * ExtensionCommandContext which adds session-control methods. This single
 * class covers both so tests don't need two separate objects.
 *
 * Command-context-only methods (fork, switchSession, navigateTree, reload,
 * shutdown, waitForIdle, newSession) are record-only stubs.
 */
export class FakeExtensionContext {
  readonly ui = new FakeUi();
  readonly sessionManager: FakeSessionManager;
  cwd: string;
  hasUI: boolean = true;
  signal: AbortSignal | undefined = undefined;

  private _idle = true;
  private _pendingMessages = false;

  /** Recorded calls to command-context-only methods for assertion. */
  readonly commandCalls = {
    waitForIdle: 0,
    newSession: [] as unknown[],
    fork: [] as Array<{ entryId: string; opts?: unknown }>,
    switchSession: [] as Array<{ sessionPath: string; opts?: unknown }>,
    navigateTree: [] as Array<{ targetId: string; opts?: unknown }>,
    reload: 0,
    shutdown: 0,
  };

  constructor(
    cwd = "/tmp/test-repo",
    sessionFile: string | null = "/tmp/test-session.jsonl",
  ) {
    this.cwd = cwd;
    this.sessionManager = new FakeSessionManager(sessionFile);
  }

  // ── ExtensionContext ──────────────────────────────────────────────────────

  isIdle(): boolean {
    return this._idle;
  }

  setIdle(idle: boolean): void {
    this._idle = idle;
  }

  abort(): void {
    // No real AbortController needed — this is a stub.
  }

  hasPendingMessages(): boolean {
    return this._pendingMessages;
  }

  setPendingMessages(pending: boolean): void {
    this._pendingMessages = pending;
  }

  // ── ExtensionCommandContext (record-only stubs) ────────────────────────────

  async waitForIdle(): Promise<void> {
    this.commandCalls.waitForIdle++;
  }

  async newSession(opts?: unknown): Promise<{ cancelled: boolean }> {
    this.commandCalls.newSession.push(opts);
    return { cancelled: false };
  }

  async fork(
    entryId: string,
    opts?: unknown,
  ): Promise<{ cancelled: boolean }> {
    this.commandCalls.fork.push({ entryId, opts });
    return { cancelled: false };
  }

  async switchSession(
    sessionPath: string,
    opts?: unknown,
  ): Promise<{ cancelled: boolean }> {
    this.commandCalls.switchSession.push({ sessionPath, opts });
    return { cancelled: false };
  }

  async navigateTree(targetId: string, opts?: unknown): Promise<unknown> {
    this.commandCalls.navigateTree.push({ targetId, opts });
    return {};
  }

  async reload(): Promise<void> {
    this.commandCalls.reload++;
  }

  shutdown(): void {
    this.commandCalls.shutdown++;
  }
}

// ---------------------------------------------------------------------------
// FakeExtensionAPI
// ---------------------------------------------------------------------------

/**
 * Stub of pi's ExtensionAPI.
 *
 * Key behaviours:
 * - on()   — stores listeners keyed by event name
 * - emit() — awaits each listener in registration order (serial dispatch)
 * - exec() — returns from a priority-ordered canned-reply map:
 *             1. exact full-args key  (setExecReplyExact)
 *             2. cmd + args[0] key    (setExecReply)
 *             3. default reply        (setDefaultExecReply)
 * - register/append/send/set methods — record-only, do not call real pi APIs
 */

// Listeners receive unknown because the harness is not coupled to pi's types.
type AnyListener = (
  event: unknown,
  ctx: FakeExtensionContext,
) => Promise<unknown> | unknown;

export class FakeExtensionAPI {
  /** All registered pi event listeners, keyed by event name. */
  readonly listeners = new Map<string, AnyListener[]>();

  /** Recorded calls to all register* methods. */
  readonly registrations = {
    tools: [] as unknown[],
    commands: [] as Array<{ name: string; opts: unknown }>,
    shortcuts: [] as Array<{ shortcut: string; opts: unknown }>,
    flags: [] as Array<{ name: string; opts: unknown }>,
    providers: [] as Array<{ name: string; config: unknown }>,
    messageRenderers: [] as Array<{ customType: string; renderer: unknown }>,
  };

  /** Recorded calls to stateful API methods. */
  readonly calls = {
    appendEntry: [] as Array<{ customType: string; data?: unknown }>,
    setSessionName: [] as string[],
    setLabel: [] as Array<{ entryId: string; label: string | undefined }>,
    sendMessage: [] as Array<{ message: unknown; options?: unknown }>,
    sendUserMessage: [] as Array<{ content: unknown; options?: unknown }>,
  };

  private readonly _flags = new Map<string, unknown>();
  private _commands: unknown[] = [];

  // Exec reply map — keys use NUL as separator to avoid arg value collisions.
  //   exact key: "cmd\0arg0\0arg1\0..."
  //   subcommand key: "cmd\0arg0"
  private readonly _execReplies = new Map<string, ExecReply>();
  private _defaultExecReply: ExecReply = { stdout: "", stderr: "", exitCode: 0 };

  // ── Event subscription ────────────────────────────────────────────────────

  on(event: string, handler: AnyListener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  // ── Registration stubs (record-only) ──────────────────────────────────────

  registerTool(def: unknown): void {
    this.registrations.tools.push(def);
  }

  registerCommand(name: string, opts: unknown): void {
    this.registrations.commands.push({ name, opts });
  }

  registerShortcut(shortcut: string, opts: unknown): void {
    this.registrations.shortcuts.push({ shortcut, opts });
  }

  registerFlag(name: string, opts: unknown): void {
    this.registrations.flags.push({ name, opts });
  }

  registerProvider(name: string, config: unknown): void {
    this.registrations.providers.push({ name, config });
  }

  registerMessageRenderer(customType: string, renderer: unknown): void {
    this.registrations.messageRenderers.push({ customType, renderer });
  }

  // ── Stateful API stubs (record-only) ──────────────────────────────────────

  appendEntry(customType: string, data?: unknown): void {
    this.calls.appendEntry.push({ customType, data });
  }

  setSessionName(name: string): void {
    this.calls.setSessionName.push(name);
  }

  setLabel(entryId: string, label: string | undefined): void {
    this.calls.setLabel.push({ entryId, label });
  }

  sendMessage(message: unknown, options?: unknown): void {
    this.calls.sendMessage.push({ message, options });
  }

  sendUserMessage(content: unknown, options?: unknown): void {
    this.calls.sendUserMessage.push({ content, options });
  }

  // ── Getters with seeded values ────────────────────────────────────────────

  getCommands(): unknown[] {
    return this._commands;
  }

  /** Seed the value returned by getCommands(). */
  seedCommands(commands: unknown[]): void {
    this._commands = commands;
  }

  getFlag(name: string): unknown {
    return this._flags.get(name);
  }

  /** Seed the value returned by getFlag(name). */
  seedFlag(name: string, value: unknown): void {
    this._flags.set(name, value);
  }

  // ── Exec ─────────────────────────────────────────────────────────────────

  /**
   * Seed a canned reply matched by cmd + args[0] (the sub-command).
   * e.g. setExecReply("git", "rev-parse", {...}) matches all
   * `git rev-parse ...` calls unless a more-specific exact match exists.
   */
  setExecReply(cmd: string, firstArg: string, reply: ExecReply): void {
    this._execReplies.set(`${cmd}\0${firstArg}`, reply);
  }

  /**
   * Seed a canned reply matched by the exact full args array.
   * Takes priority over the subcommand (cmd+args[0]) match.
   * Use this when two calls share args[0] but need different replies,
   * e.g. `git rev-parse --show-toplevel` vs `git rev-parse HEAD`.
   */
  setExecReplyExact(cmd: string, args: string[], reply: ExecReply): void {
    this._execReplies.set([cmd, ...args].join("\0"), reply);
  }

  /** Set the fallback reply used when no key matches. Defaults to { stdout:"", stderr:"", exitCode:0 }. */
  setDefaultExecReply(reply: ExecReply): void {
    this._defaultExecReply = reply;
  }

  /**
   * Implements pi.exec().
   * Return shape: { stdout, stderr, code, killed } — matches pi's real exec().
   * Lookup priority: exact-args key > subcommand key > default reply.
   */
  async exec(
    cmd: string,
    args: string[],
    _opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
    const exactKey = [cmd, ...args].join("\0");
    const subKey = `${cmd}\0${args[0] ?? ""}`;
    const reply =
      this._execReplies.get(exactKey) ??
      this._execReplies.get(subKey) ??
      this._defaultExecReply;
    return {
      stdout: reply.stdout,
      stderr: reply.stderr,
      code: reply.exitCode,
      killed: false,
    };
  }

  // ── Harness driver ────────────────────────────────────────────────────────

  /**
   * Emit a pi event, awaiting every registered listener in registration order.
   * Returns the array of each listener's return value.
   *
   * If ctx is not supplied, a default FakeExtensionContext is constructed for
   * this emit only (useful for smoke-style tests that don't need to assert on
   * context state).
   */
  async emit(
    eventName: string,
    payload: unknown,
    ctx?: FakeExtensionContext,
  ): Promise<unknown[]> {
    const resolvedCtx = ctx ?? new FakeExtensionContext();
    const listeners = this.listeners.get(eventName) ?? [];
    const results: unknown[] = [];
    for (const listener of listeners) {
      results.push(await listener(payload, resolvedCtx));
    }
    return results;
  }
}
