export function formText(formData: FormData, key: string, fallback = ""): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : fallback;
}

export function formTextList(formData: FormData, key: string): string[] {
  return formData.getAll(key).filter((value): value is string => typeof value === "string");
}
