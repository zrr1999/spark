import { describe, expect, it } from "vitest";
import type {
  ExtensionInteractionRequest,
  ExtensionInteractionResponse,
  TaskStatus,
} from "@zendev-lab/spark-core";
import { TASK_STATUSES } from "@zendev-lab/spark-core";
import {
  sparkInteractionRequestSchema,
  sparkInteractionResponseSchema,
  sparkTaskViewSchema,
  type SparkInteractionRequest,
  type SparkInteractionResponse,
  type SparkTaskView,
} from "./index.ts";

/**
 * Compile-time assignability: protocol wire types must remain assignable to the
 * spark-core ExtensionUi interaction contract (and task status enum stays shared).
 */
type AssertAssignable<Source, Target> = Source extends Target ? true : false;

const _requestAligns: AssertAssignable<SparkInteractionRequest, ExtensionInteractionRequest> = true;
const _responseAligns: AssertAssignable<SparkInteractionResponse, ExtensionInteractionResponse> =
  true;
const _taskStatusAligns: AssertAssignable<SparkTaskView["status"], TaskStatus> = true;

void _requestAligns;
void _responseAligns;
void _taskStatusAligns;

describe("interaction / task status core alignment", () => {
  it("keeps task view status enum locked to core TASK_STATUSES", () => {
    expect(sparkTaskViewSchema.shape.status.options).toEqual([...TASK_STATUSES]);
  });

  it("parses a representative askFlow request/response pair", () => {
    const request = sparkInteractionRequestSchema.parse({
      kind: "askFlow",
      requestId: "ask_flow:test",
      title: "Clarify",
      questions: [{ id: "q1", prompt: "Which option?" }],
    });
    const response = sparkInteractionResponseSchema.parse({
      kind: "askFlow",
      requestId: request.requestId,
      status: "answered",
      answers: { q1: { values: ["a"] } },
    });
    expect(request.kind).toBe("askFlow");
    expect(response.kind).toBe("askFlow");
  });
});
