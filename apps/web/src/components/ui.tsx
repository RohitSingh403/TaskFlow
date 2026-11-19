import { Loader2, X } from "lucide-react";
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { useUi } from "@/stores/session";

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
}) {
  const styles = {
    primary: "bg-accent text-white hover:bg-accent-strong",
    secondary: "border border-line bg-card text-ink hover:bg-elevated",
    ghost: "text-muted hover:bg-white/5 hover:text-ink",
    danger: "bg-danger/15 text-danger hover:bg-danger/25",
  }[variant];
  const sizing = size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-10 px-3.5";
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-[10px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${sizing} ${className}`}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {children}
    </button>
  );
}

export function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-muted">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-[12px] text-danger">{error}</span> : null}
    </label>
  );
}

const control = "h-10 w-full rounded-[10px] border border-line bg-bg px-3 text-[13px] outline-none placeholder:text-faint focus:border-accent";

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${control} ${props.className ?? ""}`} />;
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${control} ${props.className ?? ""}`} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`min-h-28 w-full rounded-[10px] border border-line bg-bg px-3 py-2 font-mono text-[12px] outline-none focus:border-accent ${props.className ?? ""}`} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-[12px] border border-line bg-card ${className}`}>{children}</section>;
}

export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-[14px] border border-line bg-elevated p-5 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            {description ? <p className="mt-1 text-[13px] text-muted">{description}</p> : null}
          </div>
          <button aria-label="Close" className="rounded-md p-1 text-muted hover:bg-white/5 hover:text-ink" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[12px] border border-dashed border-line px-5 py-8">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="max-w-lg text-[13px] leading-5 text-muted">{body}</p>
      {action}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-white/5 ${className}`} />;
}

export function Toasts() {
  const toasts = useUi((state) => state.toasts);
  const dismiss = useUi((state) => state.dismiss);
  return (
    <div className="fixed right-4 bottom-4 z-50 flex w-[min(360px,calc(100%-2rem))] flex-col gap-2">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          onClick={() => dismiss(toast.id)}
          className={`rounded-[10px] border px-3 py-2 text-left text-[13px] shadow-lg ${
            toast.tone === "error"
              ? "border-danger/40 bg-[#2a1215] text-danger"
              : toast.tone === "warning"
                ? "border-warning/40 bg-[#2a2112] text-warning"
                : "border-success/40 bg-[#102216] text-success"
          }`}
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
