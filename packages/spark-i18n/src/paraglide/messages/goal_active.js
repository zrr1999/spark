/* eslint-disable */
// @ts-nocheck
import { getLocale, experimentalStaticLocale } from "../runtime.js";

/** @typedef {import('../runtime.js').LocalizedString} LocalizedString */

/** @typedef {{}} Goal_ActiveInputs */

const en_goal_active = /** @type {(inputs: Goal_ActiveInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `Spark goal active`;
};

const zh_cn2_goal_active = /** @type {(inputs: Goal_ActiveInputs) => LocalizedString} */ () => {
  return /** @type {LocalizedString} */ `Spark 目标已启动`;
};

/**
 * | output |
 * | --- |
 * | "Spark goal active" |
 *
 * @param {Goal_ActiveInputs} inputs
 * @param {{ locale?: "en" | "zh-CN" }} options
 * @returns {LocalizedString}
 */
export const goal_active =
  /** @type {((inputs?: Goal_ActiveInputs, options?: { locale?: "en" | "zh-CN" }) => LocalizedString) & import('../runtime.js').MessageMetadata<Goal_ActiveInputs, { locale?: "en" | "zh-CN" }, {}>} */ (
    (inputs = {}, options = {}) => {
      const locale = experimentalStaticLocale ?? options.locale ?? getLocale();
      if (locale === "en") return en_goal_active(inputs);
      return zh_cn2_goal_active(inputs);
    }
  );
