// MissionGraph — the dependency-graph view of a Mission's tasks, and the
// primary way to inspect a plan.
//
// It is a pure projection of the same `dependencies` the tier board and the
// durable Markdown read (v0.6 slice 2: no second graph state model). Layout and
// the acyclic check come from `missionGraph.ts`. Clicking a node opens a detail
// panel (title, phase/risk, worker, estimated cost·time, status, dependencies);
// dependency edits toggle back through the task's Markdown via
// `onToggleDependency`, so the graph never owns state the store doesn't.
import { useState } from "react";
import { layoutMission, wouldCreateCycle, type GraphTask } from "../agent/missionGraph";

export type MissionGraphMeta = {
  title: string;
  phase: string;
  /** Compiled task status: queued | ready | blocked | running | done | failed | … */
  status: string;
  risk?: "low" | "medium" | "high";
  description?: string;
  /** Effective worker/model label. */
  worker?: string;
  /** Pre-formatted estimate strings so the graph stays formatter-free. */
  cost?: string;
  time?: string;
  /** True when the estimated cost is above zero → render it emphasised. */
  costEmphasis?: boolean;
};

type MissionGraphProps = {
  tasks: GraphTask[];
  meta: Record<string, MissionGraphMeta>;
  editable: boolean;
  savingTaskId: string | null;
  onToggleDependency: (dependentId: string, prerequisiteId: string) => void;
};

const NODE_W = 216;
const NODE_H = 88;
const COL_GAP = 104;
const ROW_GAP = 30;
const PAD = 26;

function statusColor(status: string): string {
  if (status === "done") return "var(--accent)";
  if (status === "running") return "var(--accent)";
  if (status === "failed") return "var(--danger)";
  if (status === "interrupted") return "var(--warning)"; // restart artifact — retry, not a failure
  if (status === "ready") return "var(--fg-strong)";
  return "var(--border-strong)"; // queued / blocked
}

function riskColor(risk?: string): string {
  if (risk === "high") return "var(--danger)";
  if (risk === "medium") return "var(--warning)";
  return "var(--fg-dim)";
}

