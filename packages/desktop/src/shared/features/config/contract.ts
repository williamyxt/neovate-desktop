import { oc, type } from "@orpc/contract";
import { z } from "zod";

import type { AppConfig } from "./types";

// Value schemas for each key
const themeValueSchema = z.enum(["system", "light", "dark"]);
const themeStyleValueSchema = z.enum(["default", "claude", "codex", "nord"]);
const sendMessageWithValueSchema = z.enum(["enter", "cmdEnter"]);
const appFontSizeValueSchema = z.number().min(12).max(20);
const terminalFontSizeValueSchema = z.number().min(8).max(32);
const terminalFontValueSchema = z.string();
const booleanValueSchema = z.boolean();
const localeValueSchema = z.enum(["system", "en-US", "zh-CN"]);
const uiModeValueSchema = z.enum(["full", "simple"]);
const keybindingsValueSchema = z.record(z.string(), z.string());
const permissionModeValueSchema = z.enum(["default", "acceptEdits", "bypassPermissions"]);
const notificationSoundValueSchema = z.enum(["off", "default", "Glass", "Ping", "Pop", "Funk"]);
const agentLanguageValueSchema = z.enum([
  "English",
  "Chinese",
  "Japanese",
  "Korean",
  "Spanish",
  "French",
]);
const agentPersonalityValueSchema = z.enum([
  "default",
  "concise",
  "detailed",
  "code-first",
  "architect",
]);
const sidebarOrganizeValueSchema = z.enum(["byProject", "chronological"]);
const sidebarSortByValueSchema = z.enum(["created", "updated"]);
const urlOrEmptyValueSchema = z.string();
const stringValueSchema = z.string();
const postToolUseHooksValueSchema = z.array(
  z.object({
    pattern: z.string(),
    command: z.string(),
    enabled: z.boolean(),
  }),
);
const customSlashCommandsValueSchema = z.array(
  z.object({
    name: z.string(),
    description: z.string().optional(),
    argumentHint: z.string().optional(),
    prompt: z.string(),
    enabled: z.boolean(),
  }),
);
const voiceCaptureInputValueSchema = z.enum(["system", "xvf3800", "cb08"]);
const voiceBackendPreferenceValueSchema = z.enum(["auto", "local", "cloud"]);
const voiceCloudGatewayValueSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string(),
});
const aliyunIsiAsrValueSchema = z.object({
  sampleRate: z.union([z.literal(8000), z.literal(16000)]),
  enableIntermediateResult: z.boolean(),
  enablePunctuationPrediction: z.boolean(),
  enableInverseTextNormalization: z.boolean(),
});
const aliyunIsiTtsValueSchema = z.object({
  voice: z.string(),
  sampleRate: z.union([z.literal(8000), z.literal(16000)]),
  volume: z.number(),
  speechRate: z.number(),
  pitchRate: z.number(),
  enableSubtitle: z.boolean(),
  enablePhonemeTimestamp: z.boolean(),
});
const voiceAliyunIsiValueSchema = z.object({
  enabled: z.boolean(),
  region: z.enum(["cn-shanghai", "cn-beijing"]),
  appKey: z.string(),
  token: z.string(),
  asr: aliyunIsiAsrValueSchema,
  tts: aliyunIsiTtsValueSchema,
});
const voiceValueSchema = z.object({
  captureInput: voiceCaptureInputValueSchema,
  backendPreference: voiceBackendPreferenceValueSchema.default("cloud"),
  cloudGateway: voiceCloudGatewayValueSchema,
  aliyunIsi: voiceAliyunIsiValueSchema,
  mode: z.enum(["dualChat", "meeting"]),
  dualAsrWsUrl: z.string(),
  dualAsrParamsJson: z.string(),
  meetingAsrWsUrl: z.string(),
  meetingAsrParamsJson: z.string(),
  ttsUrl: z.string(),
  ttsParamsJson: z.string(),
  localTtsModelId: z.string(),
  localTtsSpeaker: z.string(),
  localTtsLanguage: z.string(),
  localTtsInstruct: z.string(),
  localTtsOffline: z.boolean(),
  speakerStylesJson: z.string(),
  voiceprintEnabled: z.boolean(),
  voiceprintParamsJson: z.string(),
  asrEngine: z.enum(["remote", "funasr"]).default("remote"),
  funasrModel: z.string().default("iic/SenseVoiceSmall"),
  funasrDevice: z.string().default("cpu"),
  voiceInputSource: z.enum(["auto", "system", "local"]).default("system"),
});
const computerControlValueSchema = z.object({
  enabled: z.boolean(),
});

