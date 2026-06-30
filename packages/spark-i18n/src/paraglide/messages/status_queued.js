/* eslint-disable */
// @ts-nocheck
import { getLocale, experimentalStaticLocale } from "../runtime.js";

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Status_QueuedInputs */

const en_status_queued = /** @type {(inputs: Status_QueuedInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `Queued`;
};

const zh_cn2_status_queued = /** @type {(inputs: Status_QueuedInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `已排队`;
};

/**
 * | output |
 * | --- |
 * | "Queued" |
 *
 * @param {Status_QueuedInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const status_queued =
  /** @type {((inputs?: Status_QueuedInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Status_QueuedInputs, { locale?: "en" | "zh-CN" }, {}>} */ (
    (inputs = {}, options = {}) => {
      const locale = experimentalStaticLocale ?? options.locale ?? getLocale();
      if (locale === "en") return en_status_queued(inputs);
      return zh_cn2_status_queued(inputs);
    }
  );
