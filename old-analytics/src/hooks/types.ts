/**
 * types.ts — Shared types for all hook modules (T6–T10).
 *
 * Defines:
 *   - HookContext: the context passed to every hook's register() function.
 *   - Minimal pi API stubs used for type-safe event subscription without
 *     importing from @mariozechner/pi-coding-agent (which is only available
 *     at runtime via pi's module resolver, not in our local node_modules).
 *
 * At runtime pi passes real ExtensionAPI / ExtensionContext objects whose
 * shapes are structurally compatible with these stubs. The stubs exist
 * solely to satisfy tsc --noEmit during development.
 */

import type { AnalyticsConfig } from "../sinks/types.ts";
import type { ExecFn } from "../git/capture.ts";

// ---------------------------------------------------------------------------
// HookContext — passed to each hook's register() function
// ---------------------------------------------------------------------------

/**
 * Shared context injected by the extension entrypoint (T15) into every hook.
 *
 * Hooks MUST NOT store HookContext on module-level variables — it is
 * constructed once per extension load. Close over it inside register().
 */
export interface HookContext {
  /** Resolved analytics configuration (merged defaults + user config.json). */
  config: AnalyticsConfig;
  /**
   * Adapter around pi.exec with the ExecFn signature expected by git/capture.ts.
   * T15 bridges pi's { code } shape to ExecFn's { exitCode } shape.
   */
  exec: ExecFn;
}

// ---------------------------------------------------------------------------
// Minimal pi stubs
//
// These are duck-typed interfaces that cover only the surface used by T6–T10.
// The real pi types live in @mariozechner/pi-coding-agent but that package is
// not in our local node_modules. Using structural compatibility means we get
// compile-time safety without the external dependency at build time.
// ---------------------------------------------------------------------------

/** Minimal subset of pi's ReadonlySessionManager used by hook handlers. */
export interface PiSessionManagerStub {
  getSessionFile(): string | null;
}

/**
 * Minimal subset of pi's ExtensionContext used inside event handlers.
 * Hooks receive this as the second argument to every pi.on() callback.
 */
export interface PiContextStub {
  /** Current working directory at the time of the event. */
  cwd: string;
  /** Session manager for reading session file path and entries. */
  sessionManager: PiSessionManagerStub;
  /**
   * The current agent abort signal (undefined when agent is not streaming).
   * Pass to git/exec calls so ESC can cancel them.
   */
  signal: AbortSignal | undefined;
}

/** Generic pi event handler signature. */
export type PiEventHandler<E = unknown> = (
  event: E,
  ctx: PiContextStub,
) => Promise<void> | void;

/**
 * Minimal subset of pi's ExtensionAPI used by hook register() functions.
 * Only `on()` is required — hooks do not register tools or commands.
 */
export interface PiAPIStub {
  on(event: string, handler: PiEventHandler): void;
}
