import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { ApiError, api } from "@/lib/api";
import type { User } from "@/lib/types";
import { useSession } from "@/stores/session";
import { Button, Field, TextInput } from "@/components/ui";

export function LoginPage() {
  return <AuthScreen mode="login" />;
}

export function RegisterPage() {
  return <AuthScreen mode="register" />;
}

function AuthScreen({ mode }: { mode: "login" | "register" }) {
  const status = useSession((state) => state.status);
  const setSession = useSession((state) => state.setSession);
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  if (status === "authenticated") return <Navigate to="/dashboard" replace />;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);
    const form = new FormData(event.currentTarget);
    const payload = {
      name: String(form.get("name") ?? ""),
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    };
    try {
      const result = await api<{ user: User; accessToken: string }>(mode === "login" ? "/auth/login" : "/auth/register", {
        method: "POST",
        body: JSON.stringify(mode === "login" ? { email: payload.email, password: payload.password } : payload),
      });
      setSession(result.data.user, result.data.accessToken);
      navigate("/dashboard");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Could not sign in");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_0.9fr]">
      <section className="hidden flex-col justify-between border-r border-line bg-sidebar p-10 lg:flex">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-accent text-sm font-semibold text-white">TF</span>
          <span className="font-semibold">TaskFlow</span>
        </div>
        <div>
          <p className="text-3xl font-semibold tracking-tight">Reliable background processing, made observable.</p>
          <p className="mt-4 max-w-md text-[15px] leading-6 text-muted">
            Submit a job, let an independent worker execute it, and inspect every attempt, failure, and retry without blocking the request that created it.
          </p>
        </div>
        <p className="text-[12px] text-faint">Redis executes. MongoDB remembers. The dashboard shows the difference.</p>
      </section>
      <section className="flex items-center justify-center px-5 py-12">
        <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{mode === "login" ? "Sign in" : "Create your workspace"}</h1>
            <p className="mt-1 text-[13px] text-muted">
              {mode === "login" ? "Use the account that owns your projects." : "Passwords need at least 10 characters, with a letter and a number."}
            </p>
          </div>
          {mode === "register" ? (
            <Field label="Name">
              <TextInput name="name" required minLength={2} autoComplete="name" />
            </Field>
          ) : null}
          <Field label="Email">
            <TextInput name="email" type="email" required autoComplete="email" />
          </Field>
          <Field label="Password">
            <TextInput name="password" type="password" required minLength={mode === "register" ? 10 : 1} autoComplete={mode === "login" ? "current-password" : "new-password"} />
          </Field>
          {error ? <p className="text-[13px] text-danger">{error}</p> : null}
          <Button type="submit" className="w-full" loading={pending}>
            {mode === "login" ? "Sign in" : "Create account"}
          </Button>
          <p className="text-[13px] text-muted">
            {mode === "login" ? (
              <>
                New here? <Link className="text-ink underline" to="/register">Create an account</Link>
              </>
            ) : (
              <>
                Already registered? <Link className="text-ink underline" to="/login">Sign in</Link>
              </>
            )}
          </p>
        </form>
      </section>
    </div>
  );
}
