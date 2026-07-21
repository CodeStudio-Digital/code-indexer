import type {
  DbAlterAction,
  DbColumn,
  DbColumnSpec,
  DbDdlOp,
  DbDdlSpec,
  DbForeignKey,
  DbIndex,
  DbSchemaSnapshot,
  DbTableInfo,
} from '../types.js';

export interface SchemaMigrationChange {
  id: string;
  kind: 'table' | 'column' | 'index' | 'foreign-key';
  label: string;
  destructive: boolean;
  op: DbDdlOp;
  spec: DbDdlSpec;
}

function key(value: string): string {
  return value.toLocaleLowerCase();
}

function columnSpec(column: DbColumn): DbColumnSpec {
  return {
    name: column.name,
    type: column.dataType,
    nullable: column.nullable,
    default: column.defaultValue ?? null,
    primaryKey: column.isPrimaryKey,
    autoIncrement: column.isAutoIncrement,
  };
}

function sameColumn(source: DbColumn, target: DbColumn): boolean {
  return key(source.dataType.replace(/\s+/g, ' ')) === key(target.dataType.replace(/\s+/g, ' '))
    && source.nullable === target.nullable
    && String(source.defaultValue ?? '') === String(target.defaultValue ?? '')
    && source.isPrimaryKey === target.isPrimaryKey
    && Boolean(source.isAutoIncrement) === Boolean(target.isAutoIncrement);
}

function sameIndex(source: DbIndex, target: DbIndex): boolean {
  return source.unique === target.unique
    && source.columns.map(key).join('|') === target.columns.map(key).join('|');
}

function sameFk(source: DbForeignKey, target: DbForeignKey): boolean {
  return key(source.refSchema ?? '') === key(target.refSchema ?? '')
    && key(source.refTable) === key(target.refTable)
    && source.columns.map(key).join('|') === target.columns.map(key).join('|')
    && source.refColumns.map(key).join('|') === target.refColumns.map(key).join('|')
    && key(source.onDelete ?? '') === key(target.onDelete ?? '')
    && key(source.onUpdate ?? '') === key(target.onUpdate ?? '');
}

function alter(schema: string, table: string, id: string, kind: SchemaMigrationChange['kind'], label: string, action: DbAlterAction, destructive = false): SchemaMigrationChange {
  return {
    id,
    kind,
    label,
    destructive,
    op: 'alter',
    spec: { alter: { schema, table, actions: [action] } },
  };
}

