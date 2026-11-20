import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  Bell,
  CalendarClock,
  GitBranch,
  BookOpen,
  Boxes,
  ChevronDown,
  KeyRound,
  LayoutDashboard,
  Menu,
  ScrollText,
  Server,
  Settings,
  UserRound,
  Workflow,
} from "lucide-react";
import { useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import type { Project } from "@/lib/types";
import { useSession, useUi } from "@/stores/session";
import { JobDialog } from "./job-dialog";
import { Button } from "./ui";

const groups = [
  {
    label: "Overview",
    items: [
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/activity", label: "Activity", icon: Activity },
    ],
  },
  {
    label: "Processing",
    items: [
      { to: "/queues", label: "Queues", icon: Boxes },
      { to: "/jobs", label: "Jobs", icon: Workflow },
      { to: "/schedules", label: "Schedules", icon: CalendarClock },
      { to: "/workflows", label: "Workflows", icon: GitBranch },
      { to: "/workers", label: "Workers", icon: Server },
    ],
  },
  {
    label: "Observability",
    items: [
      { to: "/logs", label: "Logs", icon: ScrollText },
      { to: "/analytics", label: "Analytics", icon: BarChart3 },
      { to: "/alerts", label: "Alerts", icon: Bell },
    ],
  },
  {
    label: "Developer",
    items: [
      { to: "/keys", label: "API keys", icon: KeyRound },
      { to: "/docs", label: "API documentation", icon: BookOpen },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/settings/project", label: "Project settings", icon: Settings },
      { to: "/settings/account", label: "Account settings", icon: UserRound },
    ],
  },
];

export function Shell() {
  const navigate = useNavigate();
  const user = useSession((state) => state.user);
  const projectId = useSession((state) => state.projectId);
  const setProjectId = useSession((state) => state.setProjectId);
  const sidebarOpen = useUi((state) => state.sidebarOpen);
  const setSidebar = useUi((state) => state.setSidebar);
  const openSubmit = useUi((state) => state.openSubmit);
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<Project[]>("/projects"),
  });

  useEffect(() => {
    const list = projects.data?.data;
    if (!list || list.length === 0) return;
    if (!projectId || !list.some((project) => project.id === projectId)) setProjectId(list[0]?.id ?? null);
  }, [projects.data, projectId, setProjectId]);

  return (
    <div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
      {sidebarOpen ? <button aria-label="Close navigation" className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSidebar(false)} /> : null}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[240px] flex-col border-r border-line bg-sidebar transition md:static ${sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}>
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-accent text-white">
            <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
              <path d="M3 4.5h10M3 8h7M3 11.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </span>
          <div>
            <div className="text-[15px] font-semibold tracking-tight">TaskFlow</div>
            <div className="text-[11px] text-faint">Operations workspace</div>
          </div>
        </div>
        <div className="px-3 pb-3">
          <label className="relative block">
            <span className="sr-only">Project</span>
            <select
              aria-label="Project"
              className="h-10 w-full appearance-none rounded-[10px] border border-line bg-card pr-8 pl-3 text-[13px]"
              value={projectId ?? ""}
              onChange={(event) => setProjectId(event.target.value || null)}
            >
              {(projects.data?.data ?? []).length === 0 ? <option value="">No project yet</option> : null}
              {(projects.data?.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute top-3 right-2.5 h-4 w-4 text-faint" />
          </label>
        </div>
        <nav className="flex-1 overflow-auto px-2 pb-4">
          {groups.map((group) => (
            <div key={group.label} className="mb-4">
              <div className="px-2 pb-1 text-[11px] font-medium tracking-[0.08em] text-faint uppercase">{group.label}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setSidebar(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-[13px] ${isActive ? "bg-white/8 text-ink" : "text-muted hover:bg-white/5 hover:text-ink"}`
                  }
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-line px-4 py-3 text-[12px] text-muted">
          <div className="truncate text-ink">{user?.name}</div>
          <div className="truncate">{user?.email}</div>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-bg/90 px-4 backdrop-blur md:px-6">
          <button className="rounded-md p-1.5 text-muted md:hidden" aria-label="Open navigation" onClick={() => setSidebar(true)}>
            <Menu className="h-5 w-5" />
          </button>
          <form
            className="min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const q = String(data.get("q") ?? "").trim();
              navigate(q ? `/jobs?q=${encodeURIComponent(q)}` : "/jobs");
            }}
          >
            <input
              name="q"
              aria-label="Search jobs"
              placeholder="Search job id or name"
              className="h-9 w-full max-w-md rounded-[10px] border border-line bg-card px-3 text-[13px] outline-none placeholder:text-faint focus:border-accent"
            />
          </form>
          <Button onClick={openSubmit} disabled={!projectId}>
            Submit job
          </Button>
        </header>
        <main className="px-4 py-6 md:px-6">
          <Outlet />
        </main>
      </div>
      <JobDialog />
    </div>
  );
}
