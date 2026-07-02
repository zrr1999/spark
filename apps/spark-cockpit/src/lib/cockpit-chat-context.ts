import type { CockpitChatPromptSuggestion } from "./cockpit-chat-types";

export function fillChatTemplate(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template,
  );
}

export function dedupeChatSuggestions<T extends CockpitChatPromptSuggestion>(suggestions: T[]) {
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    const key = suggestion.prompt.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
