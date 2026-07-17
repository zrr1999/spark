import { INVOCATION_ROUTE_UNAVAILABLE_ERROR_CODE } from "../error-codes";

const INVOCATION_ROUTE_UNAVAILABLE_MESSAGE = "Invocation has no daemon-owned session route.";

export function presentCockpitServerError(input: {
  error: unknown;
  status: number;
  fallbackMessage: string;
  requestId: string;
}): App.Error {
  if (isInvocationRouteUnavailableError(input.error)) {
    return {
      code: INVOCATION_ROUTE_UNAVAILABLE_ERROR_CODE,
      message: "This invocation is managed by another Spark service.",
      requestId: input.requestId,
    };
  }

  return {
    code: "unexpected_error",
    message: input.fallbackMessage || `Spark Cockpit request failed (${input.status}).`,
    requestId: input.requestId,
  };
}

function isInvocationRouteUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(INVOCATION_ROUTE_UNAVAILABLE_MESSAGE);
}
