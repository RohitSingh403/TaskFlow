import { describe, expect, it } from "vitest";
import { validateWorkflowGraph } from "./workflow.js";

describe("validateWorkflowGraph", () => {
  it("orders a chain from the first step to the final step", () => {
    const graph = validateWorkflowGraph([
      { key: "email", dependsOn: ["report"] },
      { key: "report", dependsOn: [] },
      { key: "notify", dependsOn: ["email"] },
    ]);
    expect(graph).toEqual({ ok: true, root: "notify", executionOrder: ["report", "email", "notify"] });
  });

  it("allows several steps to feed one final step", () => {
    const graph = validateWorkflowGraph([
      { key: "send", dependsOn: ["report", "records"] },
      { key: "report", dependsOn: [] },
      { key: "records", dependsOn: [] },
    ]);
    expect(graph.ok).toBe(true);
    if (graph.ok) expect(graph.root).toBe("send");
  });

  it("rejects a cycle, a shared step, and two final steps", () => {
    expect(validateWorkflowGraph([
      { key: "a", dependsOn: ["b"] },
      { key: "b", dependsOn: ["a"] },
    ]).ok).toBe(false);
    expect(validateWorkflowGraph([
      { key: "a", dependsOn: [] },
      { key: "b", dependsOn: ["a"] },
      { key: "c", dependsOn: ["a"] },
    ]).ok).toBe(false);
    expect(validateWorkflowGraph([
      { key: "a", dependsOn: [] },
      { key: "b", dependsOn: [] },
    ]).ok).toBe(false);
  });
});
