import dotenv from "dotenv";

dotenv.config();

const email = process.env.SEED_EMAIL ?? "ada@example.com";
const password = process.env.SEED_PASSWORD;
const name = process.env.SEED_NAME ?? "Ada Lovelace";

if (!password || password.startsWith("replace-with")) {
  throw new Error("Set SEED_PASSWORD in the environment before running npm run seed");
}

const { User } = await import("@taskflow/server");
const { connectInfrastructure, disconnectInfrastructure } = await import("../apps/api/src/infrastructure.ts");
const { prepareAuth, registerUser } = await import("../apps/api/src/modules/auth/auth.service.ts");
const { createProject } = await import("../apps/api/src/modules/projects/projects.service.ts");

await connectInfrastructure();
await prepareAuth();

const existing = await User.findOne({ email: email.toLowerCase() });
if (existing) {
  console.log(`Account already exists for ${email}. No records were changed.`);
} else {
  const session = await registerUser({ name, email, password }, { userAgent: "seed" });
  const project = await createProject(String(session.user._id), {
    name: "Checkout",
    description: "Sample project for the local demo",
    environment: "development",
  }, { type: "user", id: session.user.publicId });
  console.log(`Created ${email} and project ${project.publicId} (${project.name}).`);
}

await disconnectInfrastructure();
process.exit(0);
