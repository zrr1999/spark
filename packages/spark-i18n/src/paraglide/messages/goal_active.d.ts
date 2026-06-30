/**
 * | output |
 * | --- |
 * | "Spark goal active" |
 *
 * @param {Goal_ActiveInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const goal_active: ((
  inputs?: Goal_ActiveInputs,
  options?: {
    locale?: "en" | "zh-CN";
  },
) => LocalizedString) &
  import("../runtime.js").MessageMetadata<
    Goal_ActiveInputs,
    {
      locale?: "en" | "zh-CN";
    },
    {}
  >;
export type LocalizedString = import("../runtime.js").LocalizedString;
export type Goal_ActiveInputs = {};
