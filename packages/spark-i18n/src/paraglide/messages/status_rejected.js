/* eslint-disable */
// @ts-nocheck
import { getLocale, experimentalStaticLocale } from "../runtime.js";

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Status_RejectedInputs */

const en_status_rejected = /** @type {(inputs: Status_RejectedInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `Rejected`;
};

const zh_cn2_status_rejected =
  /** @type {(inputs: Status_RejectedInputs) => LocalizedString} */ () => {
    return /** @type {LocalizedString} */ `已拒绝`;
  };

/**
 * | output |
 * | --- |
 * | "Rejected" |
 *
 * @param {Status_RejectedInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const status_rejected =
  /** @type {((inputs?: Status_RejectedInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Status_RejectedInputs, { locale?: "en" | "zh-CN" }, {}>} */ (
    (inputs = {}, options = {}) => {
      const locale = experimentalStaticLocale ?? options.locale ?? getLocale();
      if (locale === "en") return en_status_rejected(inputs);
      return zh_cn2_status_rejected(inputs);
    }
  );
