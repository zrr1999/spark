/* eslint-disable */
// @ts-nocheck
import { getLocale, experimentalStaticLocale } from "../runtime.js";

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Goal_Not_SetInputs */

const en_goal_not_set = /** @type {(inputs: Goal_Not_SetInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `Spark session goal is not set.`;
};

const zh_cn2_goal_not_set = /** @type {(inputs: Goal_Not_SetInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `尚未设置 Spark 会话目标。`;
};

/**
 * | output |
 * | --- |
 * | "Spark session goal is not set." |
 *
 * @param {Goal_Not_SetInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const goal_not_set =
  /** @type {((inputs?: Goal_Not_SetInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Goal_Not_SetInputs, { locale?: "en" | "zh-CN" }, {}>} */ (
    (inputs = {}, options = {}) => {
      const locale = experimentalStaticLocale ?? options.locale ?? getLocale();
      if (locale === "en") return en_goal_not_set(inputs);
      return zh_cn2_goal_not_set(inputs);
    }
  );
