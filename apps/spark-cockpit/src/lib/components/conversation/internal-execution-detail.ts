const CUE_RUNTIME_NAME = /\bcue(?:-shell|-client|_exec)\b/iu;
const CUE_SHELL_ERROR = /\bcue-shell error\s*\[[A-Z0-9_]+\]\s*:/iu;
const TRANSPORT_FAILURE_CODE = /\bTRANSPORT_[A-Z0-9_]*FAILED\b/iu;

/**
 * Detect a daemon/tool transport diagnostic that belongs in runtime logs, not
 * in the human conversation. The cue runtime qualifier keeps unrelated
 * terminal failures visible even if they happen to mention a transport.
 */
export function isInternalExecutionTransportFailure(
  detail: string | undefined,
  runtimeName?: string,
): boolean {
  const text = detail?.trim() ?? "";
  if (!text) return false;
  const runtimeContext = `${runtimeName ?? ""}\n${text}`;
  return (
    CUE_RUNTIME_NAME.test(runtimeContext) &&
    (CUE_SHELL_ERROR.test(text) || TRANSPORT_FAILURE_CODE.test(text))
  );
}
