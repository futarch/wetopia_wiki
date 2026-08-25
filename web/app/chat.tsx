"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessagePartText,
} from "@assistant-ui/react";
import { createPiHttpClient, usePiRuntime } from "@assistant-ui/react-pi";
import dynamic from "next/dynamic";
import Markdown from "react-markdown";
import { useViewer, signOut } from "../lib/auth-client.ts";
import { WetopiaDictationAdapter, isDictationSupported } from "../lib/dictation.ts";
import type { GraphEdge, GraphNode, PageView } from "../lib/wiki-view.ts";
import PagePane from "./page-view.tsx";
import SignIn from "./sign-in.tsx";

// Sigma renders with WebGL and cannot be imported on the server.
const WikiGraph = dynamic(() => import("./graph.tsx"), {
  ssr: false,
  loading: () => <div className="pane-empty">Chargement du graphe…</div>,
});

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

function Conversation({
  threadId,
  scope,
  onTurnEnd,
}: {
  threadId: string;
  scope: Scope;
  onTurnEnd: () => void;
}) {
  const client = useMemo(() => createPiHttpClient({ baseUrl: "/api/pi" }), []);
  const dictation = useMemo(() => (isDictationSupported() ? new WetopiaDictationAdapter() : undefined), []);
  const runtime = usePiRuntime({ client, threadId, adapters: dictation ? { dictation } : undefined });

  // The agent writes pages as it answers, so the graph is stale the moment a
  // turn finishes. Refresh on the running→idle edge rather than polling.
  const running = runtime.thread.getState().isRunning;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) onTurnEnd();
    wasRunning.current = running;
  }, [running, onTurnEnd]);

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
  const { viewer, isPending } = useViewer();
  const [scope, setScope] = useState<Scope>("private");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<PageView | null>(null);
  const [pageLoading, setPageLoading] = useState(false);

  const loadGraph = useCallback(async () => {
    try {
      const res = await fetch(`/api/wiki/graph?scope=${scope}`);
      if (res.ok) setGraph(await res.json());
    } catch {
      /* the chat still works without the graph */
    }
  }, [scope]);

  const openPage = useCallback(
    async (p: string) => {
      setSelected(p);
      setPageLoading(true);
      try {
        const res = await fetch(`/api/wiki/page?scope=${scope}&path=${encodeURIComponent(p)}`);
        setPage(res.ok ? await res.json() : null);
      } catch {
        setPage(null);
      } finally {
        setPageLoading(false);
      }
    },
    [scope],
  );

  // Scope decides what the graph may even contain, so both panes reset with it.
  useEffect(() => {
    if (!viewer) return;
    setSelected(null);
    setPage(null);
    loadGraph();
  }, [viewer, scope, loadGraph]);

  // One conversation per visit: opening or reloading the page starts a fresh
  // one, and switching scope starts another (scope is fixed for a conversation
  // by design — it decides which bundles the agent can even see).
  useEffect(() => {
    if (!viewer) return;
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
  }, [scope, viewer?.id]);

  if (isPending) return <div className="boot">…</div>;
  if (!viewer) return <SignIn />;

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
          <span title={viewer.email}>{viewer.name || viewer.email}</span>
          <button type="button" className="link" onClick={() => signOut()}>
            Se déconnecter
          </button>
        </div>
      </header>

      <p className="scope-line" data-scope={scope}>
        {SCOPE_HINT[scope]}
      </p>

      {error && <p className="error">⚠ {error}</p>}

      <div className="panes">
        <section className="pane pane-chat" aria-label="Conversation">
          {threadId ? (
            <Conversation key={threadId} threadId={threadId} scope={scope} onTurnEnd={loadGraph} />
          ) : (
            <div className="pane-empty">{busy ? "Ouverture de la conversation…" : "…"}</div>
          )}
        </section>

        <section className="pane pane-graph" aria-label="Graphe du wiki">
          <WikiGraph data={graph} selected={selected} onSelect={openPage} />
        </section>

        <section className="pane pane-page" aria-label="Page">
          <PagePane page={page} loading={pageLoading} onFollow={openPage} />
        </section>
      </div>
    </div>
  );
}
