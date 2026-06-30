/* eslint-disable */
// @ts-nocheck
import { getLocale, experimentalStaticLocale } from "../runtime.js";

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Relative_NeverInputs */

const en_relative_never = /** @type {(inputs: Relative_NeverInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `never`;
};

const zh_cn2_relative_never =
  /** @type {(inputs: Relative_NeverInputs) => LocalizedString} */ () => {
    return /** @type {LocalizedString} */ `从未`;
  };

/**
 * | output |
 * | --- |
 * | "never" |
 *
 * @param {Relative_NeverInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const relative_never =
  /** @type {((inputs?: Relative_NeverInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Relative_NeverInputs, { locale?: "en" | "zh-CN" }, {}>} */ (
    (inputs = {}, options = {}) => {
      const locale = experimentalStaticLocale ?? options.locale ?? getLocale();
      if (locale === "en") return en_relative_never(inputs);
      return zh_cn2_relative_never(inputs);
    }
  );
