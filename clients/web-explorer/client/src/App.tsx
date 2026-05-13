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

export default function App() {
  return <RouterProvider router={router} />;
}
