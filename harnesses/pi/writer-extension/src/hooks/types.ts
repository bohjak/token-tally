/**
 * types.ts — Minimal Pi API stubs for the writer extension.
 *
 * @mariozechner/pi-coding-agent is not in local node_modules — it is provided
 * at runtime by Pi's module resolver.  These duck-typed stubs cover only what
 * the writer hooks need so `tsc --noEmit` passes without the external package.
 *
 * At runtime Pi passes real ExtensionAPI / ExtensionContext objects whose
 * shapes are structurally compatible with these stubs.
 */

// ---------------------------------------------------------------------------
// Shared exec abstraction (injected by the extension entrypoint)
// ---------------------------------------------------------------------------

/**
 * Portable shell executor injected by the extension entrypoint.
 *
 * Implementations must NOT reject on a non-zero exit code — they return the
 * code in `exitCode` so callers can handle non-zero exits explicitly.
 * Rejection is reserved for truly unrecoverable conditions (e.g. ENOENT).
 */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

// ---------------------------------------------------------------------------
// Minimal Pi stubs
// ---------------------------------------------------------------------------

/** Minimal subset of Pi's ReadonlySessionManager used by hook handlers. */
export type PiSessionManagerStub = {
  getSessionFile(): string | null;
};

/**
 * Minimal subset of Pi's ExtensionContext.
 * Hooks receive this as the second argument to every `pi.on()` callback.
 */
export type PiContextStub = {
  /** Current working directory at the time of the event. */
  cwd: string;
  /** Session manager for reading the session file path. */
  sessionManager: PiSessionManagerStub;
};

/** Generic Pi event handler signature. */
export type PiEventHandler<E = unknown> = (
  event: E,
  ctx: PiContextStub,
) => Promise<void> | void;

/**
 * Minimal subset of Pi's ExtensionAPI used by hook register() functions.
 * Only `on()` is required — the writer extension does not register commands.
 */
export type PiAPIStub = {
  on(event: string, handler: PiEventHandler): void;
};
