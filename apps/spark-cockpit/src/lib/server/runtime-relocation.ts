import { preflightRuntimeRelocation } from "@zendev-lab/spark-coordination/runtime-registration";
import {
  RuntimeRelocationPreflightError,
  RuntimeTokenRefreshError,
} from "@zendev-lab/spark-coordination/runtime-registration";
import { readCockpitInstanceId } from "@zendev-lab/spark-db";

import { getDatabase } from "./db";

export { RuntimeRelocationPreflightError, RuntimeTokenRefreshError };

/** Cockpit-owned access to the persisted instance identity. */
export function cockpitRuntimeRelocationInstanceId(): string | null {
  return readCockpitInstanceId(getDatabase());
}

/** Run relocation preflight against the Cockpit-owned database connection. */
export function preflightCockpitRuntimeRelocation(
  input: Parameters<typeof preflightRuntimeRelocation>[1],
): ReturnType<typeof preflightRuntimeRelocation> {
  return preflightRuntimeRelocation(getDatabase(), input);
}
