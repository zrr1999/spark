/**
 * | output |
 * | --- |
 * | "never" |
 *
 * @param {Relative_NeverInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const relative_never: ((
  inputs?: Relative_NeverInputs,
  options?: {
    locale?: "en" | "zh-CN";
  },
) => LocalizedString) &
  import("../runtime.js").MessageMetadata<
    Relative_NeverInputs,
    {
      locale?: "en" | "zh-CN";
    },
    {}
  >;
export type LocalizedString = import("../runtime.js").LocalizedString;
export type Relative_NeverInputs = {};
