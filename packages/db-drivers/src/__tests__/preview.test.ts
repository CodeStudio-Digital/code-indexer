import { describe, it, expect } from "vitest";
import { buildTablePreview } from "../sql/preview.js";

/**
 * Pure unit test for `buildTablePreview` — no native module, no live DB, so it
 * runs everywhere (NOT ABI-gated). It pins, per engine where it differs:
 *   - the pagination dialect (LIMIT/OFFSET vs OFFSET .. FETCH),
 *   - identifier quoting in WHERE / ORDER BY,
 *   - that WHERE values bind as positional params (never interpolated),
 *   - that ORDER BY emits the column quoted with a closed ASC/DESC direction.
 * Every assertion is on the EXACT sql string and the EXACT params array.
 */
describe("buildTablePreview", () => {
  describe("pagination dialect: LIMIT/OFFSET (postgres + mysql)", () => {
    it("postgres: continuous $-numbering, where params then limit(+1)/offset", () => {
      const { sql, params } = buildTablePreview("postgres", '"public"."t"', {
        limit: 100,
        offset: 200,
        orderBy: { column: "created", dir: "desc" },
        where: [
          { column: "name", op: "like", value: "%ada%" },
          { column: "age", op: ">=", value: "18" },
        ],
      });
      expect(sql).toBe(
        'SELECT * FROM "public"."t" WHERE "name" LIKE $1 AND "age" >= $2 ORDER BY "created" DESC LIMIT $3 OFFSET $4',
      );
      expect(params).toEqual(["%ada%", "18", 101, 200]);
    });

    it("mysql: `?` placeholders + backtick quoting, where then limit/offset", () => {
      const { sql, params } = buildTablePreview("mysql", "`db`.`t`", {
        limit: 50,
        offset: 0,
        orderBy: { column: "id", dir: "asc" },
        where: [{ column: "id", op: "=", value: "7" }],
      });
      expect(sql).toBe(
        "SELECT * FROM `db`.`t` WHERE `id` = ? ORDER BY `id` ASC LIMIT ? OFFSET ?",
      );
      expect(params).toEqual(["7", 51, 0]);
    });

    it("mariadb: shares the mysql LIMIT/OFFSET + backtick dialect", () => {
      const { sql, params } = buildTablePreview("mariadb", "`t`", {
        limit: 10,
        offset: 5,
      });
      expect(sql).toBe("SELECT * FROM `t` LIMIT ? OFFSET ?");
      expect(params).toEqual([11, 5]);
    });

    it("sqlite: double-quote idents, `?` placeholders, LIMIT/OFFSET", () => {
      const { sql, params } = buildTablePreview("sqlite", '"t"', {
        limit: 100,
        offset: 0,
      });
      expect(sql).toBe('SELECT * FROM "t" LIMIT ? OFFSET ?');
      expect(params).toEqual([101, 0]);
    });
  });

  describe("pagination dialect: OFFSET .. FETCH (mssql + oracle)", () => {
    it("mssql: square brackets, @pN, OFFSET/FETCH, where then offset then fetch(+1)", () => {
      const { sql, params } = buildTablePreview("mssql", "[dbo].[t]", {
        limit: 25,
        offset: 50,
        orderBy: { column: "x", dir: "desc" },
        where: [{ column: "x", op: "=", value: "a" }],
      });
      expect(sql).toBe(
        "SELECT * FROM [dbo].[t] WHERE [x] = @p0 ORDER BY [x] DESC OFFSET @p1 ROWS FETCH NEXT @p2 ROWS ONLY",
      );
      expect(params).toEqual(["a", 50, 26]);
    });

    it("mssql: synthesizes ORDER BY (SELECT NULL) when no orderBy is given", () => {
      const { sql, params } = buildTablePreview("mssql", "[dbo].[t]", {
        limit: 25,
        offset: 50,
      });
      expect(sql).toBe(
        "SELECT * FROM [dbo].[t] ORDER BY (SELECT NULL) OFFSET @p0 ROWS FETCH NEXT @p1 ROWS ONLY",
      );
      expect(params).toEqual([50, 26]);
    });

    it("oracle: double-quote idents, `:N` placeholders, OFFSET/FETCH", () => {
      const { sql, params } = buildTablePreview("oracle", '"S"."T"', {
        limit: 25,
        offset: 50,
        orderBy: { column: "id", dir: "asc" },
        where: [{ column: "id", op: ">", value: "3" }],
      });
      expect(sql).toBe(
        'SELECT * FROM "S"."T" WHERE "id" > :1 ORDER BY "id" ASC OFFSET :2 ROWS FETCH NEXT :3 ROWS ONLY',
      );
      expect(params).toEqual(["3", 50, 26]);
    });

    it("oracle: NO synthetic ORDER BY when orderBy is absent (unlike mssql)", () => {
      const { sql, params } = buildTablePreview("oracle", '"T"', {
        limit: 25,
        offset: 50,
      });
      expect(sql).toBe(
        'SELECT * FROM "T" OFFSET :1 ROWS FETCH NEXT :2 ROWS ONLY',
      );
      expect(params).toEqual([50, 26]);
    });
  });

  describe("WHERE is parameterized (values bind, never interpolated)", () => {
    it("the value text never appears in the SQL, only the placeholder does", () => {
      const evil = "1; DROP TABLE users;--";
      const { sql, params } = buildTablePreview("postgres", '"t"', {
        limit: 10,
        offset: 0,
        where: [{ column: "name", op: "=", value: evil }],
      });
      expect(sql).toBe('SELECT * FROM "t" WHERE "name" = $1 LIMIT $2 OFFSET $3');
      expect(sql).not.toContain(evil);
      expect(sql).not.toContain("DROP TABLE");
      expect(params).toEqual([evil, 11, 0]);
    });

    it("isnull/isnotnull bind no params; an unknown op is dropped", () => {
      const { sql, params } = buildTablePreview("postgres", '"t"', {
        limit: 10,
        offset: 0,
        where: [
          { column: "a", op: "isnull" },
          { column: "b", op: "isnotnull" },
          { column: "c", op: "bogus" as "like" },
        ],
      });
      expect(sql).toBe(
        'SELECT * FROM "t" WHERE "a" IS NULL AND "b" IS NOT NULL LIMIT $1 OFFSET $2',
      );
      expect(params).toEqual([11, 0]);
    });

    it("a missing value binds null (not omitted) so placeholder numbering stays aligned", () => {
      const { sql, params } = buildTablePreview("postgres", '"t"', {
        limit: 10,
        offset: 0,
        where: [{ column: "a", op: "=" }],
      });
      expect(sql).toBe('SELECT * FROM "t" WHERE "a" = $1 LIMIT $2 OFFSET $3');
      expect(params).toEqual([null, 11, 0]);
    });

    it("a condition with an empty column is skipped (no clause, no param)", () => {
      const { sql, params } = buildTablePreview("postgres", '"t"', {
        limit: 10,
        offset: 0,
        where: [{ column: "", op: "=", value: "x" }],
      });
      expect(sql).toBe('SELECT * FROM "t" LIMIT $1 OFFSET $2');
      expect(params).toEqual([11, 0]);
    });
  });

  describe("ORDER BY: column quoted per engine + closed ASC/DESC direction", () => {
    it("an unknown direction falls back to ASC, and the column is quoted not interpolated", () => {
      const { sql } = buildTablePreview("postgres", '"t"', {
        limit: 10,
        offset: 0,
        orderBy: { column: 'x"; DROP TABLE t;--', dir: "evil" as "asc" },
      });
      expect(sql).toBe(
        'SELECT * FROM "t" ORDER BY "x""; DROP TABLE t;--" ASC LIMIT $1 OFFSET $2',
      );
    });

    it("an orderBy with an empty column emits no ORDER BY at all", () => {
      const { sql, params } = buildTablePreview("mysql", "`t`", {
        limit: 10,
        offset: 0,
        orderBy: { column: "", dir: "desc" },
      });
      expect(sql).toBe("SELECT * FROM `t` LIMIT ? OFFSET ?");
      expect(params).toEqual([11, 0]);
    });
  });

  describe("identifier quoting in WHERE per engine", () => {
    it("each engine quotes the column with its own dialect", () => {
      expect(
        buildTablePreview("postgres", '"t"', {
          limit: 1,
          offset: 0,
          where: [{ column: "c", op: "=", value: "v" }],
        }).sql,
      ).toContain('"c" = $1');
      expect(
        buildTablePreview("mysql", "`t`", {
          limit: 1,
          offset: 0,
          where: [{ column: "c", op: "=", value: "v" }],
        }).sql,
      ).toContain("`c` = ?");
      expect(
        buildTablePreview("mssql", "[t]", {
          limit: 1,
          offset: 0,
          where: [{ column: "c", op: "=", value: "v" }],
        }).sql,
      ).toContain("[c] = @p0");
      expect(
        buildTablePreview("oracle", '"t"', {
          limit: 1,
          offset: 0,
          where: [{ column: "c", op: "=", value: "v" }],
        }).sql,
      ).toContain('"c" = :1');
      expect(
        buildTablePreview("sqlite", '"t"', {
          limit: 1,
          offset: 0,
          where: [{ column: "c", op: "=", value: "v" }],
        }).sql,
      ).toContain('"c" = ?');
    });
  });
});
