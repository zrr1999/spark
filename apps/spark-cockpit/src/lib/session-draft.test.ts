import { describe, expect, it } from "vitest";
import {
  readSessionDraft,
  readSessionPendingSubmission,
  readStartConversationPendingSubmission,
  resolveStartConversationDraftSubmission,
  sessionDraftStorageKey,
  sessionPendingSubmissionStorageKey,
  startConversationPendingSubmissionMatches,
  startConversationPendingSubmissionStorageKey,
  startConversationSubmissionContextKey,
  writeSessionDraft,
  writeSessionPendingSubmission,
  writeStartConversationPendingSubmission,
  type SessionDraftStorage,
} from "./session-draft";

function memoryStorage(): SessionDraftStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe("session draft storage", () => {
  it("keeps drafts isolated by session", () => {
    const storage = memoryStorage();
    writeSessionDraft(storage, "sess_one", "first draft");
    writeSessionDraft(storage, "sess_two", "second draft");

    expect(readSessionDraft(storage, "sess_one")).toBe("first draft");
    expect(readSessionDraft(storage, "sess_two")).toBe("second draft");
  });

  it("removes an empty draft and ignores an empty session id", () => {
    const storage = memoryStorage();
    writeSessionDraft(storage, "sess_one", "draft");
    writeSessionDraft(storage, "sess_one", "");
    writeSessionDraft(storage, "", "ignored");

    expect(readSessionDraft(storage, "sess_one")).toBe("");
    expect(sessionDraftStorageKey(" ")).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  it("restores a pending submission nonce only with its exact message", () => {
    const storage = memoryStorage();
    writeSessionPendingSubmission(storage, "sess_one", {
      message: "retry exactly once",
      submissionId: "idem_123",
    });

    expect(readSessionPendingSubmission(storage, "sess_one")).toEqual({
      message: "retry exactly once",
      submissionId: "idem_123",
    });

    writeSessionPendingSubmission(storage, "sess_one", null);
    expect(readSessionPendingSubmission(storage, "sess_one")).toBeNull();
    expect(sessionPendingSubmissionStorageKey(" ")).toBeNull();
  });

  it("ignores malformed pending submission storage", () => {
    const storage = memoryStorage();
    const key = sessionPendingSubmissionStorageKey("sess_one")!;
    storage.setItem(key, "{not-json");
    expect(readSessionPendingSubmission(storage, "sess_one")).toBeNull();
    storage.setItem(key, JSON.stringify({ message: "draft" }));
    expect(readSessionPendingSubmission(storage, "sess_one")).toBeNull();
  });

  it("restores a first-message nonce after reload only for the exact submission context", () => {
    const storage = memoryStorage();
    const pending = {
      workspaceId: "ws_one",
      message: "retry the first message",
      model: "provider/model",
      thinkingLevel: "high",
      submissionId: "idem_start_123",
    };
    writeStartConversationPendingSubmission(storage, pending.workspaceId, pending);

    // A new component instance after a browser reload reads the same durable
    // browser state and can safely retry with the original nonce.
    const restored = readStartConversationPendingSubmission(storage, "ws_one");
    expect(restored).toEqual(pending);
    expect(startConversationPendingSubmissionMatches(restored, pending)).toBe(true);

    for (const changed of [
      { ...pending, workspaceId: "ws_two" },
      { ...pending, message: "a different first message" },
      { ...pending, model: "provider/other" },
      { ...pending, thinkingLevel: "low" },
    ]) {
      expect(startConversationPendingSubmissionMatches(restored, changed)).toBe(false);
    }
  });

  it("persists an unsent first-message draft and rotates only when its context changes", () => {
    const context = {
      workspaceId: "ws_one",
      message: "draft before send",
      model: "provider/model",
      thinkingLevel: "medium",
    };
    let sequence = 0;
    const createSubmissionId = () => `idem_created_${++sequence}`;

    const initial = resolveStartConversationDraftSubmission({
      context,
      pending: null,
      previousContextKey: "",
      submissionId: "idem_server_seed",
      createSubmissionId,
    });
    expect(initial).toEqual({
      contextKey: startConversationSubmissionContextKey(context),
      pending: { ...context, submissionId: "idem_server_seed" },
      submissionId: "idem_server_seed",
    });

    const restored = resolveStartConversationDraftSubmission({
      context,
      pending: initial.pending,
      previousContextKey: initial.contextKey,
      submissionId: "idem_different_server_seed",
      createSubmissionId,
    });
    expect(restored.submissionId).toBe("idem_server_seed");
    expect(sequence).toBe(0);

    const changed = resolveStartConversationDraftSubmission({
      context: { ...context, message: "changed draft" },
      pending: initial.pending,
      previousContextKey: initial.contextKey,
      submissionId: initial.submissionId,
      createSubmissionId,
    });
    expect(changed.submissionId).toBe("idem_created_1");
    expect(changed.pending?.message).toBe("changed draft");

    const cleared = resolveStartConversationDraftSubmission({
      context: { ...context, message: "" },
      pending: changed.pending,
      previousContextKey: changed.contextKey,
      submissionId: changed.submissionId,
      createSubmissionId,
    });
    expect(cleared).toEqual({
      contextKey: "",
      pending: null,
      submissionId: "idem_created_2",
    });
  });

  it("keeps first-message storage workspace-scoped and rejects ambiguous or malformed records", () => {
    const storage = memoryStorage();
    const first = {
      workspaceId: "ws:one/two",
      message: "message | with separators",
      model: "provider/model",
      thinkingLevel: "medium",
      submissionId: "idem_start_safe",
    };
    writeStartConversationPendingSubmission(storage, first.workspaceId, first);

    expect(startConversationPendingSubmissionStorageKey(first.workspaceId)).toContain(
      encodeURIComponent(first.workspaceId),
    );
    expect(startConversationSubmissionContextKey(first)).not.toBe(
      startConversationSubmissionContextKey({ ...first, message: `${first.message}|` }),
    );
    expect(readStartConversationPendingSubmission(storage, "ws_other")).toBeNull();

    const key = startConversationPendingSubmissionStorageKey(first.workspaceId)!;
    storage.setItem(key, JSON.stringify({ ...first, workspaceId: "ws_other" }));
    expect(readStartConversationPendingSubmission(storage, first.workspaceId)).toBeNull();
  });
});
