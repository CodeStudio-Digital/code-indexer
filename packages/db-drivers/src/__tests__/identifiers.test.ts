import { describe, it, expect } from "vitest";
import { quoteIdent, placeholder, orderBySql } from "../sql/identifiers.js";
import type { DbEngine, TableSort } from "../types.js";

/**
 * Pure unit tests for the engine-aware identifier helpers. No native module is
 * touched, so these run everywhere (not ABI-gated). They pin the exact quoting,
 * placeholder style, and ORDER BY rendering per engine.
 */

const DOUBLE_QUOTE_ENGINES: DbEngine[] = ["postgres", "sqlite", "oracle"];
const BACKTICK_ENGINES: DbEngine[] = ["mysql", "mariadb"];

describe("quoteIdent", () => {
  for (const engine of DOUBLE_QUOTE_ENGINES) {
    it(`${engine}: wraps in double quotes`, () => {
      expect(quoteIdent(engine, "users")).toBe('"users"');
    });

    it(`${engine}: escapes embedded double quotes by doubling`, () => {
      expect(quoteIdent(engine, 'we"ird')).toBe('"we""ird"');
    });

    it(`${engine}: leaves backticks and brackets untouched`, () => {
      expect(quoteIdent(engine, "a`b]c")).toBe('"a`b]c"');
    });
  }

  for (const engine of BACKTICK_ENGINES) {
    it(`${engine}: wraps in backticks`, () => {
      expect(quoteIdent(engine, "users")).toBe("`users`");
    });

    it(`${engine}: escapes embedded backticks by doubling`, () => {
      expect(quoteIdent(engine, "we`ird")).toBe("`we``ird`");
    });

    it(`${engine}: leaves double quotes untouched`, () => {
      expect(quoteIdent(engine, 'a"b')).toBe('`a"b`');
    });
  }

  describe("mssql", () => {
    it("wraps in square brackets", () => {
      expect(quoteIdent("mssql", "users")).toBe("[users]");
    });

    it("escapes embedded closing brackets by doubling", () => {
      expect(quoteIdent("mssql", "we]ird")).toBe("[we]]ird]");
    });

    it("leaves opening brackets, double quotes and backticks untouched", () => {
      expect(quoteIdent("mssql", 'a[b"c`d')).toBe('[a[b"c`d]');
    });
  });

  it("handles empty identifier per engine", () => {
    expect(quoteIdent("postgres", "")).toBe('""');
    expect(quoteIdent("mysql", "")).toBe("``");
    expect(quoteIdent("mssql", "")).toBe("[]");
  });
});

describe("placeholder", () => {
  it("postgres: $N is 1-based", () => {
    expect(placeholder("postgres", 0)).toBe("$1");
    expect(placeholder("postgres", 1)).toBe("$2");
    expect(placeholder("postgres", 41)).toBe("$42");
  });

  it("mssql: @pN is 0-based", () => {
    expect(placeholder("mssql", 0)).toBe("@p0");
    expect(placeholder("mssql", 1)).toBe("@p1");
    expect(placeholder("mssql", 41)).toBe("@p41");
  });

  it("oracle: :N is 1-based", () => {
    expect(placeholder("oracle", 0)).toBe(":1");
    expect(placeholder("oracle", 1)).toBe(":2");
    expect(placeholder("oracle", 41)).toBe(":42");
  });

  it("mysql / mariadb / sqlite: positional ?", () => {
    for (const engine of ["mysql", "mariadb", "sqlite"] as DbEngine[]) {
      expect(placeholder(engine, 0)).toBe("?");
      expect(placeholder(engine, 5)).toBe("?");
    }
  });
});

describe("orderBySql", () => {
  it("returns null when orderBy is undefined", () => {
    expect(orderBySql("postgres", undefined)).toBeNull();
  });

  it("returns null when column is empty", () => {
    expect(orderBySql("postgres", { column: "", dir: "asc" })).toBeNull();
  });

  it("quotes the column and emits ASC for asc", () => {
    expect(orderBySql("postgres", { column: "created_at", dir: "asc" })).toBe('"created_at" ASC');
  });

  it("quotes the column and emits DESC for desc", () => {
    expect(orderBySql("postgres", { column: "created_at", dir: "desc" })).toBe('"created_at" DESC');
  });

  it("uses the engine's quoting for the column", () => {
    expect(orderBySql("mysql", { column: "created_at", dir: "asc" })).toBe("`created_at` ASC");
    expect(orderBySql("mssql", { column: "created_at", dir: "desc" })).toBe("[created_at] DESC");
  });

  it("escapes an injection-y column name while keeping the direction a closed enum", () => {
    const sort: TableSort = { column: 'x"; DROP TABLE t; --', dir: "asc" };
    expect(orderBySql("postgres", sort)).toBe('"x""; DROP TABLE t; --" ASC');
  });

  it("only ASC/DESC are possible: a non-'desc' dir falls back to ASC", () => {
    // The helper treats any direction other than the literal "desc" as ASC.
    const sort = { column: "c", dir: "asc" } as TableSort;
    expect(orderBySql("postgres", sort)).toBe('"c" ASC');
  });

  it("joins multiple columns into a comma-separated ORDER BY clause", () => {
    const sorts: TableSort[] = [
      { column: "a", dir: "asc" },
      { column: "b", dir: "desc" },
    ];
    const clause = sorts
      .map((s) => orderBySql("postgres", s))
      .filter((s): s is string => s !== null)
      .join(", ");
    expect(clause).toBe('"a" ASC, "b" DESC');
  });
});
