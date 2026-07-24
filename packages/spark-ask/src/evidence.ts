import { createHash } from "node:crypto";
import { join } from "node:path";

import type { Artifact } from "@zendev-lab/spark-artifacts";
import {
  readJsonFileOptional,
  writeJsonFileAtomic,
  type EvidenceRef,
} from "@zendev-lab/spark-core";

import type { SparkAskAutoAnswerRequest } from "./action-tool.ts";

export interface SparkAskEvidenceArtifactBody {
  schema: "spark.ask.evidence/v1";
  request: SparkAskAutoAnswerRequest;
  result: unknown;
  autoAnswered: boolean;
  recordedAt: string;
}

export interface CanonicalAskEvidenceAnswer {
  questionId: string;
  values: string[];
  customText?: string;
}

export interface VerifiedCanonicalAskEvidence {
  answers: CanonicalAskEvidenceAnswer[];
  selectedValues: string[];
}

interface CanonicalAskEvidenceReceipt {
  schema: "spark.ask.evidence-receipt/v1";
  evidenceRef: EvidenceRef;
  evidenceHash: string;
  answersHash: string;
  recordedAt: string;
}

export function isUserAnsweredAskEvidenceArtifactBody(
  value: unknown,
): value is SparkAskEvidenceArtifactBody {
  return normalizeUserAnsweredAskEvidence(value) !== undefined;
}

/**
 * Persist a receipt outside the public evidence surface. The receipt binds the
 * evidence ref, content hash, and normalized user answers to the canonical ask
 * execution that created it. A caller using evidence action=record cannot mint
 * this receipt merely by claiming provenance.producer=ask.
 */
export async function recordCanonicalAskEvidenceReceipt(
  cwd: string,
  evidence: Artifact,
): Promise<void> {
  const answers = normalizeUserAnsweredAskEvidence(evidence.body);
  if (!answers) throw new Error("canonical ask evidence requires a user-answered result");
  if (!evidence.hash) throw new Error("canonical ask evidence is missing its content hash");
  const evidenceRef = asEvidenceRef(evidence.ref);
  const receipt: CanonicalAskEvidenceReceipt = {
    schema: "spark.ask.evidence-receipt/v1",
    evidenceRef,
    evidenceHash: evidence.hash,
    answersHash: hashAnswers(answers),
    recordedAt: new Date().toISOString(),
  };
  await writeJsonFileAtomic(canonicalAskEvidenceReceiptPath(cwd, evidenceRef), receipt);
}

export async function verifyCanonicalAskEvidenceArtifact(
  cwd: string,
  evidence: Artifact,
): Promise<VerifiedCanonicalAskEvidence | undefined> {
  const answers = normalizeUserAnsweredAskEvidence(evidence.body);
  if (!answers || !evidence.hash || !evidence.ref.startsWith("evidence:")) return undefined;
  const evidenceRef = asEvidenceRef(evidence.ref);
  const raw = await readJsonFileOptional(
    canonicalAskEvidenceReceiptPath(cwd, evidenceRef),
    (filePath, message) => new Error(`${filePath}: ${message}`),
  );
  const receipt = parseCanonicalAskEvidenceReceipt(raw);
  if (
    !receipt ||
    receipt.evidenceRef !== evidenceRef ||
    receipt.evidenceHash !== evidence.hash ||
    receipt.answersHash !== hashAnswers(answers)
  ) {
    return undefined;
  }
  return {
    answers,
    selectedValues: uniqueStrings(
      answers.flatMap((answer) => [
        ...answer.values,
        ...(answer.customText ? [answer.customText] : []),
      ]),
    ),
  };
}

function normalizeUserAnsweredAskEvidence(
  value: unknown,
): CanonicalAskEvidenceAnswer[] | undefined {
  if (!isRecord(value) || value.schema !== "spark.ask.evidence/v1") return undefined;
  if (value.autoAnswered !== false || !isRecord(value.request) || !isRecord(value.result)) {
    return undefined;
  }
  if (value.result.status !== "answered" || !isRecord(value.result.answers)) return undefined;
  const questions = value.request.questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const questionIds = new Set<string>();
  for (const question of questions) {
    if (!isRecord(question) || typeof question.id !== "string" || !question.id.trim()) {
      return undefined;
    }
    const questionId = question.id.trim();
    if (questionIds.has(questionId)) return undefined;
    questionIds.add(questionId);
  }

  const answers: CanonicalAskEvidenceAnswer[] = [];
  for (const [answerKey, rawAnswer] of Object.entries(value.result.answers)) {
    const questionId = answerKey.trim();
    if (!questionIds.has(questionId) || !isRecord(rawAnswer)) return undefined;
    if (
      rawAnswer.questionId !== undefined &&
      (typeof rawAnswer.questionId !== "string" || rawAnswer.questionId.trim() !== questionId)
    ) {
      return undefined;
    }
    if (rawAnswer.values !== undefined && !Array.isArray(rawAnswer.values)) return undefined;
    const values = uniqueStrings(
      (Array.isArray(rawAnswer.values) ? rawAnswer.values : []).flatMap((entry) =>
        typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
      ),
    );
    const customText =
      typeof rawAnswer.customText === "string" && rawAnswer.customText.trim()
        ? rawAnswer.customText.trim()
        : undefined;
    if (values.length === 0 && !customText) continue;
    answers.push({ questionId, values, ...(customText ? { customText } : {}) });
  }
  if (answers.length === 0) return undefined;
  return answers.sort((left, right) => left.questionId.localeCompare(right.questionId));
}

function canonicalAskEvidenceReceiptPath(cwd: string, ref: EvidenceRef): string {
  const filename = `${createHash("sha256").update(ref).digest("hex")}.json`;
  return join(cwd, ".spark", "asks", "evidence-receipts", filename);
}

function parseCanonicalAskEvidenceReceipt(value: unknown): CanonicalAskEvidenceReceipt | undefined {
  if (!isRecord(value) || value.schema !== "spark.ask.evidence-receipt/v1") return undefined;
  if (
    typeof value.evidenceRef !== "string" ||
    !value.evidenceRef.startsWith("evidence:") ||
    typeof value.evidenceHash !== "string" ||
    !value.evidenceHash ||
    typeof value.answersHash !== "string" ||
    !value.answersHash ||
    typeof value.recordedAt !== "string" ||
    !value.recordedAt
  ) {
    return undefined;
  }
  return value as unknown as CanonicalAskEvidenceReceipt;
}

function asEvidenceRef(value: string): EvidenceRef {
  if (!value.startsWith("evidence:") || value.length === "evidence:".length) {
    throw new Error("canonical ask evidence requires an evidence: ref");
  }
  return value as EvidenceRef;
}

function hashAnswers(answers: readonly CanonicalAskEvidenceAnswer[]): string {
  return createHash("sha256").update(JSON.stringify(answers)).digest("hex");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