export function MissionGraph({ tasks, meta, editable, savingTaskId, onToggleDependency }: MissionGraphProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const { nodes, edges, layerCount } = layoutMission(tasks);

  // Center each layer's rows against the tallest layer so the graph reads
  // balanced rather than top-heavy.
  const rowsPerLayer = new Map<number, number>();
  for (const node of nodes) rowsPerLayer.set(node.layer, (rowsPerLayer.get(node.layer) ?? 0) + 1);
  const maxRows = Math.max(1, ...rowsPerLayer.values());

  const pos = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    const rows = rowsPerLayer.get(node.layer) ?? 1;
    const offset = ((maxRows - rows) * (NODE_H + ROW_GAP)) / 2;
    pos.set(node.id, {
      x: PAD + node.layer * (NODE_W + COL_GAP),
      y: PAD + offset + node.order * (NODE_H + ROW_GAP),
    });
  }

  const width = PAD * 2 + layerCount * NODE_W + (layerCount - 1) * COL_GAP;
  const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP;

  const selectedTask = selected ? tasks.find((task) => task.id === selected) ?? null : null;
  const selectedMeta = selected ? meta[selected] : null;

  // Would linking `selected` to depend on `prereqId` close a loop?
  function wouldCycle(dependentId: string, prereqId: string): boolean {
    if (dependentId === prereqId) return true;
    if (tasks.find((task) => task.id === dependentId)?.dependencies.includes(prereqId)) return false; // unlink is always ok
    return wouldCreateCycle(tasks, dependentId, prereqId);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <div style={{ minWidth: 0, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--bg-elevated)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 11.5, color: "var(--fg-subtle)", lineHeight: 1.5 }}>
            Click a task to open its detail{editable ? " and edit its dependencies." : "."}
          </span>
        </div>
        <div style={{ overflow: "auto" }}>
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block", minWidth: "100%" }} onClick={() => setSelected(null)}>
            <defs>
              <marker id="klide-graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M1 1 L7 4 L1 7" fill="none" stroke="var(--border-strong)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </marker>
            </defs>
            {edges.map((edge) => {
              const a = pos.get(edge.from);
              const b = pos.get(edge.to);
              if (!a || !b) return null;
              const x1 = a.x + NODE_W;
              const y1 = a.y + NODE_H / 2;
              const x2 = b.x;
              const y2 = b.y + NODE_H / 2;
              const mid = (x1 + x2) / 2;
              const touchesSel = selected !== null && (edge.from === selected || edge.to === selected);
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2 - 3} ${y2}`}
                  fill="none"
                  stroke={touchesSel ? "var(--accent)" : "var(--border-strong)"}
                  strokeWidth={touchesSel ? 1.8 : 1.3}
                  markerEnd="url(#klide-graph-arrow)"
                  style={{ transition: "stroke 140ms var(--ease-out)" }}
                />
              );
            })}
            {nodes.map((node) => {
              const p = pos.get(node.id);
              if (!p) return null;
              const m = meta[node.id];
              const status = m?.status ?? "queued";
              const isSelected = selected === node.id;
              const saving = savingTaskId === node.id;
              return (
                <g
                  key={node.id}
                  transform={`translate(${p.x}, ${p.y})`}
                  onClick={(event) => { event.stopPropagation(); setSelected(node.id); }}
                  style={{ cursor: "pointer" }}
                >
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={8}
                    fill="var(--bg)"
                    stroke={isSelected ? "var(--accent)" : "var(--border)"}
                    strokeWidth={isSelected ? 1.6 : 1}
                  />
                  <text x={16} y={28} fontSize={13.5} fontWeight={status === "ready" || status === "running" ? 600 : 500} fill="var(--fg-strong)" style={{ pointerEvents: "none" }}>
                    {truncate(m?.title ?? node.id, 26)}
                  </text>
                  <text x={16} y={51} fontSize={11} fontFamily="var(--font-mono)" style={{ pointerEvents: "none" }}>
                    {saving ? (
                      <tspan fill={statusColor(status)}>saving…</tspan>
                    ) : (
                      <>
                        <tspan fill="var(--fg-dim)">{m?.phase ?? ""}</tspan>
                        <tspan dx={10} fill={statusColor(status)}>{status}</tspan>
                      </>
                    )}
                  </text>
                  <text x={16} y={71} fontSize={11} fontFamily="var(--font-mono)" style={{ pointerEvents: "none" }}>
                    <tspan fill={m?.costEmphasis ? "var(--fg-strong)" : "var(--fg-subtle)"}>{m?.cost ?? "—"}</tspan>
                    <tspan dx={10} fill="var(--fg-dim)">~{m?.time ?? "—"}</tspan>
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {selectedTask && selectedMeta && (
        <section style={{ minWidth: 0, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--bg-elevated)", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 14, padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
            <span style={{ fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--fg-dim)" }}>{selectedMeta.phase}</span>
            <span style={{ fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: "0.05em", color: riskColor(selectedMeta.risk) }}>{selectedMeta.risk ?? "low"}</span>
            <span style={{ fontSize: "var(--fs-xs)", fontFamily: "var(--font-mono)", color: statusColor(selectedMeta.status) }}>{selectedMeta.status}</span>
            <button
              onClick={() => setSelected(null)}
              aria-label="Close detail"
              style={{ marginLeft: "auto", background: "transparent", border: "none", color: "var(--fg-dim)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}
            >
              ×
            </button>
          </div>
          <div style={{ padding: "16px 18px", display: "grid", gap: 16 }}>
            {/* Prose and the routing facts share a row until the panel narrows. */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, alignItems: "start" }}>
              <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
                <div style={{ fontSize: "var(--fs-lg, 15px)", fontWeight: 600, color: "var(--fg-strong)", lineHeight: 1.35 }}>{selectedMeta.title}</div>
                {selectedMeta.description && (
                  <div style={{ fontSize: "var(--fs-base)", color: "var(--fg-subtle)", lineHeight: 1.6, maxWidth: "68ch" }}>{selectedMeta.description}</div>
                )}
              </div>
              <div style={{ display: "grid", gap: 8, minWidth: 0, justifySelf: "stretch" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--fg-dim)" }}>Worker</span>
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedMeta.worker ?? "—"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--fg-dim)" }}>Estimated</span>
                  <span style={{ display: "inline-flex", gap: 10, fontSize: "var(--fs-xs)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--fg-subtle)" }}>
                    <span style={{ color: selectedMeta.costEmphasis ? "var(--fg-strong)" : "var(--fg-subtle)" }}>{selectedMeta.cost ?? "—"}</span>
                    <span style={{ color: "var(--fg-dim)" }}>~{selectedMeta.time ?? "—"}</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Dependencies span the full width so the toggles flow across the
                panel instead of wrapping inside a narrow column. */}
            <div style={{ paddingTop: 14, borderTop: "1px solid color-mix(in srgb, var(--border) 70%, transparent)" }}>
              <div style={{ fontSize: "var(--fs-xs)", color: "var(--fg-dim)", marginBottom: 9 }}>Depends on</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 6 }}>
                {tasks.filter((task) => task.id !== selected).map((task) => {
                  const linked = selectedTask.dependencies.includes(task.id);
                  const blocked = !linked && wouldCycle(selected!, task.id);
                  const label = meta[task.id]?.title ?? task.id;
                  return (
                    <button
                      key={task.id}
                      onClick={() => { if (editable && !blocked) onToggleDependency(selected!, task.id); }}
                      disabled={!editable || blocked || savingTaskId !== null}
                      aria-pressed={linked}
                      title={blocked ? "Linking here would create a cycle" : label}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        minWidth: 0,
                        textAlign: "left",
                        padding: "5px 10px",
                        borderRadius: "var(--radius-sm)",
                        border: "1px solid",
                        borderColor: linked ? "var(--accent)" : "var(--border)",
                        background: linked ? "color-mix(in srgb, var(--accent-soft) 40%, transparent)" : "transparent",
                        color: linked ? "var(--fg-strong)" : "var(--fg-subtle)",
                        cursor: editable && !blocked ? "pointer" : "default",
                        opacity: blocked ? 0.4 : 1,
                        fontSize: "var(--fs-xs)",
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                    </button>
                  );
                })}
                {tasks.length <= 1 && <div style={{ fontSize: "var(--fs-xs)", color: "var(--fg-dim)" }}>No other tasks</div>}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
