import { oc, type } from "@orpc/contract";
import { z } from "zod";

export const orchideaVoiceContract = {
  getStatus:
    oc.output(
      type<{
        running: boolean;
        url: string | null;
        port: number | null;
        lastError: string | null;
      }>(),
    ),
  getMicPermissionStatus:
    oc.output(
      type<{
        status: "not-determined" | "granted" | "denied" | "restricted" | "unknown";
      }>(),
    ),
  requestMicPermission:
    oc.output(
      type<{
        status: "not-determined" | "granted" | "denied" | "restricted" | "unknown";
        granted: boolean;
      }>(),
    ),
  triggerSystemVoiceInput:
    oc.output(
      type<{
        ok: boolean;
        platform: NodeJS.Platform;
        method: string;
        message: string | null;
      }>(),
    ),
  start:
    oc.output(
      type<{
        running: boolean;
        url: string | null;
        port: number | null;
        lastError: string | null;
      }>(),
    ),
  stop: oc.output(type<{ ok: true }>()),
  setFocusedSession: oc
    .input(
      z.object({
        sessionId: z.string().nullable(),
      }),
    )
    .output(type<{ ok: true }>()),
};
