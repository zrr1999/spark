import { sparkSessionOwnerKey, type SparkSessionContext } from "@zendev-lab/spark-loop";

const activeReviewerLeases = new Set<string>();

export interface SparkReviewerLeaseResult<T> {
  acquired: boolean;
  result?: T;
}

export function isSparkReviewerLeaseActive(cwd: string, ctx?: SparkSessionContext): boolean {
  return activeReviewerLeases.has(sparkReviewerLeaseKey(cwd, ctx));
}

export async function withSparkReviewerLease<T>(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  run: () => Promise<T>,
): Promise<SparkReviewerLeaseResult<T>> {
  const key = sparkReviewerLeaseKey(cwd, ctx);
  if (activeReviewerLeases.has(key)) return { acquired: false };
  activeReviewerLeases.add(key);
  try {
    return { acquired: true, result: await run() };
  } finally {
    activeReviewerLeases.delete(key);
  }
}

function sparkReviewerLeaseKey(cwd: string, ctx?: SparkSessionContext): string {
  return `${cwd}:${sparkSessionOwnerKey(ctx)}`;
}
