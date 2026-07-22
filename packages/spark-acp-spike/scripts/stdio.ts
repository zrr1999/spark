#!/usr/bin/env node
/**
 * Optional stdio ACP agent entry for manual editor smoke tests.
 * Not registered in spark-daemon / CLI default paths.
 *
 *   pnpm --filter @zendev-lab/spark-acp-spike run stdio
 */
import { Readable, Writable } from "node:stream";

import { ndJsonStream } from "@agentclientprotocol/sdk";

import { createSparkAcpAgent } from "../src/index.ts";

// Node's toWeb typings are wider than Uint8Array; ACP expects byte streams.
const input = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(input, output);
const { app } = createSparkAcpAgent();
app.connect(stream);
