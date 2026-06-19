/** Compatibility barrel for Spark daemon core.
 *
 * The daemon implementation now lives in apps/spark-daemon/src/core so there is
 * one core used by the service daemon and the temporary Spark CLI adapter.
 */

export * from "../../../../spark-daemon/src/core/types.ts";
