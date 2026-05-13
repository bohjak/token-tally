import { NavLink, Outlet } from "react-router";

const primaryNavItems = [
  { to: "/",      label: "Overview", end: true },
  { to: "/days", label: "Days" },
];

const deepDiveNavItems = [
  { to: "/sessions", label: "Sessions" },
  { to: "/models",   label: "Models" },
  { to: "/repos",    label: "Repos" },
  { to: "/tools",    label: "Tools" },
];

export default function Layout() {
  return (
    <div className="flex h-screen bg-gray-50 font-sans">
      {/* Sidebar */}
      <aside className="w-48 shrink-0 bg-gray-900 flex flex-col">
        <div className="px-4 py-5 border-b border-gray-700">
          <span className="text-white font-semibold text-sm tracking-wide">ToTally</span>
          <span className="ml-1 text-gray-400 text-xs">Explorer</span>
        </div>
        <nav className="flex-1 px-2 py-4">
          <div className="space-y-0.5">
            {primaryNavItems.map(({ to, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `block px-3 py-2 rounded text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-blue-600 text-white"
                      : "text-gray-400 hover:bg-gray-800 hover:text-white"
                  }`
                }
              >
                {label}
              </NavLink>
            ))}
          </div>

          <div className="mt-5 border-t border-gray-800 pt-4">
            <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-600">
              Deep dives
            </div>
            <div className="space-y-0.5">
              {deepDiveNavItems.map(({ to, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `block rounded px-3 py-1.5 pl-5 text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-gray-800 text-white"
                        : "text-gray-500 hover:bg-gray-800 hover:text-gray-200"
                    }`
                  }
                >
                  {label}
                </NavLink>
              ))}
            </div>
          </div>
        </nav>
        <div className="px-4 py-3 border-t border-gray-700">
          <span className="text-gray-500 text-xs">token-tally</span>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
