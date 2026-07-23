import debug from "debug";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

const log = debug("orchidea:config");

import type { AppConfig } from "../../../../shared/features/config/types";

import { DEFAULT_KEYBINDINGS, type KeybindingAction } from "../../lib/keybindings";
import { client } from "../../orpc";

type KeybindingsConfig = Record<KeybindingAction, string>;

interface ConfigState extends AppConfig {
  loaded: boolean;
  load: () => Promise<void>;
  // Generic setter for any config field
  setConfig: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void;
  // Specialized setters for complex fields
  setKeybinding: (action: KeybindingAction, binding: string) => void;
  resetKeybindings: () => void;
}

const DEFAULT_CONFIG: AppConfig = {
  // General Settings
  theme: "system",
  themeStyle: "default",
  locale: "zh-CN",
  uiMode: "simple",
  forceModelLanguage: true,
  runOnStartup: false,
  multiProjectSupport: false,
  appFontSize: 14,
  terminalFontSize: 12,
  terminalFont: "",
  developerMode: false,

  // Sidebar Settings (multi-project mode)
  sidebarOrganize: "byProject",
  sidebarSortBy: "created",

  // Chat Settings
  sendMessageWith: "enter",
  agentLanguage: "Chinese",
  agentPersonality: "default" as const,
  permissionMode: "default",
  notificationSound: "default",
  tokenOptimization: true,
  networkInspector: false,
  keepAwake: true,
  preWarmSessions: true,
  postToolUseHooks: [],
  customSlashCommands: [],

  // Keybindings
  keybindings: {},

  // Chat view mode
  viewMode: "verbose" as const,

  // Skills
  skillsRegistryUrls: [],

  // HTML
  htmlTemplatesRegistryUrls: [],
  htmlTemplatesMarketZipUrl: "https://example.com/market.zip",
  htmlVercelToken: "",
  htmlVercelTeamSlug: "",
  htmlVercelTeamId: "",
  contentPanelNewTabViewTypes: [],

  // Worktree isolation
  useWorktrees: false,

  // Layout preset
  layoutPreset: "default",

  // OpenClaw Watchdog
  openclawWatchdog: {
    enabled: true,
    agentHeartbeatIntervalMs: 5000,
    agentStallTimeoutMs: 120_000,
    autoRecover: true,
    maxRecoverAttempts: 3,
  },

  voice: {
    captureInput: "system",
    backendPreference: "cloud",
    voiceInputSource: "system",
    cloudGateway: {
      enabled: false,
      baseUrl: "",
    },
    aliyunIsi: {
      enabled: false,
      region: "cn-shanghai",
      appKey: "",
      token: "",
      asr: {
        sampleRate: 16000,
        enableIntermediateResult: true,
        enablePunctuationPrediction: true,
        enableInverseTextNormalization: true,
      },
      tts: {
        voice: "xiaoyun",
        sampleRate: 16000,
        volume: 50,
        speechRate: 0,
        pitchRate: 0,
        enableSubtitle: false,
        enablePhonemeTimestamp: false,
      },
    },
    mode: "dualChat",
    dualAsrWsUrl: "ws://localhost:8000/api/stream",
    dualAsrParamsJson: JSON.stringify(
      {
        sendMode: "binary",
        startMessage: { client_id: "orchidea", hotwords: "" },
        resetMessage: { type: "end" },
        resultTextField: "text",
        resultFinalField: "type",
        startPerUtterance: false,
        closeOnReset: true,
      },
      null,
      2,
    ),
    meetingAsrWsUrl: "ws://localhost:10095",
    meetingAsrParamsJson: JSON.stringify(
      {
        sendMode: "binary",
        startPerUtterance: true,
        startMessage: {
          mode: "2pass",
          chunk_size: [5, 10, 5],
          chunk_interval: 10,
          encoder_chunk_look_back: 4,
          decoder_chunk_look_back: 0,
          audio_fs: 16000,
          wav_name: "meeting",
          wav_format: "pcm",
          is_speaking: true,
          hotwords: "",
          itn: true,
        },
        resetMessage: { is_speaking: false },
        resultTextField: "text",
        resultFinalField: "is_final",
        userIdField: "spk_name",
      },
      null,
      2,
    ),
    ttsUrl: "",
    ttsParamsJson: JSON.stringify(
      {
        textField: "input",
        responseFormat: "pcm_s16le",
        sampleRate: 24000,
        payload: { model: "tts-1", voice: "af_sky", stream: true, response_format: "pcm" },
      },
      null,
      2,
    ),
    localTtsModelId: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    localTtsSpeaker: "Vivian",
    localTtsLanguage: "Auto",
    localTtsInstruct: "",
    localTtsOffline: false,
    speakerStylesJson: JSON.stringify({}, null, 2),
    voiceprintEnabled: false,
    voiceprintParamsJson: JSON.stringify(
      {
        diarization: true,
        spkField: "spk_name",
        scoreField: "spk_score",
      },
      null,
      2,
    ),
    asrEngine: "remote",
    funasrModel: "iic/SenseVoiceSmall",
    funasrDevice: "cpu",
  },

  computerControl: {
    enabled: false,
  },
};

export const useConfigStore = create<ConfigState>()(
  immer((set, get) => ({
    ...DEFAULT_CONFIG,
    loaded: false,

    load: async () => {
      log("loading config");
      const config = await client.config.get();
      log("config loaded", config);
      set((state) => {
        Object.assign(state, config);
        state.loaded = true;
      });
    },

    // Generic setter - handles persistence automatically
    setConfig: (key, value) => {
      log("setConfig: key=%s", key, value);
      client.config.set({ key, value } as any).catch(() => {});
      set({ [key]: value } as any);
    },

    // Specialized setter for keybindings (nested object)
    setKeybinding: (action, binding) => {
      log("setKeybinding: action=%s binding=%s", action, binding);
      set((state) => {
        state.keybindings[action] = binding;
      });
      client.config.set({ key: "keybindings", value: get().keybindings }).catch(() => {});
    },

    resetKeybindings: () => {
      log("resetKeybindings");
      const keybindings = { ...DEFAULT_KEYBINDINGS } as KeybindingsConfig;
      client.config.set({ key: "keybindings", value: keybindings }).catch(() => {});
      set({ keybindings });
    },
  })),
);

// Convenience hooks for common config fields
export const useLocale = () => useConfigStore((s) => s.locale);
