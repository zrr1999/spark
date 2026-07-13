export type ModelPickerOption = {
  value: string;
  label: string;
  description?: string;
  keywords?: string[];
  disabled?: boolean;
};

export type ModelPickerGroup = {
  id: string;
  label: string;
  description?: string;
  options: ModelPickerOption[];
};
