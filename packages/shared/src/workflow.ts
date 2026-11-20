const STEP_KEY = /^[a-z][a-z0-9-]{0,30}$/;

export interface WorkflowStepRef {
  key: string;
  dependsOn: string[];
}

export type WorkflowGraph =
  | { ok: true; root: string; executionOrder: string[] }
  | { ok: false; message: string };

/**
 * BullMQ flows are trees: children finish before their parent, and a job has one parent.
 * Each step may wait for several earlier steps, but an earlier step can feed only one later step.
 */
export function validateWorkflowGraph(steps: WorkflowStepRef[]): WorkflowGraph {
  if (steps.length < 2 || steps.length > 8) {
    return { ok: false, message: "A workflow needs between 2 and 8 steps" };
  }
  const keys = new Set<string>();
  for (const step of steps) {
    if (!STEP_KEY.test(step.key)) return { ok: false, message: `Step key "${step.key}" must start with a letter and use lowercase letters, numbers, or hyphens` };
    if (keys.has(step.key)) return { ok: false, message: `Step key "${step.key}" is duplicated` };
    keys.add(step.key);
  }

  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    const seen = new Set<string>();
    for (const dependency of step.dependsOn) {
      if (seen.has(dependency)) return { ok: false, message: `Step "${step.key}" lists "${dependency}" more than once` };
      seen.add(dependency);
      if (dependency === step.key) return { ok: false, message: `Step "${step.key}" cannot depend on itself` };
      if (!keys.has(dependency)) return { ok: false, message: `Step "${step.key}" depends on unknown step "${dependency}"` };
      const users = dependents.get(dependency) ?? [];
      users.push(step.key);
      dependents.set(dependency, users);
    }
  }
  for (const [dependency, users] of dependents) {
    if (users.length > 1) {
      return {
        ok: false,
        message: `Step "${dependency}" feeds more than one later step. A flow is a tree, so each step can lead to only one step.`,
      };
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const cyclic = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) {
      if (cyclic(dependency)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  if (steps.some((step) => cyclic(step.key))) return { ok: false, message: "The steps contain a cycle" };

  const roots = steps.filter((step) => (dependents.get(step.key) ?? []).length === 0);
  if (roots.length !== 1) {
    return {
      ok: false,
      message: `A workflow needs one final step. These steps do not lead to another step: ${roots.map((step) => step.key).join(", ")}`,
    };
  }

  const indegree = new Map(steps.map((step) => [step.key, step.dependsOn.length]));
  const pending = steps.filter((step) => step.dependsOn.length === 0).map((step) => step.key);
  const executionOrder: string[] = [];
  while (pending.length > 0) {
    const key = pending.shift();
    if (!key) break;
    executionOrder.push(key);
    for (const step of steps) {
      if (!step.dependsOn.includes(key)) continue;
      const next = (indegree.get(step.key) ?? 1) - 1;
      indegree.set(step.key, next);
      if (next === 0) pending.push(step.key);
    }
  }
  return { ok: true, root: roots[0]?.key ?? "", executionOrder };
}
