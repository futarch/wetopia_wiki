"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessagePartText,
} from "@assistant-ui/react";
import { createPiHttpClient, usePiRuntime } from "@assistant-ui/react-pi";
import dynamic from "next/dynamic";
import { Mic, Square } from "lucide-react";
import Markdown from "react-markdown";
import { useViewer, signOut } from "../lib/auth-client.ts";
import { citedPages, type Cited, type ToolPart } from "../lib/cited.ts";
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
  private: "L'agent lit le wiki partagé et vos notes privées. Il n'écrit que chez vous.",
  shared:
    "L'agent ne voit que le wiki partagé. Ce que vous dites ici peut devenir une page pour tout le monde.",
};

/** The only way to share something: the scope of the conversation you say it in. */
function ScopeSwitch({ scope, onChange }: { scope: Scope; onChange: (s: Scope) => void }) {
  return (
    <div className="scope-switch" role="group" aria-label="Portée de la conversation">
      <button type="button" data-on={scope === "private"} onClick={() => onChange("private")}>
        Privé
      </button>
      <button type="button" data-on={scope === "shared"} onClick={() => onChange("shared")}>
        Partagé
      </button>
    </div>
  );
}

function MarkdownText() {
  const { text } = useMessagePartText();
  return <Markdown>{text}</Markdown>;
}

/**
 * Where a rendered tool call announces itself.
 *
 * The thread state the runtime hands out does not carry the message parts, but
 * every tool call is rendered — with its arguments and its result — so the
 * components are the reliable place to read them.
 */
const CiteSink = createContext<((id: string, part: ToolPart) => void) | null>(null);

const TOOL_LABELS: Record<string, string> = {
  read_page: "lecture d'une page",
  search: "recherche dans le wiki",
  write_page: "écriture d'une page",
  append_log: "mise à jour du journal",
};

function ToolCall(props: { toolName: string; toolCallId?: string; args?: unknown; result?: unknown }) {
  const { toolName, toolCallId, args, result } = props;
  const report = useContext(CiteSink);
  // Arguments stream in and the result lands later, so report on every change
  // of what actually matters rather than once on mount.
  const path = (args as { path?: unknown } | undefined)?.path;
  const resultLength = typeof result === "string" ? result.length : 0;
  useEffect(() => {
    if (report && toolCallId) report(toolCallId, { toolName, args, result });
  }, [report, toolCallId, toolName, path, resultLength]);

  return (
    <div className="tool">
      <code>· {TOOL_LABELS[toolName] ?? toolName}</code>
    </div>
  );
}

