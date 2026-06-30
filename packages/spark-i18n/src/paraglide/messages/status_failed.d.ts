/**
 * | output |
 * | --- |
 * | "Failed" |
 *
 * @param {Status_FailedInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const status_failed: ((
  inputs?: Status_FailedInputs,
  options?: {
    locale?: "en" | "zh-CN";
  },
) => LocalizedString) &
  import("../runtime.js").MessageMetadata<
    Status_FailedInputs,
    {
      locale?: "en" | "zh-CN";
    },
    {}
  >;
export type LocalizedString = import("../runtime.js").LocalizedString;
export type Status_FailedInputs = {};
