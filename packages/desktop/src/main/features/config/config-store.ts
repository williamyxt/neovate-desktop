import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import debug from "debug";
import { safeStorage } from "electron";
import Store from "electron-store";

import type { AppConfig } from "../../../shared/features/config/types";
import type {
  OpenClawChannels,
  OpenClawInstancesRegistry,
} from "../../../shared/features/openclaw/types";
import type { ModelTestResult, Provider } from "../../../shared/features/provider/types";
import type { AcpAgentCommand } from "../acp/acp-connection-manager";

import {
  OpenClawChannelsSchema,
  OpenClawDingtalkChannelSchema,
  OpenClawFeishuChannelSchema,
  OpenClawWecomChannelSchema,
} from "../../../shared/types/zod/openclaw/channels";
import {
  OpenClawInstanceConfigSchema,
  OpenClawInstancesRegistrySchema,
} from "../../../shared/types/zod/openclaw/instances";
import { APP_DATA_DIR } from "../../core/app-paths";

const log = debug("orchidea:config-store");

export interface PostToolUseHookEntry {
  /** Tool name pattern (regex). Use "*" for all tools. */
  pattern: string;
  /** Shell command to execute. Receives JSON input via stdin: { toolName, input, output, durationMs } */
  command: string;
  /** Whether this hook is enabled */
  enabled: boolean;
}

type ConfigStoreSchema = AppConfig & {
  providers: Provider[];
  provider?: string;
  model?: string;
  providerModelTestResults?: Record<string, ModelTestResult>;
  mcpServers?: Record<string, McpServerConfig>;
  acpAgentCommands?: Record<string, AcpAgentCommand>;
  openclawDefaultAcpAgentId?: string;
  openclawChannels?: OpenClawChannels;
  openclawInstances?: OpenClawInstancesRegistry;
  openclawConfig?: Record<string, unknown>;
  openclawCron?: unknown;
  openclawSkillWorkshop?: unknown;
  openclawDreaming?: unknown;
  openclawDebug?: unknown;
  openclawWatchdog?: unknown;
  postToolUseHooks?: PostToolUseHookEntry[];
};

