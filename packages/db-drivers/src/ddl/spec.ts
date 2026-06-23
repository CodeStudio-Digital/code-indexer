/**
 * Engine-neutral DDL specs. The structure editor produces these; `buildDdl`
 * renders the dialect SQL. Types are deliberately simple — enough for create
 * table + the common ALTER actions (add/drop/rename/modify column).
 */

export interface ColumnSpec {
  name: string;
  /** Engine type as chosen in the editor, e.g. 'VARCHAR(255)', 'INTEGER', 'jsonb'. */
  type: string;
  nullable?: boolean; // default true
  /** Raw default expression (already SQL), or null for none. */
  default?: string | null;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  unsigned?: boolean; // MySQL only
}

export interface CreateTableSpec {
  schema?: string;
  table: string;
  columns: ColumnSpec[];
}

export type AlterAction =
  | { kind: 'addColumn'; column: ColumnSpec }
  | { kind: 'dropColumn'; name: string }
  | { kind: 'renameColumn'; from: string; to: string }
  | { kind: 'modifyColumn'; name: string; column: ColumnSpec };

export interface AlterTableSpec {
  schema?: string;
  table: string;
  actions: AlterAction[];
}

export interface DropTableSpec {
  schema?: string;
  table: string;
}

export type DdlOp = 'create' | 'alter' | 'drop';

export interface DdlSpec {
  create?: CreateTableSpec;
  alter?: AlterTableSpec;
  drop?: DropTableSpec;
}
