/* eslint-disable */
// @ts-nocheck
import { getLocale, experimentalStaticLocale } from "../runtime.js";

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Status_CancelledInputs */

const en_status_cancelled =
  /** @type {(inputs: Status_CancelledInputs) => LocalizedString} */ () => {
    return /** @type {LocalizedString} */ `Cancelled`;
  };

const zh_cn2_status_cancelled =
  /** @type {(inputs: Status_CancelledInputs) => LocalizedString} */ () => {
    return /** @type {LocalizedString} */ `已取消`;
  };

/**
 * | output |
 * | --- |
 * | "Cancelled" |
 *
 * @param {Status_CancelledInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const status_cancelled =
  /** @type {((inputs?: Status_CancelledInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Status_CancelledInputs, { locale?: "en" | "zh-CN" }, {}>} */ (
    (inputs = {}, options = {}) => {
      const locale = experimentalStaticLocale ?? options.locale ?? getLocale();
      if (locale === "en") return en_status_cancelled(inputs);
      return zh_cn2_status_cancelled(inputs);
    }
  );
