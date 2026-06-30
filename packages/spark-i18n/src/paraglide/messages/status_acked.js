/* eslint-disable */
// @ts-nocheck
import { getLocale, experimentalStaticLocale } from "../runtime.js";

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Status_AckedInputs */

const en_status_acked = /** @type {(inputs: Status_AckedInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `Acknowledged`;
};

const zh_cn2_status_acked = /** @type {(inputs: Status_AckedInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `已确认`;
};

/**
 * | output |
 * | --- |
 * | "Acknowledged" |
 *
 * @param {Status_AckedInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const status_acked =
  /** @type {((inputs?: Status_AckedInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Status_AckedInputs, { locale?: "en" | "zh-CN" }, {}>} */ (
    (inputs = {}, options = {}) => {
      const locale = experimentalStaticLocale ?? options.locale ?? getLocale();
      if (locale === "en") return en_status_acked(inputs);
      return zh_cn2_status_acked(inputs);
    }
  );
