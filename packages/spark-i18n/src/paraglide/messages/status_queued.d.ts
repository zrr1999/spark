/**
 * | output |
 * | --- |
 * | "Queued" |
 *
 * @param {Status_QueuedInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const status_queued: ((
  inputs?: Status_QueuedInputs,
  options?: {
    locale?: "en" | "zh-CN";
  },
) => LocalizedString) &
  import("../runtime.js").MessageMetadata<
    Status_QueuedInputs,
    {
      locale?: "en" | "zh-CN";
    },
    {}
  >;
export type LocalizedString = import("../runtime.js").LocalizedString;
export type Status_QueuedInputs = {};
