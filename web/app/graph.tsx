"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from "@react-sigma/core";
// Without this, the container renders at zero height and nothing is drawn.
import "@react-sigma/core/lib/style.css";
import { createNodeBorderProgram } from "@sigma/node-border";
import Graph from "graphology";
import type Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { Cited } from "../lib/cited.ts";
import type { GraphNode, GraphEdge } from "../lib/wiki-view.ts";
import { MISSING_COLOUR, typeColour } from "./type-colours.ts";

/** Well-linked pages should read as hubs, so degree drives size generously. */
const nodeSize = (degree: number) => 6 + Math.sqrt(degree) * 5.5;

// Every node is drawn as a ring (`borderColor`) around a fill (`color`). Shared
// pages set both to the type colour and read as plain discs; private pages keep
// the ring and take the background as fill, so they read as hollow.
const NodeBorderProgram = createNodeBorderProgram({
  borders: [
    { color: { attribute: "borderColor", defaultValue: "#7d8a80" }, size: { value: 0.22 } },
    { color: { attribute: "color" }, size: { fill: true } },
  ],
});

/**
 * Frame the whole graph in the pane, labels included.
 *
 * Sigma's default camera fits the graph's bounding box into the smaller side of
 * the container, so a wide layout in a narrow pane runs off the edges. Measure
 * where the nodes actually landed in pixels and pick the ratio from that.
 */
