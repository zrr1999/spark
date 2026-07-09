type LocalizedString = import("../runtime.js").LocalizedString;
type Locale = import("../runtime.js").Locale;
type MessageParams = Record<string, unknown>;
type MessageOptions = { locale?: Locale };

export declare const status_ready: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
export declare const status_pending: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
export declare const status_queued: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
export declare const status_running: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
export declare const status_blocked: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
export declare const status_done: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
export declare const status_completed: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
export declare const status_failed: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
export declare const status_cancelled: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
export declare const status_rejected: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
export declare const status_acked: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
export declare const relative_never: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
export declare const relative_just_now: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
export declare const size_unknown: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
export declare const goal_active: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
export declare const goal_not_set: (
  params?: MessageParams,
  options?: MessageOptions,
) => LocalizedString;
