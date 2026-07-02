export type CockpitChatPromptSuggestion = {
  id: string;
  label: string;
  prompt: string;
  meta?: string;
};

export type CockpitChatContextCard<Type extends string = string> = {
  id: string;
  type: Type;
  kicker: string;
  title: string;
  description: string;
  prompt: string;
  primaryLabel: string;
  href?: string;
  secondaryLabel?: string;
};
