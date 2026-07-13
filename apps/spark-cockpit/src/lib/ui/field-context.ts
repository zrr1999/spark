export const fieldContextKey = Symbol("spark-ui-field");

export type FieldContext = {
  describedBy: () => string | undefined;
  invalid: () => boolean;
};
