/* eslint-disable */
// @ts-nocheck
import { getLocale } from "../runtime.js";

/** @typedef {import("../runtime.js").LocalizedString} LocalizedString */

const messages = {
  status_ready: {
    en: "Ready",
    "zh-CN": "就绪",
  },
  status_pending: {
    en: "Pending",
    "zh-CN": "待处理",
  },
  status_queued: {
    en: "Queued",
    "zh-CN": "已排队",
  },
  status_running: {
    en: "Running",
    "zh-CN": "运行中",
  },
  status_blocked: {
    en: "Blocked",
    "zh-CN": "已阻塞",
  },
  status_done: {
    en: "Done",
    "zh-CN": "已完成",
  },
  status_completed: {
    en: "Completed",
    "zh-CN": "已完成",
  },
  status_failed: {
    en: "Failed",
    "zh-CN": "失败",
  },
  status_cancelled: {
    en: "Cancelled",
    "zh-CN": "已取消",
  },
  status_rejected: {
    en: "Rejected",
    "zh-CN": "已拒绝",
  },
  status_acked: {
    en: "Acknowledged",
    "zh-CN": "已确认",
  },
  relative_never: {
    en: "never",
    "zh-CN": "从未",
  },
  relative_just_now: {
    en: "just now",
    "zh-CN": "刚刚",
  },
  size_unknown: {
    en: "unknown size",
    "zh-CN": "大小未知",
  },
  goal_active: {
    en: "Spark goal active",
    "zh-CN": "Spark 目标已启动",
  },
  goal_not_set: {
    en: "Spark session goal is not set.",
    "zh-CN": "尚未设置 Spark 会话目标。",
  },
};

function resolveLocale(options) {
  return options?.locale ?? getLocale();
}

function formatMessage(template, params = {}) {
  return template.replace(/\{([A-Za-z_$][\w$]*)\}/gu, (_match, name) =>
    params[name] === undefined || params[name] === null ? "" : String(params[name]),
  );
}

function readMessage(key, params, options) {
  const locale = resolveLocale(options);
  const messagesForKey = messages[key];
  return formatMessage(messagesForKey[locale] ?? messagesForKey.en, params);
}

export const status_ready = (params = {}, options = {}) =>
  readMessage("status_ready", params, options);
export const status_pending = (params = {}, options = {}) =>
  readMessage("status_pending", params, options);
export const status_queued = (params = {}, options = {}) =>
  readMessage("status_queued", params, options);
export const status_running = (params = {}, options = {}) =>
  readMessage("status_running", params, options);
export const status_blocked = (params = {}, options = {}) =>
  readMessage("status_blocked", params, options);
export const status_done = (params = {}, options = {}) =>
  readMessage("status_done", params, options);
export const status_completed = (params = {}, options = {}) =>
  readMessage("status_completed", params, options);
export const status_failed = (params = {}, options = {}) =>
  readMessage("status_failed", params, options);
export const status_cancelled = (params = {}, options = {}) =>
  readMessage("status_cancelled", params, options);
export const status_rejected = (params = {}, options = {}) =>
  readMessage("status_rejected", params, options);
export const status_acked = (params = {}, options = {}) =>
  readMessage("status_acked", params, options);
export const relative_never = (params = {}, options = {}) =>
  readMessage("relative_never", params, options);
export const relative_just_now = (params = {}, options = {}) =>
  readMessage("relative_just_now", params, options);
export const size_unknown = (params = {}, options = {}) =>
  readMessage("size_unknown", params, options);
export const goal_active = (params = {}, options = {}) =>
  readMessage("goal_active", params, options);
export const goal_not_set = (params = {}, options = {}) =>
  readMessage("goal_not_set", params, options);
