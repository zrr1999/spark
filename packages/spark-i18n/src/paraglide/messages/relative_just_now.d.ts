/**
 * | output |
 * | --- |
 * | "just now" |
 *
 * @param {Relative_Just_NowInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const relative_just_now: ((
  inputs?: Relative_Just_NowInputs,
  options?: {
    locale?: "en" | "zh-CN";
  },
) => LocalizedString) &
  import("../runtime.js").MessageMetadata<
    Relative_Just_NowInputs,
    {
      locale?: "en" | "zh-CN";
    },
    {}
  >;
export type LocalizedString = import("../runtime.js").LocalizedString;
export type Relative_Just_NowInputs = {};
