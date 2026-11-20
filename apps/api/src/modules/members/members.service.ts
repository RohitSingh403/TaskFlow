import { AuditLog, Project, ProjectMember, User, createId, type ProjectDoc, type ProjectMemberDoc } from "@taskflow/server";
import { MAX_PROJECT_MEMBERS } from "@taskflow/shared";
import { AppError } from "../../errors.js";
import type { AuthContext } from "../../types.js";

function toMember(member: { id: string; userId: string; name: string; email: string; role: "owner" | "member" }) {
  return member;
}

export async function listMembers(project: ProjectDoc) {
  const owner = await User.findById(project.ownerId);
  if (!owner) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
  const members = (await ProjectMember.find({ projectId: project._id, deletedAt: null }).sort({ createdAt: 1 }) as ProjectMemberDoc[])
    .filter((member) => String(member.userId) !== String(owner._id));
  return [
    toMember({ id: owner.publicId, userId: owner.publicId, name: owner.name, email: owner.email, role: "owner" }),
    ...members.map((member) => toMember({
      id: member.publicId,
      userId: member.userPublicId,
      name: member.name,
      email: member.email,
      role: "member",
    })),
  ];
}

export async function inviteMember(project: ProjectDoc, email: string, auth: AuthContext) {
  const normalized = email.trim().toLowerCase();
  const user = await User.findOne({ email: normalized });
  if (!user) throw new AppError(404, "USER_NOT_FOUND", "No account uses that email");
  if (String(user._id) === String(project.ownerId)) {
    throw new AppError(409, "ALREADY_MEMBER", "The owner is already on this project");
  }
  const existing = await ProjectMember.findOne({ projectId: project._id, userId: user._id, deletedAt: null });
  if (existing) throw new AppError(409, "ALREADY_MEMBER", "That account is already a member");
  const count = await ProjectMember.countDocuments({ projectId: project._id, deletedAt: null });
  if (count >= MAX_PROJECT_MEMBERS) {
    throw new AppError(409, "MEMBER_LIMIT", `A project can have ${MAX_PROJECT_MEMBERS} members besides the owner`);
  }
  const member = await ProjectMember.create({
    publicId: createId("mem"),
    projectId: project._id,
    projectPublicId: project.publicId,
    userId: user._id,
    userPublicId: user.publicId,
    email: user.email,
    name: user.name,
  });
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "member.invited",
    targetType: "member",
    targetId: member.publicId,
    metadata: { email: user.email },
  });
  return toMember({ id: member.publicId, userId: user.publicId, name: user.name, email: user.email, role: "member" });
}

export async function removeMember(project: ProjectDoc, memberId: string, auth: AuthContext) {
  const member = await ProjectMember.findOne({ projectId: project._id, publicId: memberId, deletedAt: null }) as ProjectMemberDoc | null;
  if (!member) throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found");
  member.deletedAt = new Date();
  await member.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "member.removed",
    targetType: "member",
    targetId: member.publicId,
    metadata: { email: member.email },
  });
}

export async function transferOwnership(project: ProjectDoc, memberId: string, auth: AuthContext) {
  const member = await ProjectMember.findOne({ projectId: project._id, publicId: memberId, deletedAt: null }) as ProjectMemberDoc | null;
  if (!member) throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found");
  const previous = await User.findById(project.ownerId);
  if (!previous) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
  if (String(member.userId) === String(previous._id)) {
    throw new AppError(409, "ALREADY_OWNER", "That account already owns the project");
  }

  const demoted = await ProjectMember.create({
    publicId: createId("mem"),
    projectId: project._id,
    projectPublicId: project.publicId,
    userId: previous._id,
    userPublicId: previous.publicId,
    email: previous.email,
    name: previous.name,
  });
  const claimed = await Project.findOneAndUpdate(
    { _id: project._id, ownerId: previous._id },
    { $set: { ownerId: member.userId } },
  );
  if (!claimed) {
    demoted.deletedAt = new Date();
    await demoted.save();
    throw new AppError(409, "OWNER_CHANGED", "The owner changed before this transfer finished");
  }
  member.deletedAt = new Date();
  await member.save();
  project.ownerId = member.userId;
  await AuditLog.create({
    projectId: project._id,
    actorType: auth.type,
    actorId: auth.userPublicId,
    action: "project.transferred",
    targetType: "project",
    targetId: project.publicId,
    metadata: { from: previous.publicId, to: member.userPublicId },
  });
  return { ownerId: member.userPublicId, previousOwnerId: previous.publicId };
}

export async function leaveProject(project: ProjectDoc, auth: AuthContext) {
  if (String(project.ownerId) === auth.userObjectId) {
    throw new AppError(409, "OWNER_CANNOT_LEAVE", "The owner stays with the project");
  }
  const member = await ProjectMember.findOne({ projectId: project._id, userId: auth.userObjectId, deletedAt: null }) as ProjectMemberDoc | null;
  if (!member) throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found");
  member.deletedAt = new Date();
  await member.save();
  await AuditLog.create({
    projectId: project._id,
    actorType: "user",
    actorId: auth.userPublicId,
    action: "member.left",
    targetType: "member",
    targetId: member.publicId,
    metadata: {},
  });
}
