import { describe, expect, it } from 'vitest';
import { normalizePlan } from '../ExplainPlanView.js';

describe('normalizePlan', () => {
  it('normalizes PostgreSQL JSON plans', () => {
    const [plan] = normalizePlan({
      rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'users', 'Plan Rows': 12 } }] }],
      rowCount: 1,
      fields: [],
    });
    expect(plan).toMatchObject({ label: 'Seq Scan', relation: 'users', details: ['rows 12'] });
  });

  it('builds SQLite parent/child trees', () => {
    const [plan] = normalizePlan({
      rows: [{ id: 1, parent: 0, detail: 'SCAN users' }, { id: 2, parent: 1, detail: 'SEARCH orders' }],
      rowCount: 2,
      fields: [],
    });
    expect(plan.label).toBe('SCAN users');
    expect(plan.children[0].label).toBe('SEARCH orders');
  });

  it('normalizes MySQL JSON table access', () => {
    const [plan] = normalizePlan({
      rows: [{ EXPLAIN: JSON.stringify({ query_block: { table: { table_name: 'orders', access_type: 'ref', rows_examined_per_scan: 4 } } }) }],
      rowCount: 1,
      fields: [],
    });
    expect(plan).toMatchObject({ relation: 'orders', details: ['rows 4', 'ref'] });
  });

  it('normalizes SQL Server ShowPlan XML', () => {
    const [plan] = normalizePlan({
      rows: [{ showplan: '<ShowPlanXML><RelOp NodeId="0" PhysicalOp="Index Seek" EstimateRows="2" EstimatedTotalSubtreeCost="0.1" /></ShowPlanXML>' }],
      rowCount: 1,
      fields: [],
    });
    expect(plan).toMatchObject({ label: 'Index Seek', details: ['rows 2', 'cost 0.1'] });
  });
});