function Composer({
  scope,
  onScope,
  dictation,
}: {
  scope: Scope;
  onScope: (s: Scope) => void;
  dictation: boolean;
}) {
  return (
    <div className="composer">
      <ComposerPrimitive.Root asChild>
        <form>
          <ComposerPrimitive.Input
            autoFocus
            rows={2}
            // Enter goes to the next line; only the button sends. Dictated and
            // written notes both tend to run over several lines.
            submitMode="none"
            placeholder="Écrire…"
          />
          <ComposerPrimitive.DictationTranscript asChild>
            <span className="transcript" />
          </ComposerPrimitive.DictationTranscript>

          <div className="composer-row">
            <ScopeSwitch scope={scope} onChange={onScope} />
            <div className="composer-actions">
              {dictation && (
                <>
                  <ComposerPrimitive.Dictate asChild>
                    <button type="button" className="mic" title="Dicter" aria-label="Dicter">
                      <Mic size={17} strokeWidth={1.9} aria-hidden />
                    </button>
                  </ComposerPrimitive.Dictate>
                  <ComposerPrimitive.StopDictation asChild>
                    <button
                      type="button"
                      className="mic"
                      data-recording="true"
                      title="Arrêter la dictée"
                      aria-label="Arrêter la dictée"
                    >
                      <Square size={15} strokeWidth={2} fill="currentColor" aria-hidden />
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
            </div>
          </div>
        </form>
      </ComposerPrimitive.Root>
      <div className="state">
        <ThreadPrimitive.If running>
          L'agent travaille — la sauvegarde a lieu en fin de tour.
        </ThreadPrimitive.If>
      </div>
    </div>
  );
}

function Conversation({
  threadId,
  scope,
  onScope,
  onTurnEnd,
  onCited,
}: {
  threadId: string;
  scope: Scope;
  onScope: (s: Scope) => void;
  onTurnEnd: () => void;
  onCited: (c: Cited) => void;
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

  // What the answer being written right now was built from. Cleared when a new
  // turn starts, so each question replaces the previous highlight instead of
  // piling onto it, and pages light up as the agent opens them.
  const [used, setUsed] = useState<Record<string, ToolPart>>({});
  // The reporting effect only fires when a call's arguments or result change,
  // so storing unconditionally cannot loop.
  const report = useCallback((id: string, part: ToolPart) => {
    setUsed((prev) => ({ ...prev, [id]: part }));
  }, []);
  // Its own ref: the turn-end effect above has already moved wasRunning by the
  // time this one runs.
  const turnStarted = useRef(false);
  useEffect(() => {
    if (running && !turnStarted.current) setUsed({});
    turnStarted.current = running;
  }, [running]);

  // Compared by value, not by identity: reporting a fresh object on every
  // render would loop through the parent.
  const sig = JSON.stringify(citedPages(Object.values(used)));
  useEffect(() => {
    onCited(JSON.parse(sig) as Cited);
  }, [sig, onCited]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <CiteSink.Provider value={report}>
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
          <Composer scope={scope} onScope={onScope} dictation={!!dictation} />
        </div>
      </ThreadPrimitive.Root>
      </CiteSink.Provider>
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
  const [cited, setCited] = useState<Cited>({ read: [], written: [] });

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
    setCited({ read: [], written: [] });
    loadGraph();
  }, [viewer, scope, loadGraph]);

  const highlighted = useMemo(() => [...cited.read, ...cited.written], [cited]);

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
        </div>

        <div className="who">
          <span title={viewer.email}>{viewer.name || viewer.email}</span>
          <button type="button" className="link" onClick={() => signOut()}>
            Se déconnecter
          </button>
        </div>
      </header>

      {error && <p className="error">⚠ {error}</p>}

      <div className="panes">
        <section className="pane pane-chat" aria-label="Conversation">
          {threadId ? (
            <Conversation
              key={threadId}
              threadId={threadId}
              scope={scope}
              onScope={setScope}
              onTurnEnd={loadGraph}
              onCited={setCited}
            />
          ) : (
            // The scope toggle stays put while the next conversation opens,
            // otherwise it flickers away on every switch.
            <div className="conv">
              <div className="viewport">
                <div className="pane-empty">{busy ? "Ouverture de la conversation…" : "…"}</div>
              </div>
              <div className="composer">
                <form onSubmit={(e) => e.preventDefault()}>
                  <textarea rows={2} placeholder="Écrire…" disabled />
                  <div className="composer-row">
                    <ScopeSwitch scope={scope} onChange={setScope} />
                  </div>
                </form>
                <div className="state" />
              </div>
            </div>
          )}
        </section>

        <section className="pane pane-graph" aria-label="Graphe du wiki">
          {highlighted.length > 0 && (
            <p className="cited-note">
              {highlighted.length === 1 ? "1 page a servi" : `${highlighted.length} pages ont servi`} à
              cette réponse
              <button type="button" className="link" onClick={() => setCited({ read: [], written: [] })}>
                tout réafficher
              </button>
            </p>
          )}
          <WikiGraph data={graph} selected={selected} onSelect={openPage} cited={cited} />
        </section>

        <section className="pane pane-page" aria-label="Page">
          <PagePane page={page} loading={pageLoading} onFollow={openPage} />
        </section>
      </div>
    </div>
  );
}
