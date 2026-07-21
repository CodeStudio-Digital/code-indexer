import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, Table2 } from 'lucide-react';
import type { DbQueryResult } from '../types.js';

export interface PlanNode {
  id: string;
  label: string;
  relation?: string;
  details: string[];
  children: PlanNode[];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return objectValue(value[0]);
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return objectValue(parsed[0]);
    return objectValue(parsed);
  } catch {
    return null;
  }
}

function jsonNode(value: Record<string, unknown>, id: string): PlanNode {
  const root = objectValue(value.Plan) ?? objectValue(value.query_block) ?? value;
  const plan = objectValue(root.table) ?? root;
  const rawChildren = (Array.isArray(plan.Plans) ? plan.Plans : Array.isArray(plan.nested_loop) ? plan.nested_loop : []) as unknown[];
  const relation = String(plan['Relation Name'] ?? plan.table_name ?? (typeof plan.table === 'string' ? plan.table : ''));
  const label = String(plan['Node Type'] ?? plan.select_type ?? plan.message ?? (relation ? 'Table access' : 'Query block'));
  const details: string[] = [];
  const cost = plan['Total Cost'] ?? plan.cost_info;
  const rows = plan['Plan Rows'] ?? plan.rows_examined_per_scan ?? plan.rows;
  const access = plan['Access Type'] ?? plan.access_type;
  if (cost != null) details.push(`cost ${typeof cost === 'object' ? JSON.stringify(cost) : String(cost)}`);
  if (rows != null) details.push(`rows ${String(rows)}`);
  if (access != null) details.push(String(access));
  return {
    id,
    label,
    relation: relation || undefined,
    details,
    children: rawChildren.map((child, index) => jsonNode(objectValue(child) ?? { message: String(child) }, `${id}.${index}`)),
  };
}

function sqliteNodes(rows: Array<Record<string, unknown>>): PlanNode[] {
  const byId = new Map<string, PlanNode>();
  const roots: PlanNode[] = [];
  for (const [index, row] of rows.entries()) {
    const id = String(row.id ?? index);
    byId.set(id, { id, label: String(row.detail ?? row['QUERY PLAN'] ?? 'Operation'), details: [], children: [] });
  }
  for (const [index, row] of rows.entries()) {
    const node = byId.get(String(row.id ?? index))!;
    const parent = byId.get(String(row.parent ?? '-1'));
    if (parent && parent !== node) parent.children.push(node); else roots.push(node);
  }
  return roots;
}

function xmlAttribute(source: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`, 'i').exec(source)?.[1];
}

function showplanXml(xml: string): PlanNode[] {
  if (typeof DOMParser === 'undefined') {
    return [...xml.matchAll(/<RelOp\b([^>]*)>/gi)].map((match, index) => ({
      id: xmlAttribute(match[1], 'NodeId') ?? String(index),
      label: xmlAttribute(match[1], 'PhysicalOp') ?? xmlAttribute(match[1], 'LogicalOp') ?? 'RelOp',
      details: [
        xmlAttribute(match[1], 'EstimateRows') ? `rows ${xmlAttribute(match[1], 'EstimateRows')}` : '',
        xmlAttribute(match[1], 'EstimatedTotalSubtreeCost') ? `cost ${xmlAttribute(match[1], 'EstimatedTotalSubtreeCost')}` : '',
      ].filter(Boolean),
      children: [],
    }));
  }
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const operations = Array.from(document.getElementsByTagNameNS('*', 'RelOp'));
  const roots = operations.filter((operation) => {
    let parent = operation.parentElement;
    while (parent) {
      if (parent.localName === 'RelOp') return false;
      parent = parent.parentElement;
    }
    return true;
  });
  const convert = (operation: Element): PlanNode => {
    const direct = operations.filter((candidate) => {
      let parent = candidate.parentElement;
      while (parent && parent !== operation) {
        if (parent.localName === 'RelOp') return false;
        parent = parent.parentElement;
      }
      return parent === operation;
    });
    const object = Array.from(operation.getElementsByTagNameNS('*', 'Object'))[0];
    const relation = object?.getAttribute('Table')?.replace(/[\[\]]/g, '');
    return {
      id: operation.getAttribute('NodeId') ?? crypto.randomUUID(),
      label: operation.getAttribute('PhysicalOp') ?? operation.getAttribute('LogicalOp') ?? 'RelOp',
      relation: relation || undefined,
      details: [
        operation.getAttribute('EstimateRows') ? `rows ${operation.getAttribute('EstimateRows')}` : '',
        operation.getAttribute('EstimatedTotalSubtreeCost') ? `cost ${operation.getAttribute('EstimatedTotalSubtreeCost')}` : '',
      ].filter(Boolean),
      children: direct.map(convert),
    };
  };
  return roots.map(convert);
}

/** Normalize PostgreSQL/MySQL JSON and SQLite/Oracle tabular plans for one renderer. */
export function normalizePlan(result: DbQueryResult): PlanNode[] {
  const first = result.rows[0];
  if (!first) return [];
  for (const value of Object.values(first)) {
    if (typeof value === 'string' && /<ShowPlanXML\b/i.test(value)) return showplanXml(value);
    const parsed = objectValue(value);
    if (parsed) return [jsonNode(parsed, 'plan')];
  }
  if ('parent' in first && 'id' in first) return sqliteNodes(result.rows);
  // Oracle DBMS_XPLAN and plain-text fallbacks are a meaningful linear plan.
  return result.rows.map((row, index) => ({
    id: String(index),
    label: String(row.PLAN_TABLE_OUTPUT ?? row['QUERY PLAN'] ?? Object.values(row).join(' · ')),
    details: [],
    children: [],
  }));
}

function Node({ node, depth = 0 }: { node: PlanNode; depth?: number }) {
  return (
    <div className="relative" style={{ marginLeft: depth ? 22 : 0 }}>
      {depth > 0 && <span className="absolute -left-4 top-0 h-4 w-3 rounded-bl border-b border-l border-muted-foreground/30" />}
      <div className="mb-2 rounded-md border bg-card px-3 py-2 shadow-sm">
        <div className="flex items-center gap-2 text-xs font-medium">
          {node.relation ? <Table2 className="h-3.5 w-3.5 text-sky-500" /> : <GitBranch className="h-3.5 w-3.5 text-violet-500" />}
          <span>{node.label}</span>
          {node.relation && <span className="rounded bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] text-sky-500">{node.relation}</span>}
        </div>
        {node.details.length > 0 && <div className="mt-1 text-[10px] text-muted-foreground">{node.details.join(' · ')}</div>}
      </div>
      {node.children.map((child) => <Node key={child.id} node={child} depth={depth + 1} />)}
    </div>
  );
}

export function ExplainPlanView({ result }: { result: DbQueryResult }) {
  const { t } = useTranslation('dbClient');
  const nodes = useMemo(() => normalizePlan(result), [result]);
  if (nodes.length === 0) return <div className="p-3 text-xs text-muted-foreground">{t('query.emptyPlan')}</div>;
  return <div className="h-full overflow-auto bg-muted/10 p-3">{nodes.map((node) => <Node key={node.id} node={node} />)}</div>;
}
