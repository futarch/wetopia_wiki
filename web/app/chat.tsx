"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  groupPartByType,
  useMessagePartText,
} from "@assistant-ui/react";
import { createPiHttpClient, usePiRuntime } from "@assistant-ui/react-pi";
import dynamic from "next/dynamic";
import { ChevronRight, Mic, PanelRightClose, PanelRightOpen, Square } from "lucide-react";
import Markdown from "react-markdown";
import { useViewer, signOut } from "../lib/auth-client.ts";
import {
  WetopiaDictationAdapter,
  isDictationSupported,
  type DictationPhase,
} from "../lib/dictation.ts";
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

/** Below this the three panes cannot sit side by side, so only one is shown. */
const NARROW = "(max-width: 1100px)";

/**
 * Whether the layout is showing one pane at a time.
 *
 * CSS decides what is visible, so the first paint is right whatever this says;
 * the value only drives behaviour that CSS cannot express, like opening a page
 * bringing its pane to the front.
 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return narrow;
}

type View = "chat" | "graph" | "page";

const VIEW_LABELS: Record<View, string> = { chat: "Conversation", graph: "Graphe", page: "Page" };

/** One pane at a time, on a screen too narrow for three. */
function ViewSwitch({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <nav className="view-switch" aria-label="Panneau affiché">
      {(Object.keys(VIEW_LABELS) as View[]).map((v) => (
        <button key={v} type="button" data-on={view === v} onClick={() => onChange(v)}>
          {VIEW_LABELS[v]}
        </button>
      ))}
    </nav>
  );
}

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

/**
 * What the agent did before answering, folded into one line.
 *
 * react-pi projects a turn's tool calls as adjacent parts of the assistant
 * message, so laid out flat they push the answer down the screen and read as
 * noise between the question and its reply. Adjacent ones are coalesced into a
 * single group here and shown closed: the line says what is happening, opening
 * it shows the steps.
 */
function Steps({ running, count, children }: { running: boolean; count: number; children: ReactNode }) {
  return (
    <details className="steps" data-running={running}>
      <summary>
        <ChevronRight className="chev" size={14} strokeWidth={2} aria-hidden />
        {running ? "Consultation du wiki…" : `${count} étape${count > 1 ? "s" : ""} dans le wiki`}
      </summary>
      <div className="steps-body">{children}</div>
    </details>
  );
}

/**
 * What the microphone is doing, in words.
 *
 * Our adapter records first and transcribes at the end, so there is no live
 * transcript to show and nothing moves on screen for several seconds. Without
 * this the only sign of life is a button changing colour, and people talk into
 * a microphone that is not listening — or stop talking while it still is.
 */
function DictationState({ dictation }: { dictation: WetopiaDictationAdapter }) {
  const [phase, setPhase] = useState<DictationPhase>(dictation.phase);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => dictation.watch(setPhase), [dictation]);
  useEffect(() => {
    if (phase !== "recording") {
      setSeconds(0);
      return;
    }
    // A counter that moves is the proof the microphone is live.
    const started = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(id);
  }, [phase]);

  if (phase === "idle") return null;
  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <p className="dictation" data-phase={phase} role="status">
      <span className="dot" aria-hidden />
      {phase === "starting" && "Ouverture du micro…"}
      {phase === "recording" && <>Enregistrement · {mmss} — parlez, puis appuyez sur ⏹</>}
      {phase === "transcribing" && "Transcription en cours…"}
    </p>
  );
}

function Composer({
  scope,
  onScope,
  dictation,
}: {
  scope: Scope;
  onScope: (s: Scope) => void;
  dictation: WetopiaDictationAdapter | undefined;
}) {
  return (
    <div className="composer">
      {dictation && <DictationState dictation={dictation} />}
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
}: {
  threadId: string;
  scope: Scope;
  onScope: (s: Scope) => void;
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
                        <MessagePrimitive.GroupedParts
                          groupBy={groupPartByType({
                            "tool-call": ["group-steps"],
                            reasoning: ["group-steps"],
                          })}
                          // The composer already says the agent is working; a
                          // second dot below the message would only repeat it.
                          indicator="never"
                        >
                          {({ part, children }) => {
                            switch (part.type) {
                              case "group-steps":
                                return (
                                  <Steps
                                    running={part.status?.type === "running"}
                                    count={part.indices.length}
                                  >
                                    {children}
                                  </Steps>
                                );
                              case "text":
                                return <MarkdownText />;
                              case "tool-call":
                                return <ToolCall toolName={part.toolName} />;
                              default:
                                return null;
                            }
                          }}
                        </MessagePrimitive.GroupedParts>
                      </div>
                    </div>
                  ),
                }}
              />
            </div>
          </ThreadPrimitive.Viewport>
          <Composer scope={scope} onScope={onScope} dictation={dictation} />
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
  const [showPage, setShowPage] = useState(true);
  const [view, setView] = useState<View>("chat");
  const narrow = useNarrow();

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
      // Opening a page has to put it in front of you: hidden on a wide screen,
      // or behind another pane on a narrow one, the click would do nothing
      // visible.
      setShowPage(true);
      if (narrow) setView("page");
      try {
        const res = await fetch(`/api/wiki/page?scope=${scope}&path=${encodeURIComponent(p)}`);
        setPage(res.ok ? await res.json() : null);
      } catch {
        setPage(null);
      } finally {
        setPageLoading(false);
      }
    },
    [scope, narrow],
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
        </div>

        <ViewSwitch view={view} onChange={setView} />

        <div className="who">
          <button
            type="button"
            className="pane-toggle"
            onClick={() => setShowPage((v) => !v)}
            aria-pressed={showPage}
            title={showPage ? "Masquer le panneau de lecture" : "Afficher le panneau de lecture"}
          >
            {showPage ? (
              <PanelRightClose size={17} strokeWidth={1.8} aria-hidden />
            ) : (
              <PanelRightOpen size={17} strokeWidth={1.8} aria-hidden />
            )}
            <span>{showPage ? "Masquer la page" : "Afficher la page"}</span>
          </button>
          <span className="viewer" title={viewer.email}>
            {viewer.name || viewer.email}
          </span>
          <button type="button" className="link" onClick={() => signOut()}>
            Se déconnecter
          </button>
        </div>
      </header>

      {error && <p className="error">⚠ {error}</p>}

      <div className="panes" data-view={view} data-page={showPage}>
        <section className="pane pane-chat" aria-label="Conversation">
          {threadId ? (
            <Conversation
              key={threadId}
              threadId={threadId}
              scope={scope}
              onScope={setScope}
              onTurnEnd={loadGraph}
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
          <WikiGraph data={graph} selected={selected} onSelect={openPage} />
        </section>

        <section className="pane pane-page" aria-label="Page">
          <PagePane
            page={page}
            loading={pageLoading}
            onFollow={openPage}
            onClose={() => setShowPage(false)}
          />
        </section>
      </div>
    </div>
  );
}
