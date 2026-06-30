/* eslint-disable */
// @ts-nocheck
import { getLocale, experimentalStaticLocale } from "../runtime.js";

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Status_CompletedInputs */

const en_status_completed =
  /** @type {(inputs: Status_CompletedInputs) => LocalizedString} */ () => {
    return /** @type {LocalizedString} */ `Completed`;
  };

const zh_cn2_status_completed =
  /** @type {(inputs: Status_CompletedInputs) => LocalizedString} */ () => {
    return /** @type {LocalizedString} */ `已完成`;
  };

/**
 * | output |
 * | --- |
 * | "Completed" |
 *
 * @param {Status_CompletedInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const status_completed =
  /** @type {((inputs?: Status_CompletedInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Status_CompletedInputs, { locale?: "en" | "zh-CN" }, {}>} */ (
    (inputs = {}, options = {}) => {
      const locale = experimentalStaticLocale ?? options.locale ?? getLocale();
      if (locale === "en") return en_status_completed(inputs);
      return zh_cn2_status_completed(inputs);
    }
  );
