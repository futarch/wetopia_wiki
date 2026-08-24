"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessagePartText,
} from "@assistant-ui/react";
import { createPiHttpClient, usePiRuntime } from "@assistant-ui/react-pi";
import Markdown from "react-markdown";
import { useSession, signOut } from "../lib/auth-client.ts";
import { WetopiaDictationAdapter, isDictationSupported } from "../lib/dictation.ts";
import SignIn from "./sign-in.tsx";

type Scope = "private" | "shared";

const SCOPE_HINT: Record<Scope, string> = {
  private: "L'agent lit le wiki partagé et tes notes privées. Il n'écrit que chez toi.",
  shared: "L'agent ne voit que le wiki partagé. Ce que tu dis ici peut devenir une page pour tout le monde.",
};

function MarkdownText() {
  const { text } = useMessagePartText();
  return <Markdown>{text}</Markdown>;
}

const TOOL_LABELS: Record<string, string> = {
  read_page: "lecture d'une page",
  search: "recherche dans le wiki",
  write_page: "écriture d'une page",
  append_log: "mise à jour du journal",
};

function ToolCall({ toolName }: { toolName: string }) {
  return (
    <div className="tool">
      <code>· {TOOL_LABELS[toolName] ?? toolName}</code>
    </div>
  );
}

function Composer({ scope, dictation }: { scope: Scope; dictation: boolean }) {
  return (
    <div className="composer">
      <ComposerPrimitive.Root asChild>
        <form>
          <div className="input-wrap">
            <ComposerPrimitive.Input
              autoFocus
              rows={1}
              placeholder={scope === "shared" ? "Écrire dans le wiki partagé…" : "Note privée, question…"}
            />
            <ComposerPrimitive.DictationTranscript asChild>
              <span className="transcript" />
            </ComposerPrimitive.DictationTranscript>
          </div>

          {dictation && (
            <>
              <ComposerPrimitive.Dictate asChild>
                <button type="button" className="mic" title="Dicter" aria-label="Dicter">
                  🎙
                </button>
              </ComposerPrimitive.Dictate>
              <ComposerPrimitive.StopDictation asChild>
                <button type="button" className="mic" data-recording="true" title="Arrêter la dictée" aria-label="Arrêter la dictée">
                  ⏹
                </button>
              </ComposerPrimitive.StopDictation>
            </>
          )}

          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send asChild>
              <button type="submit">Envoyer</button>
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel asChild>
              <button type="button" data-cancel="true">
                Arrêter
              </button>
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </form>
      </ComposerPrimitive.Root>
      <div className="state">
        <ThreadPrimitive.If running>L'agent travaille — la sauvegarde a lieu en fin de tour.</ThreadPrimitive.If>
      </div>
    </div>
  );
}

function Conversation({ threadId, scope }: { threadId: string; scope: Scope }) {
  const client = useMemo(() => createPiHttpClient({ baseUrl: "/api/pi" }), []);
  const dictation = useMemo(() => (isDictationSupported() ? new WetopiaDictationAdapter() : undefined), []);
  const runtime = usePiRuntime({ client, threadId, adapters: dictation ? { dictation } : undefined });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root asChild>
        <div className="conv">
          <ThreadPrimitive.Viewport asChild>
            <div className="viewport">
              <ThreadPrimitive.Empty>
                <div className="empty">
                  <strong>{scope === "shared" ? "Conversation partagée" : "Conversation privée"}</strong>
                  {SCOPE_HINT[scope]}
                </div>
              </ThreadPrimitive.Empty>
              <ThreadPrimitive.Messages
                components={{
                  UserMessage: () => (
                    <div className="row" data-role="user">
                      <div className="bubble">
                        <MessagePrimitive.Parts />
                      </div>
                    </div>
                  ),
                  AssistantMessage: () => (
                    <div className="row" data-role="assistant">
                      <div className="bubble">
                        <MessagePrimitive.Parts
                          components={{ Text: MarkdownText, tools: { Fallback: ToolCall } }}
                        />
                      </div>
                    </div>
                  ),
                }}
              />
            </div>
          </ThreadPrimitive.Viewport>
          <Composer scope={scope} dictation={!!dictation} />
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

export default function Chat() {
  const { data: session, isPending } = useSession();
  const [scope, setScope] = useState<Scope>("private");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // One conversation per visit: opening or reloading the page starts a fresh
  // one, and switching scope starts another (scope is fixed for a conversation
  // by design — it decides which bundles the agent can even see).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setBusy(true);
    setThreadId(null);
    (async () => {
      try {
        const res = await fetch("/api/pi/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope }),
        });
        if (!res.ok) throw new Error(`création de la conversation : ${res.status}`);
        const snap = await res.json();
        if (!cancelled) {
          setThreadId(snap.metadata.id);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, session?.user?.id]);

  if (isPending) return <div className="boot">…</div>;
  if (!session) return <SignIn />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>Wetopia</strong>
          <span>Le wiki de la communauté</span>
        </div>

        <div className="scope-switch" role="group" aria-label="Portée de la conversation">
          <button type="button" data-on={scope === "private"} onClick={() => setScope("private")}>
            Privé
          </button>
          <button type="button" data-on={scope === "shared"} onClick={() => setScope("shared")}>
            Partagé
          </button>
        </div>

        <div className="who">
          <span title={session.user.email ?? ""}>{session.user.name || session.user.email}</span>
          <button type="button" className="link" onClick={() => signOut()}>
            Se déconnecter
          </button>
        </div>
      </header>

      <p className="scope-line" data-scope={scope}>
        {SCOPE_HINT[scope]}
      </p>

      {error && <p className="error">⚠ {error}</p>}

      {threadId ? (
        <Conversation key={threadId} threadId={threadId} scope={scope} />
      ) : (
        <div className="boot">{busy ? "Ouverture de la conversation…" : "…"}</div>
      )}
    </div>
  );
}
