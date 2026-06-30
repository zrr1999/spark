/**
 * | output |
 * | --- |
 * | "Completed" |
 *
 * @param {Status_CompletedInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const status_completed: ((
  inputs?: Status_CompletedInputs,
  options?: {
    locale?: "en" | "zh-CN";
  },
) => LocalizedString) &
  import("../runtime.js").MessageMetadata<
    Status_CompletedInputs,
    {
      locale?: "en" | "zh-CN";
    },
    {}
  >;
export type LocalizedString = import("../runtime.js").LocalizedString;
export type Status_CompletedInputs = {};
