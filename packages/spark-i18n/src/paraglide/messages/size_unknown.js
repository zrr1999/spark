/* eslint-disable */
// @ts-nocheck
import { getLocale, experimentalStaticLocale } from "../runtime.js";

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Size_UnknownInputs */

const en_size_unknown = /** @type {(inputs: Size_UnknownInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `unknown size`;
};

const zh_cn2_size_unknown = /** @type {(inputs: Size_UnknownInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `大小未知`;
};

/**
 * | output |
 * | --- |
 * | "unknown size" |
 *
 * @param {Size_UnknownInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const size_unknown =
  /** @type {((inputs?: Size_UnknownInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Size_UnknownInputs, { locale?: "en" | "zh-CN" }, {}>} */ (
    (inputs = {}, options = {}) => {
      const locale = experimentalStaticLocale ?? options.locale ?? getLocale();
      if (locale === "en") return en_size_unknown(inputs);
      return zh_cn2_size_unknown(inputs);
    }
  );
