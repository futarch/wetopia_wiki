"use client";

// Dictation adapter for assistant-ui, backed by our own transcription route.
//
// We do not use WebSpeechDictationAdapter: in Chrome the Web Speech API streams
// the microphone to Google. Here the audio goes to our server and on to
// Mistral's speech model — the same provider and jurisdiction as everything
// else — and the transcript lands in the composer for the user to review.
import type { DictationAdapter } from "@assistant-ui/react";

type Listener<T> = (value: T) => void;

/**
 * What the interface has to say out loud.
 *
 * The adapter's own status cannot carry this: it ends only once the transcript
 * is back, so the long wait between releasing the button and seeing the words
 * would read as « still recording ». `transcribing` is that wait, named.
 */
export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

export class WetopiaDictationAdapter implements DictationAdapter {
  /** Keep the textarea usable: the transcript is appended when it arrives. */
  disableInputDuringDictation = false;

  phase: DictationPhase = "idle";
  private readonly watchers = new Set<Listener<DictationPhase>>();

  /** Follow the phase; returns the unsubscribe function. */
  watch(cb: Listener<DictationPhase>): () => void {
    this.watchers.add(cb);
    return () => this.watchers.delete(cb);
  }

  private to(phase: DictationPhase) {
    this.phase = phase;
    for (const cb of this.watchers) cb(phase);
  }

  listen(): DictationAdapter.Session {
    this.to("starting");
    const speechStart: Listener<void>[] = [];
    const speechEnd: Listener<DictationAdapter.Result>[] = [];
    const speech: Listener<DictationAdapter.Result>[] = [];
    const sub = <T>(list: Listener<T>[], cb: Listener<T>) => {
      list.push(cb);
      return () => {
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      };
    };

    const session: DictationAdapter.Session = {
      status: { type: "starting" },
      stop: async () => {},
      cancel: () => {},
      onSpeechStart: (cb) => sub(speechStart, cb),
      onSpeechEnd: (cb) => sub(speechEnd, cb),
      onSpeech: (cb) => sub(speech, cb),
    };

    let recorder: MediaRecorder | null = null;
    let stream: MediaStream | null = null;
    let cancelled = false;
    const chunks: Blob[] = [];

    const finish = (result: DictationAdapter.Result, reason: "stopped" | "cancelled" | "error") => {
      session.status = { type: "ended", reason };
      this.to("idle");
      for (const cb of speechEnd) cb(result);
    };

    const stopTracks = () => stream?.getTracks().forEach((t) => t.stop());

    const transcribe = async (): Promise<string> => {
      const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
      if (blob.size < 1200) return ""; // nothing said
      const form = new FormData();
      form.set("audio", blob, "dictee.webm");
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      if (!res.ok) throw new Error(`transcription : ${res.status}`);
      const { text } = await res.json();
      return typeof text === "string" ? text : "";
    };

    const started = (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        recorder.start();
        session.status = { type: "running" };
        this.to("recording");
        for (const cb of speechStart) cb();
      } catch (e) {
        finish({ transcript: "", isFinal: true }, "error");
        throw e;
      }
    })();

    session.stop = async () => {
      await started.catch(() => {});
      if (!recorder || recorder.state === "inactive") return;
      const done = new Promise<void>((resolve) => {
        recorder!.onstop = () => resolve();
      });
      recorder.stop();
      await done;
      stopTracks();
      if (cancelled) return;
      this.to("transcribing");
      try {
        const transcript = await transcribe();
        for (const cb of speech) cb({ transcript, isFinal: true });
        finish({ transcript, isFinal: true }, "stopped");
      } catch {
        finish({ transcript: "", isFinal: true }, "error");
      }
    };

    session.cancel = () => {
      cancelled = true;
      try {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      } catch {
        /* already stopped */
      }
      stopTracks();
      finish({ transcript: "", isFinal: true }, "cancelled");
    };

    return session;
  }
}

export const isDictationSupported = () =>
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== "undefined";
