"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessagePartText,
} from "@assistant-ui/react";
import { createPiHttpClient, usePiRuntime } from "@assistant-ui/react-pi";
import Markdown from "react-markdown";

type Scope = "private" | "shared";
type ThreadRow = { id: string; title?: string; workspacePath?: string };

const scopeOf = (t: ThreadRow): Scope => (t.workspacePath?.endsWith("shared") ? "shared" : "private");

const SCOPE_HINT: Record<Scope, string> = {
  private: "L'agent voit le wiki partagé et tes notes privées. Il n'écrit que chez toi.",
  shared: "L'agent ne voit que le wiki partagé. Ce que tu dis ici peut devenir une page pour tout le monde.",
};

/** Assistant text rendered as markdown — wiki links included. */
function MarkdownText() {
  const { text } = useMessagePartText();
  return <Markdown>{text}</Markdown>;
}

function ToolCall({ toolName }: { toolName: string }) {
  const label: Record<string, string> = {
    read_page: "lecture d'une page",
    search: "recherche dans le wiki",
    write_page: "écriture d'une page",
    append_log: "mise à jour du journal",
  };
  return (
    <div className="tool">
      <code>· {label[toolName] ?? toolName}</code>
    </div>
  );
}

function Messages() {
  return (
    <>
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
                <MessagePrimitive.Parts components={{ Text: MarkdownText, tools: { Fallback: ToolCall } }} />
              </div>
            </div>
          ),
        }}
      />
    </>
  );
}

function Composer({ scope }: { scope: Scope }) {
  return (
    <div className="composer">
      <ComposerPrimitive.Root asChild>
        <form>
          <ComposerPrimitive.Input
            autoFocus
            rows={1}
            placeholder={scope === "shared" ? "Écrire dans le wiki partagé…" : "Note privée, question…"}
          />
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
  const runtime = usePiRuntime({ client, threadId });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root asChild>
        <div className="chat">
          <div className="chat-head">
            <span className="badge" data-scope={scope}>
              {scope === "shared" ? "Partagé" : "Privé"}
            </span>
            <span className="sub">{SCOPE_HINT[scope]}</span>
          </div>
          <ThreadPrimitive.Viewport asChild>
            <div className="viewport">
              <ThreadPrimitive.Empty>
                <div className="empty">
                  <strong>{scope === "shared" ? "Conversation partagée" : "Conversation privée"}</strong>
                  {SCOPE_HINT[scope]}
                </div>
              </ThreadPrimitive.Empty>
              <Messages />
            </div>
          </ThreadPrimitive.Viewport>
          <Composer scope={scope} />
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

export default function Chat() {
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [active, setActive] = useState<ThreadRow | null>(null);
  const [newScope, setNewScope] = useState<Scope>("private");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/pi/threads");
      if (!res.ok) throw new Error(`liste des conversations : ${res.status}`);
      const rows: ThreadRow[] = await res.json();
      setThreads(rows);
      setError(null);
      return rows;
    } catch (e) {
      setError((e as Error).message);
      return [];
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = async () => {
    setCreating(true);
    try {
      // The scope is a request, not a path: the server decides which workspace
      // (and therefore which bundles) the conversation may ever touch.
      const res = await fetch("/api/pi/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: newScope }),
      });
      if (!res.ok) throw new Error(`création : ${res.status}`);
      const snap = await res.json();
      const row: ThreadRow = { id: snap.metadata.id, title: snap.metadata.title, workspacePath: snap.metadata.workspacePath };
      setActive(row);
      await refresh();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const grouped = useMemo(
    () => ({
      shared: threads.filter((t) => scopeOf(t) === "shared"),
      private: threads.filter((t) => scopeOf(t) === "private"),
    }),
    [threads],
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>Wetopia</h1>
          <span>Le wiki de la communauté</span>
        </div>

        <div className="newbox">
          <div className="scope-switch" role="group" aria-label="Portée de la nouvelle conversation">
            <button type="button" data-on={newScope === "private"} onClick={() => setNewScope("private")}>
              Privé
            </button>
            <button type="button" data-on={newScope === "shared"} onClick={() => setNewScope("shared")}>
              Partagé
            </button>
          </div>
          <button className="newbtn" onClick={create} disabled={creating}>
            {creating ? "Création…" : "Nouvelle conversation"}
          </button>
          <p className="scope-hint">{SCOPE_HINT[newScope]}</p>
        </div>

        <nav className="threads">
          {(["shared", "private"] as const).map((s) =>
            grouped[s].length ? (
              <div key={s}>
                <h2>{s === "shared" ? "Partagées" : "Privées"}</h2>
                {grouped[s].map((t) => (
                  <button
                    key={t.id}
                    className="thread-item"
                    data-active={active?.id === t.id}
                    onClick={() => setActive(t)}
                  >
                    <span className="dot" data-scope={s} />
                    <span className="thread-title">{t.title || "Sans titre"}</span>
                  </button>
                ))}
              </div>
            ) : null,
          )}
          {error && <p className="scope-hint">⚠ {error}</p>}
        </nav>
      </aside>

      {active ? (
        <Conversation key={active.id} threadId={active.id} scope={scopeOf(active)} />
      ) : (
        <div className="chat">
          <div className="empty">
            <strong>Bienvenue</strong>
            Choisis une portée puis démarre une conversation. Ce que tu écris en privé reste privé ; le wiki partagé ne
            reçoit que ce que tu dis dans une conversation partagée.
          </div>
        </div>
      )}
    </div>
  );
}
