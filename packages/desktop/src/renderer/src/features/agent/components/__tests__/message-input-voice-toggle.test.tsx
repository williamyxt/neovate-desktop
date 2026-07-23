// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openView, configSet, insertContent, configState } = vi.hoisted(() => ({
  openView: vi.fn(),
  configSet: vi.fn(),
  triggerSystemVoiceInput: vi.fn(),
  insertContent: vi.fn(),
  configState: {
    sendMessageWith: "enter",
    permissionMode: "default",
    voice: {
      mode: "dualChat",
      captureInput: "system",
      backendPreference: "cloud",
      voiceInputSource: "system",
      asrEngine: "remote",
      dualAsrWsUrl: "ws://127.0.0.1:8000",
      meetingAsrWsUrl: "ws://127.0.0.1:10095",
      ttsUrl: "",
      localTtsModelId: "Qwen/Qwen3-TTS",
    },
  },
}));

vi.mock("@tiptap/extension-placeholder", () => ({
  default: { configure: () => ({}) },
}));

vi.mock("@tiptap/starter-kit", () => ({
  default: { configure: () => ({}) },
}));

vi.mock("@tiptap/pm/state", () => ({
  Plugin: class {
    constructor(_: any) {}
  },
  PluginKey: class {
    constructor(_: any) {}
  },
}));

vi.mock("@tiptap/react", () => ({
  Node: { create: (spec: any) => spec },
  mergeAttributes: (...objs: any[]) => Object.assign({}, ...objs),
  Extension: { create: (spec: any) => spec },
  EditorContent: () => null,
  useEditor: () => ({
    isDestroyed: false,
    isEmpty: true,
    getJSON: () => ({}),
    setEditable: vi.fn(),
    chain: () => ({
      focus: () => ({
        insertContent: (c: any) => {
          insertContent(c);
          return { run: vi.fn() };
        },
      }),
    }),
    commands: { focus: vi.fn(), clearContent: vi.fn() },
    view: { dispatch: vi.fn() },
    state: { tr: { setMeta: vi.fn(() => ({})) } },
  }),
}));

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: any) => children,
  motion: new Proxy(
    {},
    {
      get: () => (props: any) => props.children ?? null,
    },
  ),
}));

vi.mock("debug", () => ({ default: () => () => {} }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, vars?: any) => (vars?.sessionId ? `${k}:${vars.sessionId}` : k),
  }),
}));

vi.mock("../../../../orpc", () => ({
  client: {
    config: { set: configSet },
    orchideaVoice: { triggerSystemVoiceInput },
  },
}));

vi.mock("../../../../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../../../../core/app", () => ({
  useRendererApp: () => ({ workbench: { contentPanel: { openView } } }),
}));

vi.mock("../../../config/store", () => {
  const hook: any = (sel: any) => sel(configState);
  hook.getState = () => configState;
  hook.setState = (next: any) => Object.assign(configState, next);
  return { useConfigStore: hook };
});

vi.mock("../../settings", () => ({ useSettingsStore: (sel: any) => sel({ showSettings: false }) }));
vi.mock("../chat-manager", () => ({ claudeCodeChatManager: { getChat: () => null } }));
vi.mock("../hooks/use-new-session", () => ({
  useNewSession: () => ({ createNewSession: vi.fn() }),
}));
vi.mock("../../store", () => {
  const hook: any = (sel: any) =>
    sel({
      activeSessionId: "s1",
      sessions: new Map([["s1", { permissionMode: "default" }]]),
      setPermissionMode: vi.fn(),
    });
  hook.getState = () => ({
    activeSessionId: "s1",
    sessions: new Map([["s1", { permissionMode: "default" }]]),
  });
  return { useAgentStore: hook };
});

vi.mock("../utils/extract-text", () => ({ extractText: () => "" }));
vi.mock("../utils/local-template-commands", () => ({
  tryHandleLocalTemplateCommand: async () => ({ handled: false }),
}));
vi.mock("../utils/local-control-commands", () => ({
  tryHandleLocalControlCommand: async () => ({ handled: false }),
}));
vi.mock("../utils/read-file-as-attachment", () => ({ readFileAsAttachment: async () => ({}) }));
vi.mock("../attachment-preview", () => ({ AttachmentPreview: () => null }));
vi.mock("../gradient-border-wrapper", () => ({
  GradientBorderWrapper: ({ children }: any) => children,
}));
vi.mock("../mention-extension", () => ({ createMentionExtension: () => ({}) }));
vi.mock("../slash-commands-extension", () => ({ createSlashCommandsExtension: () => ({}) }));
vi.mock("../image-paste-extension", () => ({ createImagePasteExtension: () => ({}) }));
vi.mock("../query-status", () => ({ QueryStatus: () => null }));
vi.mock("../chat-voice-panel", () => ({
  ChatVoicePanel: ({ onClose, compact }: any) =>
    compact ? (
      <div data-testid="chat-voice-compact">
        <button type="button" onClick={onClose}>
          close-voice
        </button>
      </div>
    ) : (
      <div data-testid="chat-voice-panel">
        <button type="button" onClick={onClose}>
          close-voice
        </button>
      </div>
    ),
}));
vi.mock("../input-toolbar", () => ({
  InputToolbar: ({ onVoice, onMeeting, voiceActive }: any) => (
    <div>
      <button type="button" data-testid="voice-button" onClick={onVoice}>
        voice-{String(voiceActive)}
      </button>
      <button type="button" data-testid="meeting-button" onClick={onMeeting}>
        meeting
      </button>
    </div>
  ),
}));

import { MessageInput } from "../message-input";

describe("MessageInput voice toggle", () => {
  beforeEach(() => {
    configSet.mockClear();
    openView.mockClear();
    triggerSystemVoiceInput.mockReset();
    triggerSystemVoiceInput.mockResolvedValue({
      ok: true,
      platform: "darwin",
      method: "menu:start-dictation",
      message: null,
    });
    configState.voice.mode = "dualChat";
    configState.voice.captureInput = "system";
    configState.voice.backendPreference = "cloud";
    configState.voice.voiceInputSource = "system";
    configState.voice.asrEngine = "remote";
  });

  afterEach(() => {
    cleanup();
  });

  it("triggers system voice input without opening local voice panel", async () => {
    render(
      <MessageInput
        onSend={vi.fn()}
        onCancel={vi.fn()}
        streaming={false}
        disabled={false}
        cwd="/tmp"
      />,
    );

    fireEvent.click(screen.getByTestId("voice-button"));

    await waitFor(() => expect(triggerSystemVoiceInput).toHaveBeenCalledTimes(1));
    expect(configSet).not.toHaveBeenCalled();
    expect(openView).not.toHaveBeenCalled();
    expect(configState.voice).toEqual(
      expect.objectContaining({
        mode: "dualChat",
        captureInput: "system",
        backendPreference: "cloud",
        voiceInputSource: "system",
        asrEngine: "remote",
      }),
    );
    expect(screen.queryByTestId("chat-voice-compact")).toBeNull();
    expect(screen.queryByTestId("chat-voice-panel")).toBeNull();
  });

  it("keeps meeting button opening legacy voice view", async () => {
    render(
      <MessageInput
        onSend={vi.fn()}
        onCancel={vi.fn()}
        streaming={false}
        disabled={false}
        cwd="/tmp"
      />,
    );

    fireEvent.click(screen.getByTestId("meeting-button"));

    await waitFor(() =>
      expect(configSet).toHaveBeenCalledWith({
        key: "voice",
        value: expect.objectContaining({ mode: "meeting" }),
      }),
    );
    expect(openView).toHaveBeenCalledWith("orchidea-voice");
  });
});
