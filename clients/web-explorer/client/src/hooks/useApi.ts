import { useState, useEffect, useCallback, useRef } from "react";

export type ApiState<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ok"; data: T };

export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: unknown[]
): ApiState<T> & { refetch: () => void } {
  const [state, setState] = useState<ApiState<T>>({ status: "loading" });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(() => {
    setState({ status: "loading" });
    let cancelled = false;
    fetcherRef.current()
      .then((data) => { if (!cancelled) setState({ status: "ok", data }); })
      .catch((err) => {
        if (!cancelled) setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    return run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, refetch: run };
}
