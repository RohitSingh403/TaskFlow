import { ProjectMember } from "./models.js";

export async function projectRole(userObjectId: string, project: { _id: unknown; ownerId: unknown }) {
  if (String(project.ownerId) === String(userObjectId)) return "owner" as const;
  const member = await ProjectMember.findOne({ projectId: project._id, userId: userObjectId, deletedAt: null });
  return member ? ("member" as const) : null;
}
