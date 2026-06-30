/* eslint-disable */
// @ts-nocheck
import { getLocale, experimentalStaticLocale } from "../runtime.js";

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Status_RunningInputs */

const en_status_running = /** @type {(inputs: Status_RunningInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `Running`;
};

const zh_cn2_status_running =
  /** @type {(inputs: Status_RunningInputs) => LocalizedString} */ () => {
    return /** @type {LocalizedString} */ `运行中`;
  };

/**
 * | output |
 * | --- |
 * | "Running" |
 *
 * @param {Status_RunningInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const status_running =
  /** @type {((inputs?: Status_RunningInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Status_RunningInputs, { locale?: "en" | "zh-CN" }, {}>} */ (
    (inputs = {}, options = {}) => {
      const locale = experimentalStaticLocale ?? options.locale ?? getLocale();
      if (locale === "en") return en_status_running(inputs);
      return zh_cn2_status_running(inputs);
    }
  );