function fit(sigma: Sigma) {
  const g = sigma.getGraph();
  if (!g.order) return;
  const camera = sigma.getCamera();
  camera.setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
  sigma.refresh();

  const { width, height } = sigma.getDimensions();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of g.nodes()) {
    const d = sigma.getNodeDisplayData(n);
    if (!d) continue;
    const v = sigma.framedGraphToViewport(d);
    // Labels sit to the right of the node; leave room for the text so the
    // longest title is not clipped against the edge of the pane.
    const pad = d.size + 8;
    minX = Math.min(minX, v.x - pad);
    maxX = Math.max(maxX, v.x + pad + String(d.label ?? "").length * 6.2);
    minY = Math.min(minY, v.y - pad);
    maxY = Math.max(maxY, v.y + pad);
  }
  if (!Number.isFinite(minX)) return;

  const ratio = Math.max((maxX - minX) / width, (maxY - minY) / height, 0.35) * 1.08;
  const centre = sigma.viewportToFramedGraph({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
  camera.setState({ x: centre.x, y: centre.y, ratio, angle: 0 });
  sigma.refresh();
}

/** The hollow fill has to be the pane's own background, in either theme. */
function paneBackground(): string {
  if (typeof window === "undefined") return "#f7f8f5";
  const v = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  return v || "#f7f8f5";
}

/** Faded to the background: present, but not part of this answer. */
const FADED = "#e2e6e0";

function Loader({
  data,
  selected,
  onSelect,
  cited,
}: {
  data: { nodes: GraphNode[]; edges: GraphEdge[] };
  selected: string | null;
  onSelect: (id: string) => void;
  cited: Cited;
}) {
  const load = useLoadGraph();
  const registerEvents = useRegisterEvents();
  const sigma = useSigma();
  const dragged = useRef<string | null>(null);
  const frozen = useRef(false);
  const [hollow, setHollow] = useState("#f7f8f5");

  useEffect(() => setHollow(paneBackground()), []);

  useEffect(() => {
    const g = new Graph();
    // Seed a circle rather than random positions: private and shared pages are
    // often separate components, and from a random start two of them can land
    // on the same spot and never push apart. A circle starts them spread out
    // and makes the layout the same on every load.
    const step = (2 * Math.PI) / Math.max(1, data.nodes.length);
    let i = 0;
    for (const n of data.nodes) {
      // A gap is drawn grey: knowledge that is expected but not written yet,
      // which the charter treats as useful rather than broken.
      const colour = n.missing ? MISSING_COLOUR : typeColour(n.type);
      g.addNode(n.id, {
        label: n.label,
        color: colour,
        borderColor: colour,
        size: nodeSize(n.degree),
        x: Math.cos(i * step),
        y: Math.sin(i * step),
        wetopiaPrivate: n.private,
      });
      i++;
    }
    for (const e of data.edges) {
      if (g.hasNode(e.source) && g.hasNode(e.target) && !g.hasEdge(e.source, e.target)) {
        g.addEdge(e.source, e.target, { size: 1.2, color: "#d4dad2" });
      }
    }
    if (g.order > 1) {
      forceAtlas2.assign(g, {
        iterations: 300,
        settings: { ...forceAtlas2.inferSettings(g), gravity: 1, scalingRatio: 12 },
      });
    }
    load(g);
    // Sigma caches the container size at init. In a grid pane that size arrives
    // after mount, and the stale value breaks hit detection: nodes draw in the
    // right place but clicks never reach them. Re-measure, then frame the graph.
    requestAnimationFrame(() => {
      sigma.resize();
      fit(sigma);
    });
  }, [data, load, sigma]);

  // The pane resizes with the window and when the layout switches breakpoints.
  useEffect(() => {
    const ro = new ResizeObserver(() => sigma.resize());
    ro.observe(sigma.getContainer());
    return () => ro.disconnect();
  }, [sigma]);

  useEffect(() => {
    function release() {
      const node = dragged.current;
      if (!node) return;
      sigma.getGraph().removeNodeAttribute(node, "highlighted");
      dragged.current = null;
      if (frozen.current) {
        sigma.setCustomBBox(null);
        frozen.current = false;
      }
    }

    registerEvents({
      clickNode: (e) => onSelect(e.node),

      // --- dragging: pull a page around and its links follow ---
      downNode: (e) => {
        dragged.current = e.node;
        sigma.getGraph().setNodeAttribute(e.node, "highlighted", true);
      },
      moveBody: ({ event }) => {
        if (!dragged.current) return;
        // Freeze the viewport on the first movement, not on mouse-down: a plain
        // click would otherwise set and clear the bounding box between press and
        // release, moving every node just as sigma resolves what was clicked.
        if (!frozen.current) {
          sigma.setCustomBBox(sigma.getBBox());
          frozen.current = true;
        }
        const pos = sigma.viewportToGraph(event);
        const g = sigma.getGraph();
        g.setNodeAttribute(dragged.current, "x", pos.x);
        g.setNodeAttribute(dragged.current, "y", pos.y);
        event.preventSigmaDefault();
        event.original.preventDefault();
        event.original.stopPropagation();
      },
      upNode: () => release(),
      upStage: () => release(),

      // Nodes live on a canvas, so an automated test has no element to target.
      // Clicking empty space publishes each node as drawn: viewport coordinates
      // to aim at it, graph coordinates to tell whether it moved (the viewport
      // ones shift whenever the bounding box is recomputed), colour and label
      // to tell whether the highlight applied.
      clickStage: () => {
        const g = sigma.getGraph();
        const where = g.nodes().map((n) => {
          const d = sigma.getNodeDisplayData(n);
          const v = d ? sigma.framedGraphToViewport(d) : null;
          return {
            id: n,
            vx: v ? Math.round(v.x) : null,
            vy: v ? Math.round(v.y) : null,
            x: Number(g.getNodeAttribute(n, "x").toFixed(3)),
            y: Number(g.getNodeAttribute(n, "y").toFixed(3)),
            // As drawn, after the reducer: how a check sees the highlight.
            color: d?.color ?? null,
            label: d?.label ?? "",
          };
        });
        console.debug("sigma place :", JSON.stringify(where));
      },
    });
  }, [registerEvents, onSelect, sigma]);

  // Selection, the private/shared distinction and the sources of the current
  // answer are drawn by the reducer rather than by mutating the graph, so they
  // survive re-layout and dragging.
  useEffect(() => {
    const read = new Set(cited.read);
    const written = new Set(cited.written);
    const answering = read.size + written.size > 0;
    const used = (id: string) => read.has(id) || written.has(id);

    sigma.setSetting("nodeReducer", (id, attrs) => {
      // In private scope both spaces are on screen at once, and the same
      // subject may legitimately have a page in each. Private pages are drawn
      // hollow and labelled, so the two are never taken for one another.
      let base: Record<string, unknown> = attrs.wetopiaPrivate
        ? { ...attrs, color: hollow, label: `${attrs.label} · privé` }
        : { ...attrs };

      if (answering) {
        if (used(id)) {
          // A page the agent wrote is not a source but a result; saying so
          // keeps « lue pour répondre » and « écrite en répondant » apart.
          base = {
            ...base,
            size: (attrs.size as number) + 3,
            zIndex: 2,
            forceLabel: true,
            label: written.has(id) ? `${base.label} · écrite` : base.label,
          };
        } else {
          // Still there, just not part of this answer.
          base = { ...base, color: FADED, borderColor: FADED, label: "", zIndex: 0 };
        }
      }

      return id === selected
        ? { ...base, size: (base.size as number) + 4, zIndex: 3, forceLabel: true, color: attrs.color }
        : base;
    });

    sigma.setSetting("edgeReducer", (edge, attrs) => {
      if (!answering) return attrs;
      const g = sigma.getGraph();
      const both = used(g.source(edge)) && used(g.target(edge));
      return both ? { ...attrs, color: "#9aa79c", size: 1.8, zIndex: 2 } : { ...attrs, color: "#edf0ec" };
    });

    sigma.refresh();
  }, [sigma, selected, hollow, cited]);

  return null;
}

export default function WikiGraph({
  data,
  selected,
  onSelect,
  cited = { read: [], written: [] },
}: {
  data: { nodes: GraphNode[]; edges: GraphEdge[] } | null;
  selected: string | null;
  onSelect: (id: string) => void;
  /** Pages the current answer was built from; empty means show everything. */
  cited?: Cited;
}) {
  const settings = useMemo(
    () => ({
      allowInvalidContainer: true,
      labelFont: "IBM Plex Sans, system-ui, sans-serif",
      labelSize: 11,
      labelColor: { color: "#5a665d" },
      defaultEdgeColor: "#d4dad2",
      enableEdgeEvents: false,
      nodeProgramClasses: { border: NodeBorderProgram },
      defaultNodeType: "border",
    }),
    [],
  );

  if (!data) return <div className="pane-empty">Chargement du graphe…</div>;
  if (!data.nodes.length) {
    return (
      <div className="pane-empty">
        Le wiki est encore vide.
        <span>Les pages écrites par l'agent apparaîtront ici, reliées par leurs liens.</span>
      </div>
    );
  }

  return (
    <SigmaContainer style={{ width: "100%", height: "100%" }} settings={settings}>
      <Loader data={data} selected={selected} onSelect={onSelect} cited={cited} />
    </SigmaContainer>
  );
}
