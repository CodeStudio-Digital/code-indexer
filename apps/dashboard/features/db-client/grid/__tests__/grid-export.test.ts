import { describe, it, expect } from "vitest";
import {
  toCsv,
  toCsvBody,
  toJson,
  toTsv,
  toInsertSql,
  toDumpInserts,
  cellToCopy,
} from "../grid-export.js";

describe("grid-export serializers", () => {
  describe("toCsv / toCsvBody", () => {
    it("emits a header line followed by rows", () => {
      const csv = toCsv(["id", "name"], [{ id: 1, name: "Alice" }]);
      expect(csv).toBe("id,name\n1,Alice");
    });

    it("returns only the header when there are no rows", () => {
      expect(toCsv(["id", "name"], [])).toBe("id,name");
    });

    it("toCsvBody omits the header line", () => {
      const body = toCsvBody(
        ["id", "name"],
        [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
        ],
      );
      expect(body).toBe("1,Alice\n2,Bob");
    });

    it("quotes and escapes cells containing commas", () => {
      const body = toCsvBody(["v"], [{ v: "a,b" }]);
      expect(body).toBe('"a,b"');
    });

    it("quotes and doubles embedded double-quotes", () => {
      const body = toCsvBody(["v"], [{ v: 'he said "hi"' }]);
      expect(body).toBe('"he said ""hi"""');
    });

    it("quotes cells containing newlines", () => {
      const body = toCsvBody(["v"], [{ v: "line1\nline2" }]);
      expect(body).toBe('"line1\nline2"');
      const cr = toCsvBody(["v"], [{ v: "a\rb" }]);
      expect(cr).toBe('"a\rb"');
    });

    it("renders null/undefined as an empty cell", () => {
      const body = toCsvBody(["a", "b"], [{ a: null, b: undefined }]);
      expect(body).toBe(",");
    });
  });

  describe("toJson", () => {
    it("normalizes nullish values to null and pretty-prints", () => {
      const json = toJson(["a", "b", "c"], [{ a: 1, b: null, c: undefined }]);
      const parsed = JSON.parse(json);
      expect(parsed).toEqual([{ a: 1, b: null, c: null }]);
      // pretty-printed with 2-space indentation (object keys nested under the
      // array element are indented 4 spaces).
      expect(json).toContain('\n    "a": 1');
    });

    it("projects only the requested columns", () => {
      const json = toJson(["id"], [{ id: 7, extra: "ignored" }]);
      expect(JSON.parse(json)).toEqual([{ id: 7 }]);
    });
  });

  describe("toTsv", () => {
    it("emits a tab-separated header and rows", () => {
      const tsv = toTsv(["id", "name"], [{ id: 1, name: "Alice" }]);
      expect(tsv).toBe("id\tname\n1\tAlice");
    });

    it("returns only the header when there are no rows", () => {
      expect(toTsv(["id", "name"], [])).toBe("id\tname");
    });

    it("collapses embedded tabs and newlines into a single space", () => {
      const tsv = toTsv(["v"], [{ v: "a\tb\nc\r\nd" }]);
      expect(tsv).toBe("v\na b c d");
    });
  });

  describe("toInsertSql (ANSI double-quoted idents)", () => {
    it("double-quotes the table and column identifiers", () => {
      const sql = toInsertSql("users", ["id", "name"], [{ id: 1, name: "Alice" }]);
      expect(sql).toBe(
        'INSERT INTO "users" ("id", "name") VALUES (1, \'Alice\');',
      );
    });

    it("escapes embedded double-quotes in identifiers", () => {
      const sql = toInsertSql('we"ird', ['c"ol'], [{ 'c"ol': 1 }]);
      expect(sql).toBe('INSERT INTO "we""ird" ("c""ol") VALUES (1);');
    });

    it("leaves numbers, bigints, and booleans unquoted; NULL for null", () => {
      const sql = toInsertSql(
        "t",
        ["n", "big", "bt", "bf", "nul"],
        [{ n: 42, big: 9007199254740993n, bt: true, bf: false, nul: null }],
      );
      expect(sql).toBe(
        'INSERT INTO "t" ("n", "big", "bt", "bf", "nul") VALUES (42, 9007199254740993, TRUE, FALSE, NULL);',
      );
    });

    it("single-quotes strings and escapes embedded single-quotes", () => {
      const sql = toInsertSql("t", ["v"], [{ v: "O'Brien" }]);
      expect(sql).toBe("INSERT INTO \"t\" (\"v\") VALUES ('O''Brien');");
    });

    it("emits one statement per row", () => {
      const sql = toInsertSql("t", ["id"], [{ id: 1 }, { id: 2 }]);
      expect(sql).toBe(
        'INSERT INTO "t" ("id") VALUES (1);\nINSERT INTO "t" ("id") VALUES (2);',
      );
    });
  });

  describe("toDumpInserts (engine-aware quoting)", () => {
    it("uses backticks for mysql", () => {
      const sql = toDumpInserts("mysql", "users", ["id"], [{ id: 1 }]);
      expect(sql).toBe("INSERT INTO `users` (`id`) VALUES (1);");
    });

    it("uses backticks for mariadb and doubles embedded backticks", () => {
      const sql = toDumpInserts("mariadb", "ta`ble", ["co`l"], [{ "co`l": 1 }]);
      expect(sql).toBe("INSERT INTO `ta``ble` (`co``l`) VALUES (1);");
    });

    it("uses ANSI double-quotes for non-mysql engines (e.g. postgres)", () => {
      const sql = toDumpInserts("postgres", "users", ["id"], [{ id: 1 }]);
      expect(sql).toBe('INSERT INTO "users" ("id") VALUES (1);');
    });

    it("shares the same literal rules as toInsertSql", () => {
      const sql = toDumpInserts(
        "postgres",
        "t",
        ["s", "n", "nul"],
        [{ s: "O'Brien", n: 5, nul: null }],
      );
      expect(sql).toBe(
        "INSERT INTO \"t\" (\"s\", \"n\", \"nul\") VALUES ('O''Brien', 5, NULL);",
      );
    });

    it("uses numeric booleans for SQL Server and Oracle", () => {
      expect(toDumpInserts("mssql", "flags", ["enabled"], [{ enabled: true }]))
        .toBe('INSERT INTO "flags" ("enabled") VALUES (1);');
      expect(toDumpInserts("oracle", "flags", ["enabled"], [{ enabled: false }]))
        .toBe('INSERT INTO "flags" ("enabled") VALUES (0);');
    });

    it("escapes MySQL backslashes in string literals", () => {
      expect(toDumpInserts("mysql", "paths", ["value"], [{ value: "C:\\tmp" }]))
        .toBe("INSERT INTO `paths` (`value`) VALUES ('C:\\\\tmp');");
    });
  });

  describe("cellToCopy", () => {
    it("renders null/undefined as an empty string", () => {
      expect(cellToCopy(null)).toBe("");
      expect(cellToCopy(undefined)).toBe("");
    });

    it("stringifies primitives and serializes objects as JSON", () => {
      expect(cellToCopy(42)).toBe("42");
      expect(cellToCopy(true)).toBe("true");
      expect(cellToCopy({ a: 1 })).toBe('{"a":1}');
    });
  });

  describe("Date serialization regression (no extra double-quotes)", () => {
    // JSON.stringify(date) yields a quote-wrapped ISO string ("...Z") which would
    // corrupt a bare CSV cell and an SQL string literal. asText must emit the
    // bare ISO timestamp instead.
    const fixed = new Date("2024-03-14T09:26:53.589Z");
    const iso = "2024-03-14T09:26:53.589Z";

    it("sanity: JSON.stringify would wrap the date in quotes", () => {
      expect(JSON.stringify(fixed)).toBe(`"${iso}"`);
    });

    it("CSV cell contains the bare ISO timestamp without surrounding quotes", () => {
      const body = toCsvBody(["ts"], [{ ts: fixed }]);
      expect(body).toBe(iso);
      expect(body).not.toContain('"');
    });

    it("TSV cell contains the bare ISO timestamp", () => {
      const tsv = toTsv(["ts"], [{ ts: fixed }]);
      expect(tsv).toBe(`ts\n${iso}`);
    });

    it("INSERT literal wraps the bare ISO in single quotes only (no double quotes)", () => {
      const sql = toInsertSql("t", ["ts"], [{ ts: fixed }]);
      expect(sql).toBe(`INSERT INTO "t" ("ts") VALUES ('${iso}');`);
      // the only quotes around the value are the SQL single-quotes
      expect(sql).not.toContain(`"${iso}"`);
      expect(sql).not.toContain(`'"${iso}"'`);
    });

    it("cellToCopy returns the bare ISO timestamp", () => {
      expect(cellToCopy(fixed)).toBe(iso);
    });
  });
});
