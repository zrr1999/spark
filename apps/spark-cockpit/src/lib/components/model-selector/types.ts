export type ModelPickerOption = {
  value: string;
  label: string;
  description?: string;
  keywords?: string[];
  reasoning?: boolean;
  disabled?: boolean;
};

export type ModelPickerGroup = {
  id: string;
  label: string;
  description?: string;
  options: ModelPickerOption[];
};

export type ModelRuntimeControlLabels = {
  aria: string;
  model: string;
  thinking: string;
  chooseModel: string;
  chooseModelHint: string;
  searchModels: string;
  noModelsFound: string;
  closeModelPicker: string;
  clearModelSearch: string;
  modelUnavailable: string;
  configureModels: string;
  thinkingLevels?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string>>;
};