export const configContract = {
  get: oc.output(type<AppConfig>()),

  getGlobalModelSelection: oc.output(type<{ providerId?: string; model?: string }>()),

  setGlobalModelSelection: oc
    .input(
      z.object({
        providerId: z.string().nullable(),
        model: z.string().nullable(),
      }),
    )
    .output(type<void>()),

  set: oc
    .input(
      z.union([
        z.object({ key: z.literal("theme"), value: themeValueSchema }),
        z.object({ key: z.literal("themeStyle"), value: themeStyleValueSchema }),
        z.object({ key: z.literal("locale"), value: localeValueSchema }),
        z.object({ key: z.literal("uiMode"), value: uiModeValueSchema }),
        z.object({ key: z.literal("forceModelLanguage"), value: booleanValueSchema }),
        z.object({ key: z.literal("runOnStartup"), value: booleanValueSchema }),
        z.object({ key: z.literal("multiProjectSupport"), value: booleanValueSchema }),
        z.object({ key: z.literal("appFontSize"), value: appFontSizeValueSchema }),
        z.object({ key: z.literal("terminalFontSize"), value: terminalFontSizeValueSchema }),
        z.object({ key: z.literal("terminalFont"), value: terminalFontValueSchema }),
        z.object({ key: z.literal("developerMode"), value: booleanValueSchema }),
        z.object({ key: z.literal("sendMessageWith"), value: sendMessageWithValueSchema }),
        z.object({ key: z.literal("agentLanguage"), value: agentLanguageValueSchema }),
        z.object({ key: z.literal("agentPersonality"), value: agentPersonalityValueSchema }),
        z.object({ key: z.literal("permissionMode"), value: permissionModeValueSchema }),
        z.object({ key: z.literal("notificationSound"), value: notificationSoundValueSchema }),
        z.object({ key: z.literal("keybindings"), value: keybindingsValueSchema }),
        z.object({ key: z.literal("sidebarOrganize"), value: sidebarOrganizeValueSchema }),
        z.object({ key: z.literal("tokenOptimization"), value: booleanValueSchema }),
        z.object({ key: z.literal("postToolUseHooks"), value: postToolUseHooksValueSchema }),
        z.object({ key: z.literal("networkInspector"), value: booleanValueSchema }),
        z.object({ key: z.literal("keepAwake"), value: booleanValueSchema }),
        z.object({ key: z.literal("preWarmSessions"), value: booleanValueSchema }),
        z.object({ key: z.literal("sidebarSortBy"), value: sidebarSortByValueSchema }),
        z.object({
          key: z.literal("skillsRegistryUrls"),
          value: z.array(z.string().url()),
        }),
        z.object({
          key: z.literal("htmlTemplatesMarketZipUrl"),
          value: urlOrEmptyValueSchema,
        }),
        z.object({
          key: z.literal("htmlVercelToken"),
          value: stringValueSchema,
        }),
        z.object({
          key: z.literal("htmlVercelTeamSlug"),
          value: stringValueSchema,
        }),
        z.object({
          key: z.literal("htmlVercelTeamId"),
          value: stringValueSchema,
        }),
        z.object({
          key: z.literal("voice"),
          value: voiceValueSchema,
        }),
        z.object({
          key: z.literal("computerControl"),
          value: computerControlValueSchema,
        }),
        z.object({
          key: z.literal("customSlashCommands"),
          value: customSlashCommandsValueSchema,
        }),
        z.object({ key: z.literal("uiMode"), value: uiModeValueSchema }),
        z.object({ key: z.literal("forceModelLanguage"), value: booleanValueSchema }),
        z.object({
          key: z.literal("budgetLimitUsd"),
          value: z.number().min(0),
        }),
      ]),
    )
    .output(type<void>()),
};
