import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "@/lib/api";
import { useSession, useUi } from "@/stores/session";
import { Button, Card, EmptyState, Field, TextInput } from "@/components/ui";

interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: "owner" | "member";
}

export function TeamPage() {
  const projectId = useSession((state) => state.projectId);
  const toast = useUi((state) => state.toast);
  const client = useQueryClient();
  const listed = useQuery({
    queryKey: ["members", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<{ role: "owner" | "member"; members: Member[] }>(`/projects/${projectId}/members`),
  });
  const invite = useMutation({
    mutationFn: (email: string) => api<Member>(`/projects/${projectId}/members`, {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
    onSuccess: () => {
      toast("success", "Member added");
      void client.invalidateQueries({ queryKey: ["members", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not add the member"),
  });
  const remove = useMutation({
    mutationFn: (memberId: string) => api(`/projects/${projectId}/members/${memberId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast("success", "Member removed");
      void client.invalidateQueries({ queryKey: ["members", projectId] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not remove the member"),
  });
  const leave = useMutation({
    mutationFn: () => api(`/projects/${projectId}/members/leave`, { method: "POST" }),
    onSuccess: () => {
      toast("success", "You left the project");
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (reason) => toast("error", reason instanceof ApiError ? reason.message : "Could not leave the project"),
  });

  if (!projectId) return <EmptyState title="Choose a project" body="Team members belong to a project." />;
  const role = listed.data?.data.role;
  const members = listed.data?.data.members ?? [];
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight">Team</h1>
        <p className="max-w-2xl text-[13px] text-muted">
          The owner invites an existing account by email. Members can run the project. API keys, settings, and deletion stay with the owner.
        </p>
      </div>
      {listed.isError ? <EmptyState title="Team unavailable" body="The request failed. Refresh once the API is reachable." /> : null}
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="text-[12px] text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.id} className="border-b border-line/70">
                <td className="px-4 py-3">{member.name}</td>
                <td className="px-4 py-3 text-muted">{member.email}</td>
                <td className="px-4 py-3 capitalize">{member.role}</td>
                <td className="px-4 py-3 text-right">
                  {role === "owner" && member.role === "member" ? (
                    <button type="button" className="text-danger" onClick={() => remove.mutate(member.id)}>Remove</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {role === "owner" ? (
        <Card className="p-4">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const email = String(new FormData(event.currentTarget).get("email") ?? "");
              invite.mutate(email);
              event.currentTarget.reset();
            }}
          >
            <Field label="Email">
              <TextInput name="email" type="email" required placeholder="grace@example.com" className="sm:w-80" />
            </Field>
            <Button type="submit" loading={invite.isPending}>Add member</Button>
          </form>
        </Card>
      ) : null}
      {role === "member" ? (
        <Button variant="secondary" loading={leave.isPending} onClick={() => leave.mutate()}>Leave project</Button>
      ) : null}
    </div>
  );
}
