import { z } from "zod";
import { isoDateTimeSchema, prefixedIdSchema } from "../refs.js";
import { runtimeFeatureSchema, runtimeProtocolVersionSchema } from "./envelope.js";

export const runtimeWorkspaceRegistrationDetailsSchema = z.object({
  localWorkspaceKey: z.string().min(1),
  displayName: z.string().min(1),
  workspaceName: z.string().min(1).optional(),
  workspaceSlug: z.string().min(1).optional(),
});

export const runtimeRegistrationRequestSchema = z.object({
  installationId: z.string().min(1),
  displayName: z.string().min(1),
  runtimeVersion: z.string().min(1),
  supportedFeatures: z.array(runtimeFeatureSchema).default([]),
  labels: z.record(z.string(), z.string()).default({}),
  workspaceRegistration: runtimeWorkspaceRegistrationDetailsSchema.optional(),
});

export const runtimeWorkspaceRegistrationBindingSchema = z.object({
  workspaceId: prefixedIdSchema("ws"),
  bindingId: prefixedIdSchema("rtwb"),
  localWorkspaceKey: z.string().min(1),
  displayName: z.string().min(1),
  status: z.enum(["available", "indexing", "degraded", "unavailable", "archived"]),
});

export const runtimeRegistrationResponseSchema = z.object({
  runtimeId: prefixedIdSchema("rt"),
  runtimeToken: z.string().min(32),
  runtimeTokenExpiresAt: isoDateTimeSchema,
  refreshToken: z.string().min(32),
  refreshTokenExpiresAt: isoDateTimeSchema,
  protocolVersion: runtimeProtocolVersionSchema,
  webSocketUrl: z.string().min(1),
  heartbeatIntervalMs: z.literal(15_000),
  staleAfterMs: z.literal(45_000),
  registeredAt: isoDateTimeSchema,
  workspaceBinding: runtimeWorkspaceRegistrationBindingSchema.optional(),
});

export const runtimeWorkspaceRegistrationRequestSchema = z.object({
  registrationToken: z.string().min(1),
  workspaceRegistration: runtimeWorkspaceRegistrationDetailsSchema,
});

export const runtimeWorkspaceRegistrationResponseSchema = z.object({
  runtimeId: prefixedIdSchema("rt"),
  registeredAt: isoDateTimeSchema,
  workspaceBinding: runtimeWorkspaceRegistrationBindingSchema,
});

export const runtimeTokenRefreshRequestSchema = z.object({
  refreshToken: z.string().min(32),
});

export const runtimeTokenRefreshResponseSchema = z.object({
  runtimeId: prefixedIdSchema("rt"),
  runtimeToken: z.string().min(32),
  runtimeTokenExpiresAt: isoDateTimeSchema,
  refreshToken: z.string().min(32),
  refreshTokenExpiresAt: isoDateTimeSchema,
  refreshedAt: isoDateTimeSchema,
});

export type RuntimeRegistrationRequest = z.infer<typeof runtimeRegistrationRequestSchema>;
export type RuntimeRegistrationResponse = z.infer<typeof runtimeRegistrationResponseSchema>;
export type RuntimeWorkspaceRegistrationRequest = z.infer<
  typeof runtimeWorkspaceRegistrationRequestSchema
>;
export type RuntimeWorkspaceRegistrationResponse = z.infer<
  typeof runtimeWorkspaceRegistrationResponseSchema
>;
export type RuntimeTokenRefreshRequest = z.infer<typeof runtimeTokenRefreshRequestSchema>;
export type RuntimeTokenRefreshResponse = z.infer<typeof runtimeTokenRefreshResponseSchema>;
