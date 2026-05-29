import { useMemo, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { WorkerLogEntry } from '../../hooks/agent-stream/types.js';
import { buildExecutionGraph, type ExecNode } from './ExecutionMapGraph.js';

interface ExecutionMapPanelProps {
  entries: readonly WorkerLogEntry[];
}

export function ExecutionMapPanel({ entries }: ExecutionMapPanelProps) {
  const graph = useMemo(() => buildExecutionGraph(entries), [entries]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? graph.nodes.find((n) => n.id === selectedId) : null;
  const related = selectedId ? graph.relatedEvents.get(selectedId) ?? [] : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <ReactFlowProvider>
          <ReactFlow<ExecNode, Edge>
            nodes={graph.nodes}
            edges={graph.edges}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
          >
            <Background gap={18} />
            <MiniMap pannable zoomable className="!bg-card/80" />
            <Controls />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      <div className="max-h-56 overflow-auto border-t border-border p-2 text-[10px]">
        {selected ? (
          <>
            <div className="mb-1 font-semibold">{selected.data.label}</div>
            <pre className="whitespace-pre-wrap rounded bg-background/60 p-2">
              {JSON.stringify(selected.data.detail, null, 2)}
            </pre>
            <div className="mt-2 text-muted-foreground">{related.length} related event(s)</div>
          </>
        ) : (
          <div className="text-muted-foreground">Select a node to inspect status and related events.</div>
        )}
      </div>
    </div>
  );
}
