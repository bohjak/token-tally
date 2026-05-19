import { createBrowserRouter, RouterProvider } from "react-router";
import Layout from "./components/Layout.tsx";
import OverviewPage from "./pages/OverviewPage.tsx";
import DaysPage from "./pages/DaysPage.tsx";
import SessionsPage from "./pages/SessionsPage.tsx";
import SessionDetailPage from "./pages/SessionDetailPage.tsx";
import TurnDetailPage from "./pages/TurnDetailPage.tsx";
import ModelsPage from "./pages/ModelsPage.tsx";
import ReposPage from "./pages/ReposPage.tsx";
import ToolsPage from "./pages/ToolsPage.tsx";
import { RefreshProvider } from "./hooks/useRefreshSignal.tsx";
import { useHeartbeat } from "./hooks/useHeartbeat.ts";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: "days", element: <DaysPage /> },
      { path: "sessions", element: <SessionsPage /> },
      { path: "sessions/:id", element: <SessionDetailPage /> },
      { path: "sessions/:sessionId/turns/:turnId", element: <TurnDetailPage /> },
      { path: "models", element: <ModelsPage /> },
      { path: "repos", element: <ReposPage /> },
      { path: "tools", element: <ToolsPage /> },
    ],
  },
]);

/**
 * Root app component. Wraps everything in RefreshProvider so that any
 * descendant can call useRefreshNonce() / useRefreshTrigger().
 */
export default function App() {
  return (
    <RefreshProvider>
      <AppInner />
    </RefreshProvider>
  );
}

/**
 * Inner component that runs the heartbeat loop. Keeping it separate from App
 * means hooks execute inside the RefreshProvider's render tree (required by
 * React's rules of hooks), and the heartbeat fires regardless of which route
 * is currently active.
 */
function AppInner() {
  useHeartbeat();
  return <RouterProvider router={router} />;
}
