"use client";

import { X } from "lucide-react";
import Markdown from "react-markdown";
import type { PageView } from "../lib/wiki-view.ts";
import { typeColour, typeLabel } from "./type-colours.ts";

/** Says where the page lives — a property of the page, not part of its name. */
function Tags({ page }: { page: PageView }) {
  return (
    <>
      {page.type && (
        <span className="type-chip" style={{ background: typeColour(page.type) }}>
          {typeLabel(page.type)}
        </span>
      )}
      <span className="scope-chip" data-private={page.private}>
        {page.private ? "privé" : "partagé"}
      </span>
    </>
  );
}

export default function PagePane({
  page,
  loading,
  onFollow,
  onClose,
}: {
  page: PageView | null;
  loading: boolean;
  onFollow: (path: string) => void;
  onClose: () => void;
}) {
  const close = (
    <button type="button" className="pane-close" onClick={onClose} aria-label="Masquer ce panneau">
      <X size={16} strokeWidth={2} aria-hidden />
    </button>
  );

  if (loading) return <div className="pane-empty">Ouverture…</div>;
  if (!page) {
    return (
      <div className="pane-empty">
        Aucune page ouverte.
        <span>Cliquez sur un nœud du graphe pour lire la page correspondante.</span>
      </div>
    );
  }
  if (!page.exists) {
    return (
      <div className="page">
        <header className="page-head">
          <h2>{page.title}</h2>
          <span className="scope-chip" data-private={page.private}>
            {page.private ? "privé" : "partagé"}
          </span>
          {close}
        </header>
        <p className="gap">
          Cette page n'existe pas encore : d'autres pages y renvoient, mais personne ne l'a
          écrite. C'est une lacune, pas une erreur — dites-le à l'agent pour la combler.
        </p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <h2>{page.title}</h2>
        <Tags page={page} />
        {close}
      </header>
      <div className="page-body">
        <Markdown
          components={{
            // Wiki links stay inside the app: following one opens that page in
            // this pane instead of navigating away to a 404.
            a: ({ href, children }) => {
              const target = String(href ?? "");
              if (target.startsWith("/") && target.endsWith(".md")) {
                return (
                  <a
                    href={target}
                    onClick={(e) => {
                      e.preventDefault();
                      onFollow(target);
                    }}
                  >
                    {children}
                  </a>
                );
              }
              return (
                <a href={target} target="_blank" rel="noreferrer">
                  {children}
                </a>
              );
            },
          }}
        >
          {page.markdown}
        </Markdown>
      </div>
    </div>
  );
}
