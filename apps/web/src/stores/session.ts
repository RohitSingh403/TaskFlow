import { create } from "zustand";
import { bindAuth } from "@/lib/api";
import type { User } from "@/lib/types";

interface SessionState {
  user: User | null;
  accessToken: string | null;
  projectId: string | null;
  status: "unknown" | "authenticated" | "anonymous";
  setSession: (user: User, accessToken: string) => void;
  setAccessToken: (accessToken: string | null) => void;
  setProjectId: (projectId: string | null) => void;
  clear: () => void;
  ready: () => void;
}

export const useSession = create<SessionState>((set) => ({
  user: null,
  accessToken: null,
  projectId: localStorage.getItem("tf.project"),
  status: "unknown",
  setSession: (user, accessToken) => set({ user, accessToken, status: "authenticated" }),
  setAccessToken: (accessToken) => set({ accessToken, status: accessToken ? "authenticated" : "anonymous" }),
  setProjectId: (projectId) => {
    if (projectId) localStorage.setItem("tf.project", projectId);
    else localStorage.removeItem("tf.project");
    set({ projectId });
  },
  clear: () => set({ user: null, accessToken: null, status: "anonymous" }),
  ready: () => set((state) => (state.status === "authenticated" ? state : { status: "anonymous" })),
}));

bindAuth({
  get: () => useSession.getState().accessToken,
  set: (token) => useSession.getState().setAccessToken(token),
  clear: () => useSession.getState().clear(),
});

interface UiState {
  submitOpen: boolean;
  sidebarOpen: boolean;
  toasts: { id: number; tone: "success" | "warning" | "error"; message: string }[];
  openSubmit: () => void;
  closeSubmit: () => void;
  setSidebar: (open: boolean) => void;
  toast: (tone: "success" | "warning" | "error", message: string) => void;
  dismiss: (id: number) => void;
}

let toastId = 1;

export const useUi = create<UiState>((set) => ({
  submitOpen: false,
  sidebarOpen: false,
  toasts: [],
  openSubmit: () => set({ submitOpen: true }),
  closeSubmit: () => set({ submitOpen: false }),
  setSidebar: (sidebarOpen) => set({ sidebarOpen }),
  toast: (tone, message) => {
    const id = toastId++;
    set((state) => ({ toasts: [...state.toasts, { id, tone, message }] }));
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    }, 4200);
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));
