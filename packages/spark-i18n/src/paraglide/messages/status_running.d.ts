/**
 * | output |
 * | --- |
 * | "Running" |
 *
 * @param {Status_RunningInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const status_running: ((
  inputs?: Status_RunningInputs,
  options?: {
    locale?: "en" | "zh-CN";
  },
) => LocalizedString) &
  import("../runtime.js").MessageMetadata<
    Status_RunningInputs,
    {
      locale?: "en" | "zh-CN";
    },
    {}
  >;
export type LocalizedString = import("../runtime.js").LocalizedString;
export type Status_RunningInputs = {};
