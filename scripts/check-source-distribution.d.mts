export interface SourceDistributionManifest {
  name?: unknown;
  private?: unknown;
  publishConfig?: unknown;
  bin?: string | Record<string, unknown>;
  scripts?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SourceWorkspace {
  directory: string;
  manifest: SourceDistributionManifest;
  manifestPath: string;
}

export function readSourceWorkspaces(root?: string): Promise<SourceWorkspace[]>;

export function validateSourceDistribution(
  workspaces: SourceWorkspace[],
  rootManifest: SourceDistributionManifest,
): Promise<string[]>;

export function checkSourceDistribution(root?: string): Promise<{
  workspaces: SourceWorkspace[];
}>;
