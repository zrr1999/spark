/* eslint-disable */
// @ts-nocheck
import { getLocale, experimentalStaticLocale } from "../runtime.js";

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Status_BlockedInputs */

const en_status_blocked = /** @type {(inputs: Status_BlockedInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `Blocked`;
};

const zh_cn2_status_blocked =
  /** @type {(inputs: Status_BlockedInputs) => LocalizedString} */ () => {
    return /** @type {LocalizedString} */ `已阻塞`;
  };

/**
 * | output |
 * | --- |
 * | "Blocked" |
 *
 * @param {Status_BlockedInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const status_blocked =
  /** @type {((inputs?: Status_BlockedInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Status_BlockedInputs, { locale?: "en" | "zh-CN" }, {}>} */ (
    (inputs = {}, options = {}) => {
      const locale = experimentalStaticLocale ?? options.locale ?? getLocale();
      if (locale === "en") return en_status_blocked(inputs);
      return zh_cn2_status_blocked(inputs);
    }
  );
