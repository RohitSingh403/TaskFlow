import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { io } from "socket.io-client";
import { Shell } from "@/components/shell";
import { api, restoreSession } from "@/lib/api";
import type { User } from "@/lib/types";
import { AccountPage, ApiKeysPage, DocsPage, ProjectSettingsPage } from "@/pages/developer";
import { ActivityPage, AnalyticsPage, LogsPage } from "@/pages/observe";
import { LoginPage, RegisterPage } from "@/pages/auth";
import { DashboardPage } from "@/pages/dashboard";
import { JobDetailPage, JobsPage } from "@/pages/jobs";
import { SchedulesPage } from "@/pages/schedules";
import { WorkflowDetailPage, WorkflowsPage } from "@/pages/workflows";
import { AlertsPage } from "@/pages/alerts";
import { WebhooksPage } from "@/pages/webhooks";
import { QueueDetailPage, QueuesPage } from "@/pages/queues";
import { WorkerDetailPage, WorkersPage } from "@/pages/workers";
import { useSession } from "@/stores/session";

export function App() {
  const status = useSession((state) => state.status);
  const setSession = useSession((state) => state.setSession);
  const ready = useSession((state) => state.ready);
  const token = useSession((state) => state.accessToken);
  const projectId = useSession((state) => state.projectId);
  const client = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    restoreSession()
      .then(async (result) => {
        if (cancelled) return;
        useSession.getState().setAccessToken(result.data.accessToken);
        const me = await api<User>("/auth/me");
        if (!cancelled) setSession(me.data, result.data.accessToken);
      })
      .catch(() => {
        if (!cancelled) ready();
      });
    return () => {
      cancelled = true;
    };
  }, [ready, setSession]);

  useEffect(() => {
    if (!token || !projectId) return;
    const socket = io({ path: "/socket.io", auth: { token }, transports: ["websocket"] });
    const refresh = () => {
      void client.invalidateQueries({ queryKey: ["jobs", projectId] });
      void client.invalidateQueries({ queryKey: ["schedules", projectId] });
      void client.invalidateQueries({ queryKey: ["workflows", projectId] });
      void client.invalidateQueries({ queryKey: ["workflow", projectId] });
      void client.invalidateQueries({ queryKey: ["workflow-run", projectId] });
      void client.invalidateQueries({ queryKey: ["job", projectId] });
      void client.invalidateQueries({ queryKey: ["overview", projectId] });
      void client.invalidateQueries({ queryKey: ["throughput", projectId] });
      void client.invalidateQueries({ queryKey: ["latency", projectId] });
      void client.invalidateQueries({ queryKey: ["failures", projectId] });
      void client.invalidateQueries({ queryKey: ["queues", projectId] });
      void client.invalidateQueries({ queryKey: ["workers", projectId] });
      void client.invalidateQueries({ queryKey: ["logs", projectId] });
      void client.invalidateQueries({ queryKey: ["alerts", projectId] });
      void client.invalidateQueries({ queryKey: ["alert-rules", projectId] });
      void client.invalidateQueries({ queryKey: ["webhooks", projectId] });
    };
    socket.on("connect", () => socket.emit("project:join", projectId));
    socket.on("job.updated", refresh);
    socket.on("queue.updated", refresh);
    socket.on("worker.updated", refresh);
    socket.on("alert.fired", refresh);
    socket.on("connect", refresh);
    return () => {
      socket.close();
    };
  }, [token, projectId, client]);

  if (status === "unknown") {
    return <div className="grid min-h-screen place-items-center text-[13px] text-muted">Restoring session…</div>;
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/" element={status === "authenticated" ? <Shell /> : <Navigate to="/login" replace />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="queues" element={<QueuesPage />} />
        <Route path="queues/:queueId" element={<QueueDetailPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="schedules" element={<SchedulesPage />} />
        <Route path="workflows" element={<WorkflowsPage />} />
        <Route path="workflows/:workflowId" element={<WorkflowDetailPage />} />
        <Route path="jobs/:jobId" element={<JobDetailPage />} />
        <Route path="workers" element={<WorkersPage />} />
        <Route path="workers/:workerId" element={<WorkerDetailPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="webhooks" element={<WebhooksPage />} />
        <Route path="keys" element={<ApiKeysPage />} />
        <Route path="docs" element={<DocsPage />} />
        <Route path="settings/project" element={<ProjectSettingsPage />} />
        <Route path="settings/account" element={<AccountPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
