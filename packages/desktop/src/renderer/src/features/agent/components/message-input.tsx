import Placeholder from "@tiptap/extension-placeholder";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Extension, useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import debug from "debug";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { FileAttachment, PermissionMode } from "../../../../../shared/features/agent/types";

import { toastManager } from "../../../components/ui/toast";
import { useRendererApp } from "../../../core/app";
import { APP_EVENTS, addAppEventListener } from "../../../core/app-events";
import { useEventCallback } from "../../../hooks/use-event-callback";
import { useLatestRef } from "../../../hooks/use-latest-ref";
import { cn } from "../../../lib/utils";
import { client } from "../../../orpc";
import { useConfigStore } from "../../config/store";
import { useSettingsStore } from "../../settings";
import { claudeCodeChatManager } from "../chat-manager";
import { useNewSession } from "../hooks/use-new-session";
import { useAgentStore } from "../store";
import { extractText } from "../utils/extract-text";
import { buildInsertChatContent, type InsertChatDetail } from "../utils/insert-chat";
import { tryHandleLocalControlCommand } from "../utils/local-control-commands";
import { tryHandleLocalTemplateCommand } from "../utils/local-template-commands";
import { readFileAsAttachment } from "../utils/read-file-as-attachment";
import { AttachmentPreview } from "./attachment-preview";
import { ChatVoicePanel } from "./chat-voice-panel";
import { GradientBorderWrapper } from "./gradient-border-wrapper";
import { createImagePasteExtension } from "./image-paste-extension";
import { InputToolbar } from "./input-toolbar";
import { createMentionExtension } from "./mention-extension";
import { QueryStatus } from "./query-status";
import { createSlashCommandsExtension } from "./slash-commands-extension";

const log = debug("orchidea:message-input");

// #region debug-point voice-asr-modes-renderer
const ENV = (globalThis as any).process?.env as Record<string, string> | undefined;
const API_DEBUG = (globalThis as any).api?.debug as
  | { serverUrl?: string; sessionId?: string; runId?: string }
  | undefined;
const DEBUG_SERVER_URL = (
  import.meta.env.VITE_DEBUG_SERVER_URL ||
  API_DEBUG?.serverUrl ||
  ENV?.DEBUG_SERVER_URL ||
  ""
).trim();
const DEBUG_SESSION_ID = (
  import.meta.env.VITE_DEBUG_SESSION_ID ||
  API_DEBUG?.sessionId ||
  ENV?.DEBUG_SESSION_ID ||
  ""
).trim();
const DEBUG_RUN_ID =
  (
    import.meta.env.VITE_ORCHIDEA_DEBUG_RUN_ID ||
    API_DEBUG?.runId ||
    ENV?.ORCHIDEA_DEBUG_RUN_ID ||
    "pre"
  ).trim() || "pre";
async function reportVoiceModeDebugEvent(
  event: string,
  data?: Record<string, unknown>,
): Promise<void> {
  if (!DEBUG_SERVER_URL || !DEBUG_SESSION_ID) return;
  try {
    await fetch(DEBUG_SERVER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ts: Date.now(),
        sessionId: DEBUG_SESSION_ID,
        runId: DEBUG_RUN_ID,
        hypothesisId: "A",
        event,
        data: data ?? {},
      }),
    });
  } catch {}
}
// #endregion debug-point voice-asr-modes-renderer

type Props = {
  onSend: (message: string, attachments?: FileAttachment[]) => void;
  onCancel: () => void;
  streaming: boolean;
  disabled?: boolean;
  sessionInitializing?: boolean;
  sessionInitError?: string | null;
  onRetry?: () => void;
  cwd: string;
  dockAttached?: boolean;
};

const NEW_CHAT_EASTER_EGGS = new Set(["exit", "quit", ":q", ":q!", ":wq", ":wq!"]);

type OpenClawReplyContext = {
  channelId: "wecom" | "dingtalk" | "feishu";
  target: Record<string, unknown> | null;
  traceId: string | null;
};

