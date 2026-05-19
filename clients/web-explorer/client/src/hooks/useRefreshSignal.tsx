import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type RefreshContextValue = {
  /** Incremented each time a refresh is triggered. Include in useApi dep arrays. */
  nonce: number;
  /** Call this to signal that all data consumers should re-fetch. */
  trigger: () => void;
};

const RefreshContext = createContext<RefreshContextValue>({
  nonce: 0,
  trigger: () => {},
});

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Wrap the app (or a subtree) with this provider to enable the refresh signal.
 * All `useRefreshNonce` and `useRefreshTrigger` consumers within the tree will
 * share the same nonce and trigger.
 *
 * Mount once near the app root (in App.tsx, outside the router provider).
 */
export function RefreshProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const [nonce, setNonce] = useState(0);
  const trigger = useCallback(() => setNonce((n) => n + 1), []);

  return (
    <RefreshContext.Provider value={{ nonce, trigger }}>
      {children}
    </RefreshContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Returns the current refresh nonce. Include this value in the `deps` array
 * of `useApi(fetcher, deps)` calls so that pages re-fetch when the user
 * triggers a manual refresh or when the window regains focus.
 *
 * @example
 * const refreshNonce = useRefreshNonce();
 * const state = useApi(() => fetchSummary(filters), [filters.from, filters.to, refreshNonce]);
 */
export function useRefreshNonce(): number {
  return useContext(RefreshContext).nonce;
}

/**
 * Returns the refresh trigger function. Call it to increment the nonce,
 * which causes all `useRefreshNonce` consumers to re-fetch their data.
 *
 * @example
 * const trigger = useRefreshTrigger();
 * <button onClick={trigger}>↻ Refresh</button>
 */
export function useRefreshTrigger(): () => void {
  return useContext(RefreshContext).trigger;
}
