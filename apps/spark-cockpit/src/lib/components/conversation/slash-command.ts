export type SlashCommandSuggestion = Readonly<{
  id: string;
  command: string;
  title: string;
  description?: string;
}>;
