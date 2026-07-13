export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type SelectGroup = {
  id: string;
  label?: string;
  options: SelectOption[];
};