const DEFAULT_APP_CONFIG: AppConfig = {
  // General Settings
  theme: "system",
  themeStyle: "default",
  locale: "zh-CN",
  uiMode: "simple",
  forceModelLanguage: true,
  runOnStartup: false,
  multiProjectSupport: false,
  appFontSize: 15,
  terminalFontSize: 12,
  terminalFont: "",
  developerMode: false,

  // Sidebar Settings (multi-project mode)
  sidebarOrganize: "byProject",
  sidebarSortBy: "created",

  // Chat Settings
  sendMessageWith: "enter",
  agentLanguage: "Chinese",
  agentPersonality: "default",
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

  openclawWatchdog: {
    enabled: true,
    agentHeartbeatIntervalMs: 5000,
    agentStallTimeoutMs: 120_000,
    autoRecover: true,
    maxRecoverAttempts: 3,
  },

  contextEditing: true,
  contextEditingThreshold: 0.7,

  useWorktrees: false,

  layoutPreset: "default",

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
    dualAsrWsUrl: "http://localhost:8000",
    dualAsrParamsJson: JSON.stringify(
      {
        model: "Qwen3-ASR-1.7B",
        language: "Chinese",
        return_time_stamps: false,
        resultTextField: "text",
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
    localTtsOffline: true,
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
  // Budget / Cost (0 = disabled)
  budgetLimitUsd: 0,
};

const STORE_DEFAULTS: ConfigStoreSchema = {
  ...DEFAULT_APP_CONFIG,
  providers: [],
  providerModelTestResults: {},
  mcpServers: {},
  acpAgentCommands: {},
  openclawDefaultAcpAgentId: "",
  openclawChannels: {},
  openclawInstances: {},
  openclawConfig: {},
  openclawCron: { enabled: false, jobs: {}, runs: [] },
  openclawSkillWorkshop: { mode: "board", queueWidth: 360, selectedKey: "", proposals: {} },
  openclawDreaming: {
    enabled: false,
    dreamingOf: "",
    promotedCount: 0,
    lastRunAtMs: null,
    activeUntilMs: null,
    statusMessage: null,
    phases: {
      light: { enabled: true, cron: "0 * * * *", nextRunAtMs: null },
      deep: { enabled: false, cron: "0 2 * * *", nextRunAtMs: null },
      rem: { enabled: false, cron: "0 4 * * *", nextRunAtMs: null },
    },
  },
  openclawDebug: { eventLog: [] },
  openclawWatchdog: null,
};

export class ConfigStore {
  private store: Store<ConfigStoreSchema>;

  constructor() {
    this.store = new Store<ConfigStoreSchema>({
      name: "config",
      cwd: APP_DATA_DIR,
      defaults: STORE_DEFAULTS,
      serialize: (value) => JSON.stringify(value, null, 2) + "\n",
    });
  }

  getAll(): AppConfig {
    const { providers, provider, model, ...config } = this.store.store;
    const voice: any = {
      ...DEFAULT_APP_CONFIG.voice,
      ...(config.voice ?? {}),
    };
    if (voice?.aliyunIsi?.token) {
      voice.aliyunIsi.token = this._decryptVoiceSecret(voice.aliyunIsi);
    }
    return { ...DEFAULT_APP_CONFIG, ...config, voice };
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.store.get(key);
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    if (key === "voice" && value && typeof value === "object") {
      const v: any = { ...(value as any) };
      if (v?.aliyunIsi && typeof v.aliyunIsi === "object") {
        const token = String(v.aliyunIsi.token ?? "");
        if (token) {
          const encrypted = this._encryptVoiceSecret(token);
          v.aliyunIsi = {
            ...v.aliyunIsi,
            token: encrypted.encrypted,
            _tokenEncrypted: encrypted.marker,
          };
        }
      }
      this.store.set(key, v);
      return;
    }
    this.store.set(key, value);
  }

  onChange<K extends keyof AppConfig>(key: K, cb: (newValue: AppConfig[K]) => void): () => void {
    return this.store.onDidChange(key, (newValue) => {
      cb(newValue as AppConfig[K]);
    });
  }

  getMcpServers(): Record<string, McpServerConfig> {
    return (this.store.get("mcpServers" as keyof ConfigStoreSchema) as any) ?? {};
  }

  setMcpServers(servers: Record<string, McpServerConfig>): void {
    this.store.set("mcpServers" as keyof ConfigStoreSchema, servers as any);
  }

  setMcpServer(name: string, config: McpServerConfig): void {
    const key = String(name ?? "").trim();
    if (!key) throw new Error("mcp_server_name_required");
    const servers = { ...this.getMcpServers(), [key]: config };
    this.setMcpServers(servers);
  }

  removeMcpServer(name: string): void {
    const key = String(name ?? "").trim();
    if (!key) return;
    const servers = { ...this.getMcpServers() };
    delete servers[key];
    this.setMcpServers(servers);
  }

  getAcpAgentCommands(): Record<string, AcpAgentCommand> {
    return (this.store.get("acpAgentCommands" as keyof ConfigStoreSchema) as any) ?? {};
  }

  setAcpAgentCommands(cmds: Record<string, AcpAgentCommand>): void {
    this.store.set("acpAgentCommands" as keyof ConfigStoreSchema, cmds as any);
  }

  setAcpAgentCommand(agentId: string, cmd: AcpAgentCommand): void {
    const key = String(agentId ?? "").trim();
    if (!key) throw new Error("acp_agent_id_required");
    const next = { ...this.getAcpAgentCommands(), [key]: cmd };
    this.setAcpAgentCommands(next);
  }

  removeAcpAgentCommand(agentId: string): void {
    const key = String(agentId ?? "").trim();
    if (!key) return;
    const next = { ...this.getAcpAgentCommands() };
    delete next[key];
    this.setAcpAgentCommands(next);
  }

  getOpenClawChannels(): OpenClawChannels {
    const raw = (this.store.get("openclawChannels" as keyof ConfigStoreSchema) as any) ?? {};
    const parsed = OpenClawChannelsSchema.safeParse(raw);
    if (!parsed.success) {
      log("openclawChannels.invalid", parsed.error.issues);
      const cleaned: Record<string, unknown> =
        raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as any) } : {};

      const wecom = OpenClawWecomChannelSchema.safeParse((cleaned as any).wecom);
      if (wecom.success) (cleaned as any).wecom = wecom.data;
      else delete (cleaned as any).wecom;

      const dingtalk = OpenClawDingtalkChannelSchema.safeParse((cleaned as any).dingtalk);
      if (dingtalk.success) (cleaned as any).dingtalk = dingtalk.data;
      else delete (cleaned as any).dingtalk;

      const feishu = OpenClawFeishuChannelSchema.safeParse((cleaned as any).feishu);
      if (feishu.success) (cleaned as any).feishu = feishu.data;
      else delete (cleaned as any).feishu;

      return cleaned as any;
    }
    return parsed.data;
  }

  setOpenClawChannels(channels: OpenClawChannels): void {
    this.store.set("openclawChannels" as keyof ConfigStoreSchema, channels as any);
  }

  setOpenClawChannel(id: string, config: unknown): void {
    const key = String(id ?? "").trim();
    if (!key) throw new Error("openclaw_channel_id_required");
    const parsedConfig =
      key === "wecom"
        ? OpenClawWecomChannelSchema.safeParse(config)
        : key === "dingtalk"
          ? OpenClawDingtalkChannelSchema.safeParse(config)
          : key === "feishu"
            ? OpenClawFeishuChannelSchema.safeParse(config)
            : null;
    if (parsedConfig && !parsedConfig.success) throw new Error("openclaw_channel_config_invalid");
    if (!parsedConfig && (config === null || typeof config !== "object" || Array.isArray(config))) {
      throw new Error("openclaw_channel_config_object_required");
    }

    const next = {
      ...this.getOpenClawChannels(),
      [key]: parsedConfig ? parsedConfig.data : (config as any),
    };
    this.setOpenClawChannels(next);
  }

  removeOpenClawChannel(id: string): void {
    const key = String(id ?? "").trim();
    if (!key) return;
    const next = { ...this.getOpenClawChannels() };
    delete next[key];
    this.setOpenClawChannels(next);
  }

  getOpenClawInstances(): OpenClawInstancesRegistry {
    const raw = (this.store.get("openclawInstances" as keyof ConfigStoreSchema) as any) ?? {};
    const parsed = OpenClawInstancesRegistrySchema.safeParse(raw);
    if (!parsed.success) {
      log("openclawInstances.invalid", parsed.error.issues);
      const cleaned: Record<string, unknown> =
        raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as any) } : {};
      for (const [k, v] of Object.entries(cleaned)) {
        const parsedItem = OpenClawInstanceConfigSchema.safeParse(v);
        if (parsedItem.success) (cleaned as any)[k] = parsedItem.data;
        else delete (cleaned as any)[k];
      }
      return cleaned as any;
    }
    return parsed.data;
  }

  setOpenClawInstances(registry: OpenClawInstancesRegistry): void {
    this.store.set("openclawInstances" as keyof ConfigStoreSchema, registry as any);
  }

  setOpenClawInstance(id: string, config: unknown): void {
    const key = String(id ?? "").trim();
    if (!key) throw new Error("openclaw_instance_id_required");
    const parsedConfig = OpenClawInstanceConfigSchema.safeParse(config);
    if (!parsedConfig.success) throw new Error("openclaw_instance_config_invalid");
    const next = { ...this.getOpenClawInstances(), [key]: parsedConfig.data };
    this.setOpenClawInstances(next);
  }

  removeOpenClawInstance(id: string): void {
    const key = String(id ?? "").trim();
    if (!key) return;
    const next = { ...this.getOpenClawInstances() };
    delete next[key];
    this.setOpenClawInstances(next);
  }

  getOpenClawConfig(): Record<string, unknown> {
    return (this.store.get("openclawConfig" as keyof ConfigStoreSchema) as any) ?? {};
  }

  setOpenClawConfig(config: Record<string, unknown>): void {
    this.store.set("openclawConfig" as keyof ConfigStoreSchema, config as any);
  }

  getOpenClawDefaultAcpAgentId(): string | null {
    const raw =
      (this.store.get("openclawDefaultAcpAgentId" as keyof ConfigStoreSchema) as any) ?? "";
    const value = String(raw).trim();
    return value ? value : null;
  }

  setOpenClawDefaultAcpAgentId(agentId: string | null): void {
    const value = agentId ? String(agentId).trim() : "";
    this.store.set("openclawDefaultAcpAgentId" as keyof ConfigStoreSchema, value as any);
  }

  getOpenClawCron(): { enabled: boolean; jobs: Record<string, unknown>; runs: unknown[] } {
    const raw = (this.store.get("openclawCron" as keyof ConfigStoreSchema) as any) ?? null;
    const enabled = Boolean(raw?.enabled);
    const jobs =
      raw?.jobs && typeof raw.jobs === "object" && !Array.isArray(raw.jobs) ? raw.jobs : {};
    const runs = Array.isArray(raw?.runs) ? raw.runs : [];
    return { enabled, jobs, runs };
  }

  setOpenClawCron(next: {
    enabled: boolean;
    jobs: Record<string, unknown>;
    runs: unknown[];
  }): void {
    this.store.set("openclawCron" as keyof ConfigStoreSchema, next as any);
  }

  getOpenClawSkillWorkshop(): {
    mode: "board" | "today";
    queueWidth: number;
    selectedKey: string | null;
    proposals: Record<string, unknown>;
  } {
    const raw = (this.store.get("openclawSkillWorkshop" as keyof ConfigStoreSchema) as any) ?? null;
    const mode = raw?.mode === "today" ? "today" : "board";
    const queueWidth = Math.max(200, Math.min(800, Number(raw?.queueWidth) || 360));
    const selectedKey = String(raw?.selectedKey ?? "").trim() || null;
    const proposals =
      raw?.proposals && typeof raw.proposals === "object" && !Array.isArray(raw.proposals)
        ? raw.proposals
        : {};
    return { mode, queueWidth, selectedKey, proposals };
  }

  setOpenClawSkillWorkshop(next: {
    mode: "board" | "today";
    queueWidth: number;
    selectedKey: string | null;
    proposals: Record<string, unknown>;
  }): void {
    const normalized = {
      mode: next.mode === "today" ? "today" : "board",
      queueWidth: Math.max(200, Math.min(800, Number(next.queueWidth) || 360)),
      selectedKey: next.selectedKey ?? "",
      proposals: next.proposals ?? {},
    };
    this.store.set("openclawSkillWorkshop" as keyof ConfigStoreSchema, normalized as any);
  }

  getOpenClawDreaming(): {
    enabled: boolean;
    dreamingOf: string | null;
    promotedCount: number;
    lastRunAtMs: number | null;
    activeUntilMs: number | null;
    statusMessage: string | null;
    phases: {
      light: { enabled: boolean; cron: string; nextRunAtMs: number | null };
      deep: { enabled: boolean; cron: string; nextRunAtMs: number | null };
      rem: { enabled: boolean; cron: string; nextRunAtMs: number | null };
    };
  } {
    const raw = (this.store.get("openclawDreaming" as keyof ConfigStoreSchema) as any) ?? null;
    const phasesRaw =
      raw?.phases && typeof raw.phases === "object" && !Array.isArray(raw.phases) ? raw.phases : {};
    const normalizePhase = (key: "light" | "deep" | "rem") => {
      const p = (phasesRaw as any)?.[key] ?? null;
      const cron =
        String(p?.cron ?? "").trim() ||
        (key === "light" ? "0 * * * *" : key === "deep" ? "0 2 * * *" : "0 4 * * *");
      const nextRunAtMs = typeof p?.nextRunAtMs === "number" ? p.nextRunAtMs : null;
      return { enabled: Boolean(p?.enabled ?? key === "light"), cron, nextRunAtMs };
    };
    const enabled = Boolean(raw?.enabled);
    const dreamingOf = String(raw?.dreamingOf ?? "").trim() || null;
    const promotedCount = Math.max(0, Number(raw?.promotedCount) || 0);
    const lastRunAtMs = typeof raw?.lastRunAtMs === "number" ? raw.lastRunAtMs : null;
    const activeUntilMs = typeof raw?.activeUntilMs === "number" ? raw.activeUntilMs : null;
    const statusMessage = raw?.statusMessage ? String(raw.statusMessage) : null;
    return {
      enabled,
      dreamingOf,
      promotedCount,
      lastRunAtMs,
      activeUntilMs,
      statusMessage,
      phases: {
        light: normalizePhase("light"),
        deep: normalizePhase("deep"),
        rem: normalizePhase("rem"),
      },
    };
  }

  setOpenClawDreaming(next: {
    enabled: boolean;
    dreamingOf: string | null;
    promotedCount: number;
    lastRunAtMs: number | null;
    activeUntilMs: number | null;
    statusMessage: string | null;
    phases: {
      light: { enabled: boolean; cron: string; nextRunAtMs: number | null };
      deep: { enabled: boolean; cron: string; nextRunAtMs: number | null };
      rem: { enabled: boolean; cron: string; nextRunAtMs: number | null };
    };
  }): void {
    const normalizePhase = (
      p: { enabled: boolean; cron: string; nextRunAtMs: number | null },
      key: "light" | "deep" | "rem",
    ) => {
      const cron =
        String(p?.cron ?? "").trim() ||
        (key === "light" ? "0 * * * *" : key === "deep" ? "0 2 * * *" : "0 4 * * *");
      return {
        enabled: Boolean(p?.enabled),
        cron,
        nextRunAtMs: typeof p?.nextRunAtMs === "number" ? p.nextRunAtMs : null,
      };
    };
    const normalized = {
      enabled: Boolean(next.enabled),
      dreamingOf: next.dreamingOf ? String(next.dreamingOf).trim() : "",
      promotedCount: Math.max(0, Number(next.promotedCount) || 0),
      lastRunAtMs: typeof next.lastRunAtMs === "number" ? next.lastRunAtMs : null,
      activeUntilMs: typeof next.activeUntilMs === "number" ? next.activeUntilMs : null,
      statusMessage: next.statusMessage ? String(next.statusMessage) : null,
      phases: {
        light: normalizePhase(next.phases.light, "light"),
        deep: normalizePhase(next.phases.deep, "deep"),
        rem: normalizePhase(next.phases.rem, "rem"),
      },
    };
    this.store.set("openclawDreaming" as keyof ConfigStoreSchema, normalized as any);
  }

  getOpenClawDebug(): {
    eventLog: Array<{ event: string; tsMs: number; payload: unknown }>;
  } {
    const raw = (this.store.get("openclawDebug" as keyof ConfigStoreSchema) as any) ?? null;
    const log = Array.isArray(raw?.eventLog) ? raw.eventLog : [];
    const eventLog = log
      .filter((x: any) => x && typeof x === "object")
      .map((x: any) => ({
        event: String(x.event ?? ""),
        tsMs: typeof x.tsMs === "number" ? x.tsMs : 0,
        payload: x.payload,
      }))
      .filter((x) => Boolean(x.event))
      .slice(0, 200);
    return { eventLog };
  }

  appendOpenClawDebugEvent(entry: { event: string; tsMs: number; payload: unknown }): void {
    const current = this.getOpenClawDebug();
    const next = [
      {
        event: String(entry.event),
        tsMs: Number(entry.tsMs) || Date.now(),
        payload: entry.payload,
      },
      ...current.eventLog,
    ].slice(0, 200);
    this.store.set("openclawDebug" as keyof ConfigStoreSchema, { eventLog: next } as any);
  }

  clearOpenClawDebugEvents(): void {
    this.store.set("openclawDebug" as keyof ConfigStoreSchema, { eventLog: [] } as any);
  }

  getOpenClawWatchdog(): { lastCheckAtMs: number | null; stalledAgents: Record<string, any> } {
    const raw = (this.store.get("openclawWatchdog" as keyof ConfigStoreSchema) as any) ?? null;
    return {
      lastCheckAtMs: typeof raw?.lastCheckAtMs === "number" ? raw.lastCheckAtMs : null,
      stalledAgents:
        raw?.stalledAgents && typeof raw.stalledAgents === "object" ? raw.stalledAgents : {},
    };
  }

  setOpenClawWatchdog(value: {
    lastCheckAtMs: number | null;
    stalledAgents: Record<string, any>;
  }): void {
    this.store.set("openclawWatchdog" as keyof ConfigStoreSchema, value as any);
  }

  // --- Encryption helpers ---

  private _encryptApiKey(plaintext: string): { encrypted: string; marker: boolean } {
    if (!safeStorage.isEncryptionAvailable()) {
      return { encrypted: plaintext, marker: false };
    }
    try {
      const buf = safeStorage.encryptString(plaintext);
      return { encrypted: buf.toString("base64"), marker: true };
    } catch {
      return { encrypted: plaintext, marker: false };
    }
  }

  private _decryptApiKey(provider: any): string {
    const key = provider?.apiKey ?? "";
    if (!key) return "";
    if (provider._apiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(key, "base64"));
      } catch {
        // fall through — return as-is (possibly legacy plaintext)
      }
    }
    // Legacy plaintext key — migrate on next write
    return key;
  }

  private _encryptVoiceSecret(plaintext: string): { encrypted: string; marker: boolean } {
    if (!safeStorage.isEncryptionAvailable()) {
      return { encrypted: plaintext, marker: false };
    }
    try {
      const buf = safeStorage.encryptString(plaintext);
      return { encrypted: buf.toString("base64"), marker: true };
    } catch {
      return { encrypted: plaintext, marker: false };
    }
  }

  private _decryptVoiceSecret(aliyunIsi: any): string {
    const token = aliyunIsi?.token ?? "";
    if (!token) return "";
    if (aliyunIsi?._tokenEncrypted && safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(String(token), "base64"));
      } catch {}
    }
    return String(token);
  }

  // --- Provider methods ---

  getProviders(): Provider[] {
    const providers = (this.store.get("providers") as any[]) ?? [];
    return providers.map((p: any) => ({
      ...p,
      apiKey: this._decryptApiKey(p),
    }));
  }

  getProviderModelTestResults(): Record<string, ModelTestResult> {
    return (this.store.get("providerModelTestResults" as keyof ConfigStoreSchema) as any) ?? {};
  }

  mergeProviderModelTestResults(results: Record<string, ModelTestResult>): number {
    const current = { ...this.getProviderModelTestResults() };
    for (const [k, v] of Object.entries(results)) {
      current[k] = v;
    }
    this.store.set("providerModelTestResults" as keyof ConfigStoreSchema, current as any);
    return Object.keys(results).length;
  }

  clearProviderModelTestResults(baseURL: string): number {
    const prefix = `${String(baseURL ?? "").trim()}:`;
    if (prefix === ":") return 0;
    const current = { ...this.getProviderModelTestResults() };
    let count = 0;
    for (const k of Object.keys(current)) {
      if (k.startsWith(prefix)) {
        delete current[k];
        count += 1;
      }
    }
    this.store.set("providerModelTestResults" as keyof ConfigStoreSchema, current as any);
    return count;
  }

  getProvider(id: string): Provider | undefined {
    return this.getProviders().find((p) => p.id === id);
  }

  addProvider(provider: Provider): void {
    const encrypted = this._encryptApiKey(provider.apiKey);
    const stored: any = {
      ...provider,
      apiKey: encrypted.encrypted,
      _apiKeyEncrypted: encrypted.marker,
    };
    const providers = (this.store.get("providers") as any[]) ?? [];
    providers.push(stored);
    this.store.set("providers", providers);
    log(
      "addProvider: id=%s name=%s baseURL=%s encrypted=%s",
      provider.id,
      provider.name,
      provider.baseURL,
      encrypted.marker,
    );
  }

  updateProvider(id: string, updates: Partial<Omit<Provider, "id">>): Provider {
    const providers = (this.store.get("providers") as any[]) ?? [];
    const idx = providers.findIndex((p: any) => p.id === id);
    if (idx === -1) throw new Error(`Provider not found: ${id}`);
    const merged: any = { ...providers[idx], ...updates };
    // Encrypt apiKey if it was provided in updates
    if (updates.apiKey !== undefined) {
      const encrypted = this._encryptApiKey(updates.apiKey);
      merged.apiKey = encrypted.encrypted;
      merged._apiKeyEncrypted = encrypted.marker;
    }
    providers[idx] = merged;
    this.store.set("providers", providers);
    const result: Provider = { ...merged, apiKey: this._decryptApiKey(merged) };
    log("updateProvider: id=%s name=%s keys=%o", id, result.name, Object.keys(updates));
    return result;
  }

  removeProvider(id: string): void {
    const stored = (this.store.get("providers") as any[]) ?? [];
    const removed = stored.find((p: any) => p.id === id);
    const providers = stored.filter((p: any) => p.id !== id);
    this.store.set("providers", providers);
    if (removed) {
      this.clearProviderModelTestResults(removed.baseURL);
    }
    if (this.store.get("provider") === id) {
      this.store.delete("provider" as keyof ConfigStoreSchema);
      this.store.delete("model" as keyof ConfigStoreSchema);
      log("removeProvider: cleared global selection for id=%s", id);
    }
    log("removeProvider: id=%s remaining=%d", id, providers.length);
  }

  getGlobalSelection(): { provider?: string; model?: string } {
    return {
      provider: this.store.get("provider") as string | undefined,
      model: this.store.get("model") as string | undefined,
    };
  }

  setGlobalSelection(provider?: string | null, model?: string | null): void {
    if (provider === null) {
      this.store.delete("provider" as keyof ConfigStoreSchema);
    } else if (provider !== undefined) {
      this.store.set("provider" as keyof ConfigStoreSchema, provider as any);
    }
    if (model === null) {
      this.store.delete("model" as keyof ConfigStoreSchema);
    } else if (model !== undefined) {
      this.store.set("model" as keyof ConfigStoreSchema, model as any);
    }
    log("setGlobalSelection: provider=%s model=%s", provider, model);
  }

  getPostToolUseHooks(): PostToolUseHookEntry[] {
    const raw = (this.store.get("postToolUseHooks" as keyof ConfigStoreSchema) as any) ?? [];
    if (!Array.isArray(raw)) return [];
    return raw.filter((h: any) => typeof h?.pattern === "string" && typeof h?.command === "string");
  }

  setPostToolUseHooks(hooks: PostToolUseHookEntry[]): void {
    this.store.set("postToolUseHooks" as keyof ConfigStoreSchema, hooks as any);
    log("setPostToolUseHooks: %d hooks", hooks.length);
  }
}
