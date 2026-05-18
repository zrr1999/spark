import type { PiAskFlowOption, PiAskFlowQuestion } from "pi-ask";

export type SparkCopyLanguage = "en" | "zh";

export interface SparkThreadClarificationCopy {
  title: string;
  questions: PiAskFlowQuestion[];
}

export function detectCopyLanguage(text: string): SparkCopyLanguage {
  return /[\u4e00-\u9fff]/u.test(text) ? "zh" : "en";
}

export function clarifyThreadCopy(
  input: { language?: SparkCopyLanguage } = {},
): SparkThreadClarificationCopy {
  const language = input.language ?? "en";
  if (language === "zh") {
    return {
      title: "确认 Spark 线程意图",
      questions: [
        {
          id: "output-language",
          prompt: "Spark 生成的文档和用户可见摘要要使用什么语言？",
          type: "single",
          required: true,
          options: languageOptions("zh"),
        },
        {
          id: "working-title",
          prompt: "这个线程应该使用什么简短工作标题？",
          type: "freeform",
          required: true,
        },
        {
          id: "spark-focus",
          prompt: "Spark 这次应该优先处理哪类工作？",
          type: "single",
          required: true,
          options: sparkFocusOptions("zh"),
        },
        {
          id: "delivery-mode",
          prompt: "这个线程的交付方式是什么？",
          type: "single",
          required: true,
          options: deliveryModeOptions("zh"),
        },
        {
          id: "next-action",
          prompt: "确认这些决策后，Spark 应该继续执行什么？",
          type: "single",
          required: true,
          options: nextActionOptions("zh"),
        },
        {
          id: "boundary",
          prompt: "这次需要明确避免什么？",
          type: "freeform",
        },
      ],
    };
  }
  return {
    title: "Clarify Spark intent",
    questions: [
      {
        id: "output-language",
        prompt:
          "Which language should Spark use for generated documents and user-visible summaries?",
        type: "single",
        required: true,
        options: languageOptions("en"),
      },
      {
        id: "working-title",
        prompt: "What short working title should Spark use for this thread?",
        type: "freeform",
        required: true,
      },
      {
        id: "spark-focus",
        prompt: "What kind of Spark work should this thread prioritize?",
        type: "single",
        required: true,
        options: sparkFocusOptions("en"),
      },
      {
        id: "delivery-mode",
        prompt: "What delivery mode should this thread use?",
        type: "single",
        required: true,
        options: deliveryModeOptions("en"),
      },
      {
        id: "next-action",
        prompt: "After these decisions are confirmed, what should Spark execute next?",
        type: "single",
        required: true,
        options: nextActionOptions("en"),
      },
      {
        id: "boundary",
        prompt: "What should Spark avoid for this pass?",
        type: "freeform",
      },
    ],
  };
}

export function languageOptions(defaultLanguage: SparkCopyLanguage): PiAskFlowOption[] {
  const options: PiAskFlowOption[] = [
    {
      value: "zh",
      label: "Chinese",
      description: "Use Chinese for generated documents and user-visible summaries.",
    },
    {
      value: "en",
      label: "English",
      description: "Use English for generated documents and user-visible summaries.",
    },
  ];
  return [...options].sort(
    (a, b) => Number(b.value === defaultLanguage) - Number(a.value === defaultLanguage),
  );
}

export function sparkFocusOptions(language: SparkCopyLanguage): PiAskFlowOption[] {
  if (language === "zh") {
    return [
      {
        value: "audit",
        label: "审计差距",
        description: "对照现状、参考实现和技术债，找出下一步最值得补的点。",
      },
      {
        value: "light_refactor",
        label: "轻量重构",
        description: "收束边界、删除重复，优先保持实现简单。",
      },
      {
        value: "docs_alignment",
        label: "文档对齐",
        description: "把已确认的设计和行为写清楚，避免状态和说明分叉。",
      },
      {
        value: "execute_change",
        label: "执行改动",
        description: "在范围明确时直接完成代码、测试或配置修改。",
      },
    ];
  }
  return [
    {
      value: "audit",
      label: "Audit gaps",
      description: "Compare current state, references, and tech debt to pick the next fix.",
    },
    {
      value: "light_refactor",
      label: "Light refactor",
      description: "Tighten boundaries and remove duplication while keeping the system small.",
    },
    {
      value: "docs_alignment",
      label: "Docs alignment",
      description: "Make confirmed design and behavior explicit in docs.",
    },
    {
      value: "execute_change",
      label: "Execute change",
      description: "Make the concrete code, test, or config change when scope is clear.",
    },
  ];
}

export function deliveryModeOptions(language: SparkCopyLanguage): PiAskFlowOption[] {
  if (language === "zh") {
    return [
      {
        value: "clarify_only",
        label: "只澄清意图",
        description: "确认意图后停止，不继续扩展交付。",
      },
      {
        value: "document",
        label: "澄清并写入文档",
        description: "确认意图并更新 Spark 或项目文档。",
      },
      {
        value: "document_and_execute",
        label: "澄清、写入文档并继续执行",
        description: "确认意图、记录决策，然后继续执行已确认的下一步。",
      },
      { value: "execute", label: "直接进入执行", description: "澄清完成后进入具体执行。" },
    ];
  }
  return [
    {
      value: "clarify_only",
      label: "Clarification only",
      description: "Confirm intent and stop without expanding delivery.",
    },
    {
      value: "document",
      label: "Clarification and documentation",
      description: "Confirm intent and update Spark or project documentation.",
    },
    {
      value: "document_and_execute",
      label: "Clarification, documentation, and continued execution",
      description: "Confirm intent, record decisions, and continue with the confirmed next step.",
    },
    {
      value: "execute",
      label: "Proceed directly to execution",
      description: "Move into concrete execution after clarification is complete.",
    },
  ];
}

export function nextActionOptions(language: SparkCopyLanguage): PiAskFlowOption[] {
  if (language === "zh") {
    return [
      {
        value: "stop_after_summary",
        label: "输出澄清摘要后停止",
        description: "暂不进入文档或实现。",
      },
      {
        value: "update_docs",
        label: "更新 Spark 文档",
        description: "把确认后的意图写入 SPARK.md 或相关文档。",
      },
      {
        value: "continue_tasking",
        label: "继续任务规划和执行",
        description: "按确认后的范围继续拆分任务并执行。",
      },
    ];
  }
  return [
    {
      value: "stop_after_summary",
      label: "Stop after a clarified summary",
      description: "Do not continue into documentation or implementation yet.",
    },
    {
      value: "update_docs",
      label: "Update Spark documentation",
      description: "Capture the confirmed intent in SPARK.md or related documentation.",
    },
    {
      value: "continue_tasking",
      label: "Continue with task planning and execution",
      description: "Use the confirmed scope to continue task planning and execution.",
    },
  ];
}
