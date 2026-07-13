export interface DaemonWorkspaceRegistrationCommandInput {
  serverOrigin: string;
  displayName: string;
  workspaceName?: string;
  workspaceSlug?: string;
  registrationToken?: string;
  path?: string;
}

export function buildDaemonLoginCommand(serverOrigin: string): string {
  return [
    "spark daemon login",
    `--server-url ${shellQuote(serverOrigin)}`,
    ...(isInsecureRemoteServerOrigin(serverOrigin) ? ["--allow-insecure-http"] : []),
  ].join(" ");
}

export function buildDaemonWorkspaceRegistrationCommand(
  input: DaemonWorkspaceRegistrationCommandInput,
): string {
  return [
    "spark daemon workspace register",
    shellQuote(input.path ?? "."),
    `--server-url ${shellQuote(input.serverOrigin)}`,
    ...(input.registrationToken ? [`--token ${shellQuote(input.registrationToken)}`] : []),
    `--name ${shellQuote(input.displayName)}`,
    ...(input.workspaceName ? [`--workspace-name ${shellQuote(input.workspaceName)}`] : []),
    ...(input.workspaceSlug ? [`--workspace-slug ${shellQuote(input.workspaceSlug)}`] : []),
    ...(isInsecureRemoteServerOrigin(input.serverOrigin) ? ["--allow-insecure-http"] : []),
  ].join(" ");
}

export function isLoopbackServerOrigin(origin: string | URL): boolean {
  const url = typeof origin === "string" ? new URL(origin) : origin;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

export function isInsecureRemoteServerOrigin(origin: string | URL): boolean {
  const url = typeof origin === "string" ? new URL(origin) : origin;
  return url.protocol === "http:" && !isLoopbackServerOrigin(url);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
