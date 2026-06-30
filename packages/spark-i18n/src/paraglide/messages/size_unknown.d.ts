/**
 * | output |
 * | --- |
 * | "unknown size" |
 *
 * @param {Size_UnknownInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const size_unknown: ((
  inputs?: Size_UnknownInputs,
  options?: {
    locale?: "en" | "zh-CN";
  },
) => LocalizedString) &
  import("../runtime.js").MessageMetadata<
    Size_UnknownInputs,
    {
      locale?: "en" | "zh-CN";
    },
    {}
  >;
export type LocalizedString = import("../runtime.js").LocalizedString;
export type Size_UnknownInputs = {};