function compareTable(source: DbTableInfo, target: DbTableInfo, targetSchema: string): SchemaMigrationChange[] {
  const out: SchemaMigrationChange[] = [];
  const targetColumns = new Map(target.columns.map((column) => [key(column.name), column]));
  const sourceColumns = new Map(source.columns.map((column) => [key(column.name), column]));
  for (const column of source.columns) {
    const current = targetColumns.get(key(column.name));
    if (!current) out.push(alter(targetSchema, target.name, `column:add:${target.name}:${column.name}`, 'column', `Adicionar coluna ${target.name}.${column.name}`, { kind: 'addColumn', column: columnSpec(column) }));
    else if (!sameColumn(column, current)) out.push(alter(targetSchema, target.name, `column:modify:${target.name}:${column.name}`, 'column', `Alinhar coluna ${target.name}.${column.name}`, { kind: 'modifyColumn', name: current.name, column: columnSpec(column) }));
  }
  for (const column of target.columns) {
    if (!sourceColumns.has(key(column.name))) out.push(alter(targetSchema, target.name, `column:drop:${target.name}:${column.name}`, 'column', `Remover coluna extra ${target.name}.${column.name}`, { kind: 'dropColumn', name: column.name }, true));
  }

  const targetIndexes = new Map((target.indexes ?? []).filter((index) => !index.primary).map((index) => [key(index.name), index]));
  const sourceIndexes = new Map((source.indexes ?? []).filter((index) => !index.primary).map((index) => [key(index.name), index]));
  for (const index of sourceIndexes.values()) {
    const current = targetIndexes.get(key(index.name));
    if (!current || !sameIndex(index, current)) {
      if (current) out.push(alter(targetSchema, target.name, `index:replace-drop:${target.name}:${index.name}`, 'index', `Recriar índice ${index.name} (remover atual)`, { kind: 'dropIndex', name: current.name }, true));
      out.push(alter(targetSchema, target.name, `index:add:${target.name}:${index.name}`, 'index', `Criar índice ${index.name}`, { kind: 'addIndex', index: { name: index.name, columns: index.columns, unique: index.unique } }));
    }
  }
  for (const index of targetIndexes.values()) {
    if (!sourceIndexes.has(key(index.name))) out.push(alter(targetSchema, target.name, `index:drop:${target.name}:${index.name}`, 'index', `Remover índice extra ${index.name}`, { kind: 'dropIndex', name: index.name }, true));
  }

  const targetFks = new Map((target.foreignKeys ?? []).map((fk) => [key(fk.name), fk]));
  const sourceFks = new Map((source.foreignKeys ?? []).map((fk) => [key(fk.name), fk]));
  for (const fk of sourceFks.values()) {
    const migrationFk = {
      ...fk,
      refSchema: !fk.refSchema || key(fk.refSchema) === key(source.schema) ? targetSchema : fk.refSchema,
    };
    const current = targetFks.get(key(fk.name));
    if (!current || !sameFk(migrationFk, current)) {
      if (current) out.push(alter(targetSchema, target.name, `fk:replace-drop:${target.name}:${fk.name}`, 'foreign-key', `Recriar FK ${fk.name} (remover atual)`, { kind: 'dropForeignKey', name: current.name }, true));
      out.push(alter(targetSchema, target.name, `fk:add:${target.name}:${fk.name}`, 'foreign-key', `Criar FK ${fk.name}`, { kind: 'addForeignKey', fk: migrationFk }));
    }
  }
  for (const fk of targetFks.values()) {
    if (!sourceFks.has(key(fk.name))) out.push(alter(targetSchema, target.name, `fk:drop:${target.name}:${fk.name}`, 'foreign-key', `Remover FK extra ${fk.name}`, { kind: 'dropForeignKey', name: fk.name }, true));
  }
  return out;
}

/** Build changes that make target match source. Destructive changes remain opt-in. */
export function diffSchemas(source: DbSchemaSnapshot, target: DbSchemaSnapshot): SchemaMigrationChange[] {
  const out: SchemaMigrationChange[] = [];
  const sourceTables = new Map(source.tables.map((table) => [key(table.name), table]));
  const targetTables = new Map(target.tables.map((table) => [key(table.name), table]));
  for (const table of source.tables) {
    const current = targetTables.get(key(table.name));
    if (!current) {
      out.push({
        id: `table:create:${table.name}`,
        kind: 'table',
        label: `Criar tabela ${table.name}`,
        destructive: false,
        op: 'create',
        spec: { create: { schema: target.schema, table: table.name, columns: table.columns.map(columnSpec) } },
      });
      const emptyTarget: DbTableInfo = { schema: target.schema, name: table.name, columns: [], indexes: [], foreignKeys: [] };
      out.push(...compareTable({ ...table, columns: [] }, emptyTarget, target.schema).filter((change) => change.kind !== 'column'));
    } else {
      out.push(...compareTable(table, current, target.schema));
    }
  }
  for (const table of target.tables) {
    if (!sourceTables.has(key(table.name))) out.push({
      id: `table:drop:${table.name}`,
      kind: 'table',
      label: `Remover tabela extra ${table.name}`,
      destructive: true,
      op: 'drop',
      spec: { drop: { schema: target.schema, table: table.name } },
    });
  }
  const priority = (change: SchemaMigrationChange): number => {
    if (change.id.startsWith('table:create:')) return 10;
    if (!change.destructive && change.kind === 'column') return 20;
    if (change.id.startsWith('index:replace-drop:')) return 25;
    if (!change.destructive && change.kind === 'index') return 30;
    if (change.kind === 'foreign-key' && change.destructive) return 35;
    if (!change.destructive && change.kind === 'foreign-key') return 40;
    if (change.kind === 'index') return 45;
    if (change.kind === 'column') return 50;
    return 60;
  };
  return out.sort((left, right) => priority(left) - priority(right));
}