export function MessageInput({
  onSend,
  onCancel,
  streaming,
  disabled,
  sessionInitializing,
  sessionInitError,
  onRetry,
  cwd,
  dockAttached = false,
}: Props) {
  const { t } = useTranslation();
  const cwdRef = useLatestRef(cwd);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const app = useRendererApp();
  const { createNewSession } = useNewSession();

  const activeSessionId = useAgentStore((s) => s.activeSessionId);

  // Subscribe to prompt suggestion from the per-session chat store.
  // Uses useState+useEffect instead of useStore to avoid conditional hook calls
  // (chatStore may be undefined when no session is active).
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null);
  useEffect(() => {
    const store = activeSessionId
      ? claudeCodeChatManager.getChat(activeSessionId)?.store
      : undefined;
    if (!store) {
      setPromptSuggestion(null);
      return;
    }
    setPromptSuggestion(store.getState().promptSuggestion);
    return store.subscribe((state) => {
      setPromptSuggestion(state.promptSuggestion);
    });
  }, [activeSessionId]);
  const promptSuggestionRef = useLatestRef(promptSuggestion);

  const clearSuggestion = useEventCallback(() => {
    if (!activeSessionId) return;
    claudeCodeChatManager.getChat(activeSessionId)?.store.setState({ promptSuggestion: null });
  });

  const permissionMode = useAgentStore(
    (s) =>
      (activeSessionId ? s.sessions.get(activeSessionId)?.permissionMode : undefined) ?? "default",
  );
  const setPermissionMode = useAgentStore((s) => s.setPermissionMode);

  const togglePlanMode = useEventCallback(() => {
    if (!activeSessionId) return;
    const current =
      useAgentStore.getState().sessions.get(activeSessionId)?.permissionMode ?? "default";
    const configDefault = useConfigStore.getState().permissionMode as PermissionMode;
    const next: PermissionMode = current === "plan" ? configDefault : "plan";
    log("togglePlanMode: %s -> %s (configDefault=%s)", current, next, configDefault);
    setPermissionMode(activeSessionId, next);
    claudeCodeChatManager.getChat(activeSessionId)?.dispatch({
      kind: "configure",
      configure: { type: "set_permission_mode", mode: next },
    });
  });

  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const attachmentsRef = useLatestRef(attachments);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceDraftText, setVoiceDraftText] = useState("");
  const voiceDraftTextRef = useLatestRef(voiceDraftText);

  const [openclawReplyContext, setOpenclawReplyContext] = useState<OpenClawReplyContext | null>(
    null,
  );
  const openclawReplyContextRef = useLatestRef(openclawReplyContext);

  useEffect(() => {
    const cleanup = addAppEventListener(APP_EVENTS.openclawReplyContextSet, (e: Event) => {
      const detail = (e as CustomEvent<any>)?.detail ?? {};
      const ctx = detail?.context;
      if (!ctx) {
        setOpenclawReplyContext(null);
        return;
      }
      const channelId = String(ctx.channelId ?? "").trim();
      if (channelId !== "wecom" && channelId !== "dingtalk" && channelId !== "feishu") return;
      const target =
        ctx.target && typeof ctx.target === "object" && !Array.isArray(ctx.target)
          ? (ctx.target as any)
          : null;
      const traceId =
        typeof ctx.traceId === "string" && ctx.traceId.trim() ? ctx.traceId.trim() : null;
      setOpenclawReplyContext({ channelId, target, traceId });
    });
    return () => cleanup();
  }, []);

  // #region debug-point voice-dualchat-route-switch-message-input-state
  useEffect(() => {
    void reportVoiceModeDebugEvent("chat:messageInput:voiceState", {
      activeSessionId,
      voiceOpen,
      draftLength: voiceDraftText.length,
    });
  }, [activeSessionId, voiceDraftText.length, voiceOpen]);
  // #endregion debug-point voice-dualchat-route-switch-message-input-state

  const addAttachments = useCallback((images: FileAttachment[]) => {
    log(
      "addAttachments: adding %d files, ids=%o",
      images.length,
      images.map((i) => i.id),
    );
    setAttachments((prev) => {
      const next = [...prev, ...images];
      log("addAttachments: total attachments now=%d", next.length);
      return next;
    });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const sendMessageWith = useConfigStore((s) => s.sendMessageWith);
  const sendMessageWithRef = useLatestRef(sendMessageWith);

  const mentionExtension = useMemo(() => createMentionExtension(() => cwdRef.current), []);

  const slashCommandsExtension = useMemo(
    () =>
      createSlashCommandsExtension(() => {
        const { activeSessionId, sessions } = useAgentStore.getState();
        const sdkCommands = activeSessionId
          ? (sessions.get(activeSessionId)?.availableCommands ?? [])
          : [];
        const customCommands = (useConfigStore.getState().customSlashCommands ?? [])
          .filter((c) => c.enabled !== false)
          .map((c) => ({
            name: c.name,
            description: c.description,
            argumentHint: c.argumentHint,
            prompt: c.prompt,
          }));
        return [...sdkCommands, ...customCommands];
      }),
    [],
  );

  const imagePasteExtension = useMemo(
    () => createImagePasteExtension(addAttachments),
    [addAttachments],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        blockquote: false,
        bold: false,
        italic: false,
        code: false,
        codeBlock: false,
        strike: false,
        horizontalRule: false,
      }),
      Placeholder.configure({
        placeholder: () => {
          const suggestion = promptSuggestionRef.current;
          if (suggestion) return suggestion + "    Tab to fill · Enter to send";
          return t("chat.placeholder");
        },
      }),
      mentionExtension,
      slashCommandsExtension,
      imagePasteExtension,
      Extension.create({
        name: "chatKeymap",
        addProseMirrorPlugins() {
          const editor = this.editor;
          return [
            new Plugin({
              key: new PluginKey("chatKeymap"),
              props: {
                handleKeyDown(_view, event) {
                  const mode = sendMessageWithRef.current;

                  // Tab: accept prompt suggestion (fill editor)
                  if (event.key === "Tab" && !event.shiftKey) {
                    if (document.querySelector("[data-suggestion-popup]")) return false;
                    const suggestion = promptSuggestionRef.current;
                    if (suggestion && editor.isEmpty) {
                      event.preventDefault();
                      editor.commands.setContent(suggestion);
                      clearSuggestion();
                      return true;
                    }
                    return false;
                  }

                  // Bare Enter (no modifier)
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.altKey &&
                    !event.metaKey &&
                    !event.ctrlKey
                  ) {
                    if (document.querySelector("[data-suggestion-popup]")) return false;

                    if (mode === "cmdEnter") {
                      return false;
                    }

                    event.preventDefault();
                    const text = extractText(editor.getJSON()).trim();

                    // Empty input + suggestion → send suggestion directly
                    const suggestion = promptSuggestionRef.current;
                    if (!text && suggestion) {
                      clearSuggestion();
                      onSend(suggestion);
                      toastManager.add({
                        type: "info",
                        title: t("chat.suggestionSent"),
                        timeout: 2000,
                      });
                      return true;
                    }

                    if (NEW_CHAT_EASTER_EGGS.has(text.toLowerCase())) {
                      editor.commands.clearContent();
                      createNewSession(cwdRef.current);
                      return true;
                    }
                    send();
                    return true;
                  }
                  // Cmd/Ctrl+Enter
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    if (document.querySelector("[data-suggestion-popup]")) return false;

                    if (mode === "cmdEnter") {
                      event.preventDefault();
                      const text = extractText(editor.getJSON()).trim();

                      // Empty input + suggestion → send suggestion directly
                      const suggestion = promptSuggestionRef.current;
                      if (!text && suggestion) {
                        clearSuggestion();
                        onSend(suggestion);
                        toastManager.add({
                          type: "info",
                          title: t("chat.suggestionSent"),
                          timeout: 2000,
                        });
                        return true;
                      }

                      if (NEW_CHAT_EASTER_EGGS.has(text.toLowerCase())) {
                        editor.commands.clearContent();
                        createNewSession(cwdRef.current);
                        return true;
                      }
                      send();
                      return true;
                    }

                    editor.commands.setHardBreak();
                    return true;
                  }
                  if (event.key === "Enter" && event.altKey) {
                    editor.commands.setHardBreak();
                    return true;
                  }
                  if (event.key === "Tab" && event.shiftKey) {
                    event.preventDefault();
                    togglePlanMode();
                    return true;
                  }
                  if (event.key === "Escape") {
                    // Dismiss suggestion first, then blur on next Escape
                    if (promptSuggestionRef.current) {
                      clearSuggestion();
                      return true;
                    }
                    editor.commands.blur();
                    return true;
                  }
                  return false;
                },
              },
            }),
          ];
        },
      }),
    ],
    editorProps: {
      attributes: {
        class:
          "tiptap min-h-[76px] max-h-[240px] overflow-y-auto px-3 py-2 text-sm outline-none bg-background-secondary",
      },
      transformPastedHTML(html) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const text = doc.body.innerText || "";
        return text
          .split("\n")
          .map((line) => {
            if (!line) return "<p></p>";
            const escaped = line
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;");
            return `<p>${escaped}</p>`;
          })
          .join("");
      },
    },
    editable: !disabled,
    autofocus: "end",
  });

  const send = useEventCallback(() => {
    if (!editor || streaming) return;
    const text = extractText(editor.getJSON());
    const imgs = attachmentsRef.current;
    log(
      "send: text=%s attachmentsRef.current.length=%d ids=%o",
      text.slice(0, 50),
      imgs.length,
      imgs.map((i) => i.id),
    );
    if (imgs.length > 0) {
      log(
        "send: attachment details: %o",
        imgs.map((i) => ({
          id: i.id,
          filename: i.filename,
          mediaType: i.mediaType,
          base64Len: i.base64?.length ?? 0,
        })),
      );
    }
    if (!text && imgs.length === 0) return;
    void (async () => {
      const handled =
        imgs.length === 0
          ? await tryHandleLocalTemplateCommand(text).then(async (r) =>
              r.handled ? r : await tryHandleLocalControlCommand(text),
            )
          : { handled: false as const };
      if (handled.handled) {
        editor.commands.clearContent();
        setAttachments([]);
        return;
      }
      onSend(text, imgs.length > 0 ? imgs : undefined);
      editor.commands.clearContent();
      setAttachments([]);
    })();
  });

  const clearOpenclawReplyContext = useEventCallback(() => {
    setOpenclawReplyContext(null);
  });

  const appendVoiceDraft = useEventCallback((text: string) => {
    const normalized = text.trim();
    if (!normalized) return;
    setVoiceDraftText((prev) => (prev.trim() ? `${prev.trim()}\n${normalized}` : normalized));
  });

  const commitVoiceDraftToEditor = useEventCallback(() => {
    const draft = voiceDraftTextRef.current.trim();
    if (!editor || !draft) return;
    editor
      .chain()
      .focus()
      .insertContent(editor.isEmpty ? draft : `\n${draft}`)
      .run();
    setVoiceDraftText("");
  });

  const closeVoiceAndCommit = useEventCallback(() => {
    void reportVoiceModeDebugEvent("chat:voiceButton:close", {
      activeSessionId: useAgentStore.getState().activeSessionId,
      draftLength: voiceDraftTextRef.current.length,
    });
    setVoiceOpen(false);
    commitVoiceDraftToEditor();
  });

  const sendOpenclawReply = useEventCallback(() => {
    if (!editor || streaming) return;
    const ctx = openclawReplyContextRef.current;
    if (!ctx) return;

    const text = extractText(editor.getJSON()).trim();
    if (!text) {
      toastManager.add({ type: "warning", title: t("chat.openclaw.replyEmpty"), timeout: 2000 });
      return;
    }
    if (attachmentsRef.current.length > 0) {
      toastManager.add({
        type: "warning",
        title: t("chat.openclaw.replyAttachmentsUnsupported"),
        timeout: 2500,
      });
      return;
    }

    void (async () => {
      try {
        const res = await client.openclaw.channelSendText({
          channelId: ctx.channelId,
          text,
          target: (ctx.target ?? undefined) as any,
          traceId: ctx.traceId ?? undefined,
        });
        if (!res.ok) {
          toastManager.add({
            type: "error",
            title: t("chat.openclaw.replySendFailed"),
            description: res.error ?? "",
            timeout: 4000,
          } as any);
          return;
        }
        toastManager.add({
          type: "success",
          title: t("chat.openclaw.replySent"),
          timeout: 2000,
        });
        editor.commands.clearContent();
        setOpenclawReplyContext(null);
      } catch (e) {
        toastManager.add({
          type: "error",
          title: t("chat.openclaw.replySendFailed"),
          description: e instanceof Error ? e.message : String(e),
          timeout: 4000,
        } as any);
      }
    })();
  });

  // Keep editable in sync with props
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  // Force placeholder re-render when suggestion changes
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta("promptSuggestion", promptSuggestion));
  }, [editor, promptSuggestion]);

  // Close suggestion popups when settings opens
  const showSettings = useSettingsStore((s) => s.showSettings);
  useEffect(() => {
    if (showSettings) {
      document.querySelectorAll("[data-suggestion-popup]").forEach((el) => el.remove());
    }
  }, [showSettings]);

  // Focus editor when project is switched
  useEffect(() => {
    if (!editor) return;
    const handler = () => {
      editor.commands.focus("end");
    };
    const cleanup = addAppEventListener(APP_EVENTS.focusInput, handler);
    return () => cleanup();
  }, [editor]);

  // Listen for insert-chat events from file tree and other entry points
  useEffect(() => {
    if (!editor) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<InsertChatDetail>).detail ?? {};
      const content = buildInsertChatContent(detail);
      log(
        "insert-chat received textLen=%d mentions=%d",
        detail.text?.length ?? 0,
        detail.mentions?.length ?? 0,
      );
      if (content.length === 0) return;
      editor.chain().focus().insertContent(content).run();
    };
    const cleanup = addAppEventListener(APP_EVENTS.insertChat, handler);
    return () => cleanup();
  }, [editor]);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      log("handleFileSelect: files=%d", files?.length ?? 0);
      if (!files || files.length === 0) return;
      Promise.all(Array.from(files).map(readFileAsAttachment)).then(addAttachments);
      e.target.value = "";
    },
    [addAttachments],
  );

  const openVoice = useEventCallback((mode: "dualChat" | "meeting") => {
    const { voice } = useConfigStore.getState();
    void reportVoiceModeDebugEvent("chat:voiceButton:click", {
      mode,
      prevMode: voice.mode,
      dualAsrWsUrl: voice.dualAsrWsUrl,
      meetingAsrWsUrl: voice.meetingAsrWsUrl,
      ttsUrl: voice.ttsUrl,
      localTtsModelId: voice.localTtsModelId,
      activeSessionId: useAgentStore.getState().activeSessionId,
    });
    const next = {
      ...voice,
      mode,
      ...(mode === "dualChat"
        ? {
            captureInput: "system" as const,
            backendPreference: "cloud" as const,
            voiceInputSource: "system" as const,
            asrEngine: "remote" as const,
          }
        : {}),
    };
    void (async () => {
      useConfigStore.setState({ voice: next } as any);
      try {
        await client.config.set({ key: "voice", value: next } as any);
        void reportVoiceModeDebugEvent("chat:voiceButton:configSet:ok", {
          mode,
        });
      } catch (e) {
        void reportVoiceModeDebugEvent("chat:voiceButton:configSet:error", {
          mode,
          message: e instanceof Error ? e.message : String(e),
        });
      }
      if (mode === "dualChat") {
        void reportVoiceModeDebugEvent("chat:voiceButton:open-panel", {
          activeSessionId: useAgentStore.getState().activeSessionId,
          mode,
        });
        setVoiceOpen(true);
        return;
      }
      app.workbench.contentPanel.openView("orchidea-voice");
    })();
  });

  const toggleChatVoice = useEventCallback(() => {
    void reportVoiceModeDebugEvent("chat:voiceButton:toggle", {
      voiceOpen,
      activeSessionId: useAgentStore.getState().activeSessionId,
    });
    if (voiceOpen) {
      closeVoiceAndCommit();
      return;
    }
    void (async () => {
      if (!useAgentStore.getState().activeSessionId) {
        void reportVoiceModeDebugEvent("chat:voiceButton:create-session:begin", {
          cwd: cwdRef.current,
        });
        await createNewSession(cwdRef.current);
        void reportVoiceModeDebugEvent("chat:voiceButton:create-session:done", {
          activeSessionId: useAgentStore.getState().activeSessionId,
        });
      }
      setVoiceDraftText("");
      await openVoice("dualChat");
    })();
  });

  const triggerSystemVoiceInput = useEventCallback(() => {
    void reportVoiceModeDebugEvent("chat:voiceButton:system-trigger:begin", {
      activeSessionId: useAgentStore.getState().activeSessionId,
      voiceOpen,
    });
    if (voiceOpen) {
      closeVoiceAndCommit();
    }
    editor.commands.focus("end");
    void (async () => {
      try {
        const result = await client.orchideaVoice.triggerSystemVoiceInput();
        void reportVoiceModeDebugEvent("chat:voiceButton:system-trigger:done", result);
        if (!result.ok) {
          toastManager.add({
            type: "warning",
            title: "无法直接启动系统语音输入",
            description: result.message || "请手动使用操作系统自带的语音输入快捷键。",
            timeout: 4000,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void reportVoiceModeDebugEvent("chat:voiceButton:system-trigger:error", { message });
        toastManager.add({
          type: "error",
          title: "系统语音输入启动失败",
          description: "请手动使用操作系统自带的语音输入快捷键。",
          timeout: 4000,
        });
      }
    })();
  });
  return (
    <div className={cn("px-4 pt-4 pb-1 max-w-3xl mx-auto w-full", dockAttached ? "pb-1 pt-0" : "")}>
      {activeSessionId && <QueryStatus sessionId={activeSessionId} />}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        aria-label={t("chat.attachFiles")}
        onChange={handleFileSelect}
      />
      <GradientBorderWrapper
        innerClassName={cn(
          "focus-within:!border-primary/50",
          dockAttached ? "rounded-b-lg rounded-t-[18px]" : "rounded-lg",
        )}
      >
        <AnimatePresence>
          {permissionMode === "plan" && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden"
            >
              <div
                className={cn(
                  "flex items-center gap-1.5 border-b border-info/20 bg-info/5 px-3 py-1 text-xs text-info-foreground",
                  dockAttached ? "rounded-t-[18px]" : "rounded-t-lg",
                )}
              >
                <span className="font-medium">{t("chat.planMode")}</span>
                <span className="text-info-foreground/50">{t("chat.planModeExit")}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div data-has-suggestion={promptSuggestion ? "" : undefined}>
          <EditorContent editor={editor} />
        </div>
        <AttachmentPreview attachments={attachments} onRemove={removeAttachment} />
        {voiceOpen ? (
          <ChatVoicePanel
            compact
            sessionId={activeSessionId}
            transcriptMode="draft"
            onFinalTranscript={appendVoiceDraft}
            onClose={closeVoiceAndCommit}
          />
        ) : null}
        <InputToolbar
          streaming={streaming}
          disabled={disabled}
          sessionInitializing={sessionInitializing}
          sessionInitError={sessionInitError}
          onRetry={onRetry}
          onSend={send}
          openclawReplyContext={openclawReplyContext}
          onSendOpenclawReply={sendOpenclawReply}
          onClearOpenclawReplyContext={clearOpenclawReplyContext}
          onCancel={onCancel}
          onAttach={() => fileInputRef.current?.click()}
          onVoice={triggerSystemVoiceInput}
          onMeeting={() => openVoice("meeting")}
          activeSessionId={activeSessionId}
          voiceActive={voiceOpen}
        />
      </GradientBorderWrapper>
    </div>
  );
}
