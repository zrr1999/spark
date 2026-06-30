/* eslint-disable */
// @ts-nocheck
import { getLocale, experimentalStaticLocale } from "../runtime.js";

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Relative_Just_NowInputs */

const en_relative_just_now =
  /** @type {(inputs: Relative_Just_NowInputs) => LocalizedString} */ () => {
    return /** @type {LocalizedString} */ `just now`;
  };

const zh_cn2_relative_just_now =
  /** @type {(inputs: Relative_Just_NowInputs) => LocalizedString} */ () => {
    return /** @type {LocalizedString} */ `刚刚`;
  };

/**
 * | output |
 * | --- |
 * | "just now" |
 *
 * @param {Relative_Just_NowInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const relative_just_now =
  /** @type {((inputs?: Relative_Just_NowInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Relative_Just_NowInputs, { locale?: "en" | "zh-CN" }, {}>} */ (
    (inputs = {}, options = {}) => {
      const locale = experimentalStaticLocale ?? options.locale ?? getLocale();
      if (locale === "en") return en_relative_just_now(inputs);
      return zh_cn2_relative_just_now(inputs);
    }
  );
