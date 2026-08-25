"use client";

import { useEffect, useMemo } from "react";
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from "@react-sigma/core";
// Without this, the container renders at zero height and nothing is drawn.
import "@react-sigma/core/lib/style.css";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { GraphNode, GraphEdge } from "../lib/wiki-view.ts";
import { MISSING_COLOUR, typeColour } from "./type-colours.ts";

function Loader({
  data,
  selected,
  onSelect,
}: {
  data: { nodes: GraphNode[]; edges: GraphEdge[] };
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const load = useLoadGraph();
  const registerEvents = useRegisterEvents();
  const sigma = useSigma();

  useEffect(() => {
    const g = new Graph();
    for (const n of data.nodes) {
      g.addNode(n.id, {
        label: n.label,
        // A gap is drawn hollow and grey: it marks knowledge that is expected
        // but not written yet, which the charter treats as useful, not broken.
        color: n.missing ? MISSING_COLOUR : typeColour(n.type),
        size: Math.min(14, 5 + n.degree * 1.4),
        type: n.missing ? "circle" : "circle",
        x: Math.random(),
        y: Math.random(),
        wetopiaMissing: n.missing,
        wetopiaPrivate: n.private,
      });
    }
    for (const e of data.edges) {
      if (g.hasNode(e.source) && g.hasNode(e.target) && !g.hasEdge(e.source, e.target)) {
        g.addEdge(e.source, e.target, { size: 1, color: "#d4dad2" });
      }
    }
    if (g.order > 1) {
      forceAtlas2.assign(g, { iterations: 120, settings: { gravity: 1.4, scalingRatio: 12 } });
    }
    load(g);
    // Sigma caches the container size at init. In a grid/flex pane that size
    // arrives after mount, and the stale value breaks hit detection: nodes draw
    // in the right place but clicks never reach them. Re-measure, then pull the
    // camera back slightly so edge labels have room.
    requestAnimationFrame(() => {
      sigma.resize();
      const camera = sigma.getCamera();
      camera.setState({ ...camera.getState(), ratio: 1.25 });
      sigma.refresh();
    });
  }, [data, load, sigma]);

  // The pane resizes with the window and when the layout switches breakpoints.
  useEffect(() => {
    const el = sigma.getContainer();
    const ro = new ResizeObserver(() => sigma.resize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [sigma]);

  useEffect(() => {
    registerEvents({
      clickNode: (e) => onSelect(e.node),
      // Nodes live on a canvas, so an automated test has no element to target.
      // Clicking empty space publishes where sigma placed each node, which is
      // the only way the browser check can aim at one.
      clickStage: () => {
        const where = sigma.getGraph().nodes().map((n) => {
          const d = sigma.getNodeDisplayData(n);
          const v = d ? sigma.framedGraphToViewport(d) : null;
          return `${n} @ ${v ? `${Math.round(v.x)},${Math.round(v.y)}` : "?"}`;
        });
        console.debug("sigma place :", where.join(" | "));
      },
    });
  }, [registerEvents, onSelect, sigma]);

  // Selection is drawn by the reducer rather than by mutating the graph, so it
  // survives re-layout and never desynchronises from the pane on the right.
  useEffect(() => {
    sigma.setSetting("nodeReducer", (id, attrs) => {
      const missing = attrs.wetopiaMissing as boolean;
      if (id === selected) {
        return { ...attrs, size: (attrs.size as number) + 4, zIndex: 1, forceLabel: true };
      }
      return missing ? { ...attrs, label: `${attrs.label} ·` } : attrs;
    });
    sigma.refresh();
  }, [sigma, selected]);

  return null;
}

export default function WikiGraph({
  data,
  selected,
  onSelect,
}: {
  data: { nodes: GraphNode[]; edges: GraphEdge[] } | null;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const settings = useMemo(
    () => ({
      allowInvalidContainer: true,
      labelFont: "IBM Plex Sans, system-ui, sans-serif",
      labelSize: 11,
      labelColor: { color: "#5a665d" },
      defaultEdgeColor: "#d4dad2",
      renderEdgeLabels: false,
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
      <Loader data={data} selected={selected} onSelect={onSelect} />
    </SigmaContainer>
  );
}
