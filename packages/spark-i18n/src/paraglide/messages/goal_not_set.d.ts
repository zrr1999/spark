/**
 * | output |
 * | --- |
 * | "Spark session goal is not set." |
 *
 * @param {Goal_Not_SetInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const goal_not_set: ((
  inputs?: Goal_Not_SetInputs,
  options?: {
    locale?: "en" | "zh-CN";
  },
) => LocalizedString) &
  import("../runtime.js").MessageMetadata<
    Goal_Not_SetInputs,
    {
      locale?: "en" | "zh-CN";
    },
    {}
  >;
export type LocalizedString = import("../runtime.js").LocalizedString;
export type Goal_Not_SetInputs = {};
