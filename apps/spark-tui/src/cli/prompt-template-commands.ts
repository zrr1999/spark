import {
  parseSparkPromptTemplateArgs,
  substituteSparkPromptTemplateArgs,
  type SparkPromptTemplate,
} from "../host/prompt-templates.ts";
import type { SparkCliHostServices } from "../host/index.ts";
import { prepareSparkNativeEditorInput, type SparkNativeSlashCommandMap } from "../native-tui.ts";

export interface SparkPromptTemplateSlashCommandOptions {
  reservedNames?: Iterable<string>;
}

export function createSparkPromptTemplateSlashCommands(
  services: Pick<SparkCliHostServices, "cwd" | "promptTemplates">,
  options: SparkPromptTemplateSlashCommandOptions = {},
): SparkNativeSlashCommandMap {
  const reserved = new Set(
    [...toIterable(options.reservedNames)].map((name) => name.toLowerCase()),
  );
  const commands: SparkNativeSlashCommandMap = {};
  for (const template of services.promptTemplates?.templates ?? []) {
    if (reserved.has(template.name)) continue;
    if (commands[template.name]) continue;
    commands[template.name] = {
      description: template.description,
      argumentHint: template.argumentHint,
      handler: async (args, context) => {
        const expanded = substituteSparkPromptTemplateArgs(
          template.content,
          parseSparkPromptTemplateArgs(args),
        );
        const prepared = await prepareSparkNativeEditorInput(expanded, services.cwd);
        await context.session.submit(prepared);
      },
    };
  }
  return commands;
}

function toIterable<T>(value: Iterable<T> | undefined): Iterable<T> {
  return value ?? [];
}

export function promptTemplateSourceLabel(template: SparkPromptTemplate): string {
  return `${template.layer}:${template.filePath}`;
}
