/* eslint-disable */
// @ts-nocheck
import { getLocale, experimentalStaticLocale } from "../runtime.js";

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Status_FailedInputs */

const en_status_failed = /** @type {(inputs: Status_FailedInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `Failed`;
};

const zh_cn2_status_failed = /** @type {(inputs: Status_FailedInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `失败`;
};

/**
 * | output |
 * | --- |
 * | "Failed" |
 *
 * @param {Status_FailedInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const status_failed =
  /** @type {((inputs?: Status_FailedInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Status_FailedInputs, { locale?: "en" | "zh-CN" }, {}>} */ (
    (inputs = {}, options = {}) => {
      const locale = experimentalStaticLocale ?? options.locale ?? getLocale();
      if (locale === "en") return en_status_failed(inputs);
      return zh_cn2_status_failed(inputs);
    }
  );
