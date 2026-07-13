export type ConversationPart =
  | {
      type: "text";
      text: string;
      streaming: boolean;
    }
  | {
      type: "reasoning";
      summary: string;
      state: "streaming" | "complete";
      redacted?: boolean;
    }
  | {
      type: "tool";
      callId: string;
      name: string;
      state: ConversationToolState;
      summary?: string;
    }
  | {
      type: "task";
      taskRef: string;
      title: string;
      state: ConversationTaskState;
      summary?: string;
    }
  | {
      type: "approval";
      requestId: string;
      title: string;
      state: ConversationApprovalState;
      summary?: string;
    }
  | {
      type: "unknown";
      label: string;
    };

export type ConversationToolState =
  | "pending"
  | "awaiting-approval"
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled";

export type ConversationTaskState =
  | "pending"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type ConversationApprovalState = "requested" | "approved" | "rejected" | "cancelled";

export type ConversationMessageView = {
  id: string;
  actor: "user" | "spark";
  body: string;
  title: string | null;
  status: string | null;
  timestamp: string;
  meta: string | null;
  /** Platform-provided sender label for channel messages; null for local user turns. */
  senderLabel: string | null;
  parts: ConversationPart[];
};

export type ConversationPartLabels = {
  reasoning: string;
  reasoningStreaming: string;
  tool: string;
  task: string;
  approval: string;
  unknown: string;
  collapse: string;
  expand: string;
};
