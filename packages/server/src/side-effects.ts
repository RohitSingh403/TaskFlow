import type { Types } from "mongoose";
import { isDuplicateKeyError } from "./ids.js";
import { SideEffect } from "./models.js";

/**
 * Records a successful side effect exactly once per key.
 *
 * The receipt is inserted before the caller treats the operation as done.
 * A retry that lost the race, or a retry after a crash, reads the winning
 * receipt instead of performing the operation again. This is at-least-once
 * execution with an idempotent effect, not exactly-once processing.
 */
export async function commitSideEffect<T>(input: {
  key: string;
  projectId: Types.ObjectId;
  handler: string;
  propose: () => T;
}): Promise<{ result: T; reused: boolean }> {
  const proposed = input.propose();
  try {
    await SideEffect.create({
      key: input.key,
      projectId: input.projectId,
      handler: input.handler,
      result: proposed,
    });
    return { result: proposed, reused: false };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const winner = await SideEffect.findOne({ key: input.key }).lean<{ result: T }>();
    if (!winner) throw error;
    return { result: winner.result, reused: true };
  }
}
