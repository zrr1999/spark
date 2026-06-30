/* eslint-disable */
// @ts-nocheck
import { getLocale, experimentalStaticLocale } from "../runtime.js";

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Status_PendingInputs */

const en_status_pending = /** @type {(inputs: Status_PendingInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `Pending`;
};

const zh_cn2_status_pending =
  /** @type {(inputs: Status_PendingInputs) => LocalizedString} */ () => {
    return /** @type {LocalizedString} */ `待处理`;
  };

/**
 * | output |
 * | --- |
 * | "Pending" |
 *
 * @param {Status_PendingInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const status_pending =
  /** @type {((inputs?: Status_PendingInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Status_PendingInputs, { locale?: "en" | "zh-CN" }, {}>} */ (
    (inputs = {}, options = {}) => {
      const locale = experimentalStaticLocale ?? options.locale ?? getLocale();
      if (locale === "en") return en_status_pending(inputs);
      return zh_cn2_status_pending(inputs);
    }
  );
