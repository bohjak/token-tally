import { useEffect } from "react";

/**
 * Sends a POST /api/heartbeat to the local explorer server once on mount
 * and then every 30 seconds while the tab is open.
 *
 * The server uses these heartbeats to reset its idle-timeout clock. As long
 * as the browser tab is open and able to execute timers, the server will stay
 * alive. When the tab is closed, heartbeats stop and the server exits after
 * the configured idle timeout (default: 5 minutes).
 *
 * Mount this hook once near the app root (inside AppInner) so there is always
 * exactly one heartbeat loop running, regardless of which page is visible.
 */
export function useHeartbeat(): void {
  useEffect(() => {
    const beat = () =>
      fetch("/api/heartbeat", { method: "POST", keepalive: true }).catch(
        () => {},
      );

    // Fire immediately so the server knows the browser has connected.
    beat();

    const id = window.setInterval(beat, 30_000);
    return () => window.clearInterval(id);
  }, []); // empty deps — run once on mount, clean up on unmount
}
