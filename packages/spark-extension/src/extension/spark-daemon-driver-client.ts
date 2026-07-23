import {
  sparkDriverListResultSchema,
  sparkDriverMutationResultSchema,
  type SparkDriverListResult,
  type SparkDriverMutationRequest,
  type SparkDriverMutationResult,
  type SparkDriverScheduleRequest,
  type SparkDriverStartRequest,
  type SparkDriverStatusRequest,
  type SparkDriverWakeRequest,
} from "@zendev-lab/spark-protocol";
import { requestSparkDaemonLocalRpc } from "@zendev-lab/spark-daemon-client/local-rpc";

export interface SparkDaemonDriverControl {
  start(input: SparkDriverStartRequest): Promise<SparkDriverMutationResult>;
  list(input: SparkDriverStatusRequest): Promise<SparkDriverListResult>;
  stop(input: SparkDriverMutationRequest): Promise<SparkDriverMutationResult>;
  restart(input: SparkDriverMutationRequest): Promise<SparkDriverMutationResult>;
  wake(input: SparkDriverWakeRequest): Promise<SparkDriverMutationResult>;
  schedule(input: SparkDriverScheduleRequest): Promise<SparkDriverMutationResult>;
}

export const sparkDaemonDriverControl: SparkDaemonDriverControl = {
  start: startSparkDaemonDriver,
  list: listSparkDaemonDrivers,
  stop: stopSparkDaemonDriver,
  restart: restartSparkDaemonDriver,
  wake: wakeSparkDaemonDriver,
  schedule: scheduleSparkDaemonDriver,
};

export async function startSparkDaemonDriver(
  input: SparkDriverStartRequest,
): Promise<SparkDriverMutationResult> {
  return sparkDriverMutationResultSchema.parse(
    await requestSparkDaemonLocalRpc("driver.start", input),
  );
}

export async function listSparkDaemonDrivers(
  input: SparkDriverStatusRequest,
): Promise<SparkDriverListResult> {
  return sparkDriverListResultSchema.parse(
    await requestSparkDaemonLocalRpc("driver.status", input),
  );
}

export async function stopSparkDaemonDriver(
  input: SparkDriverMutationRequest,
): Promise<SparkDriverMutationResult> {
  return driverMutation("driver.stop", input);
}

export async function restartSparkDaemonDriver(
  input: SparkDriverMutationRequest,
): Promise<SparkDriverMutationResult> {
  return driverMutation("driver.restart", input);
}

export async function wakeSparkDaemonDriver(
  input: SparkDriverWakeRequest,
): Promise<SparkDriverMutationResult> {
  return driverMutation("driver.wake", input);
}

export async function scheduleSparkDaemonDriver(
  input: SparkDriverScheduleRequest,
): Promise<SparkDriverMutationResult> {
  return driverMutation("driver.schedule", input);
}

async function driverMutation(
  method: "driver.stop" | "driver.restart" | "driver.wake" | "driver.schedule",
  input: SparkDriverMutationRequest | SparkDriverWakeRequest | SparkDriverScheduleRequest,
): Promise<SparkDriverMutationResult> {
  return sparkDriverMutationResultSchema.parse(await requestSparkDaemonLocalRpc(method, input));
}
