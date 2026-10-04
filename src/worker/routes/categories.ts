import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { CATEGORY_KINDS } from "../db/schema";
import { idParam, isUniqueViolation, parseBody } from "./query";

// Categories are never deleted: archiving hides one from pickers while rules, overrides and
// past months keep pointing at it (docs/phase-2-spec.md, Data model).

const COLUMNS = "id, name, kind, archived_at IS NOT NULL AS archived";
type Row = { id: number; name: string; kind: string; archived: number };
const toCategory = (r: Row) => ({ id: r.id, name: r.name, kind: r.kind, archived: r.archived === 1 });

// Untrusted display text; React escapes it.
const name = z.string().trim().min(1).max(50);
const kind = z.enum(CATEGORY_KINDS);

export const categoryRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const { results } = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM categories ORDER BY id`).all<Row>();
    return c.json({ categories: results.map(toCategory) });
  })
  .post("/", async (c) => {
    const body = await parseBody(c, z.object({ name, kind }));
    if (!body.ok) return body.res;
    const now = new Date().toISOString();
    try {
      const row = await c.env.DB.prepare(
        `INSERT INTO categories (name, kind, created_at, updated_at) VALUES (?1, ?2, ?3, ?3) RETURNING ${COLUMNS}`,
      )
        .bind(body.data.name, body.data.kind, now)
        .first<Row>();
      return c.json({ category: toCategory(row!) }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) return c.json({ error: "name_taken" }, 409);
      throw e;
    }
  })
  .patch("/:id", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad_request" }, 400);
    const body = await parseBody(
      c,
      z
        .object({ name: name.optional(), kind: kind.optional(), archived: z.boolean().optional() })
        .refine((b) => b.name !== undefined || b.kind !== undefined || b.archived !== undefined),
    );
    if (!body.ok) return body.res;
    const { name: newName, kind: newKind, archived } = body.data;
    try {
      // Archiving an archived category keeps its original archive time.
      const row = await c.env.DB.prepare(
        `UPDATE categories SET name = COALESCE(?2, name), kind = COALESCE(?3, kind),
           archived_at = CASE WHEN ?4 IS NULL THEN archived_at WHEN ?4 = 1 THEN COALESCE(archived_at, ?5) ELSE NULL END,
           updated_at = ?5
         WHERE id = ?1 RETURNING ${COLUMNS}`,
      )
        .bind(id, newName ?? null, newKind ?? null, archived === undefined ? null : archived ? 1 : 0, new Date().toISOString())
        .first<Row>();
      return row ? c.json({ category: toCategory(row) }) : c.json({ error: "not_found" }, 404);
    } catch (e) {
      if (isUniqueViolation(e)) return c.json({ error: "name_taken" }, 409);
      throw e;
    }
  });
