/* eslint-disable */
// @ts-nocheck
import { getLocale, experimentalStaticLocale } from "../runtime.js";

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Status_ReadyInputs */

const en_status_ready = /** @type {(inputs: Status_ReadyInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `Ready`;
};

const zh_cn2_status_ready = /** @type {(inputs: Status_ReadyInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `就绪`;
};

/**
 * | output |
 * | --- |
 * | "Ready" |
 *
 * @param {Status_ReadyInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const status_ready =
  /** @type {((inputs?: Status_ReadyInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Status_ReadyInputs, { locale?: "en" | "zh-CN" }, {}>} */ (
    (inputs = {}, options = {}) => {
      const locale = experimentalStaticLocale ?? options.locale ?? getLocale();
      if (locale === "en") return en_status_ready(inputs);
      return zh_cn2_status_ready(inputs);
    }
  );
