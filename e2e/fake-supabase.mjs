// =============================================================================
// ブラウザ自動テスト専用の「偽の Supabase」（ローカル専用・本番には一切接続しない）
//
// - PGlite（メモリ上の PostgreSQL）に supabase/migrations の 7 本をすべて適用し、
//   管理画面が使う範囲の REST（PostgREST 相当）と Auth（ログイン・ユーザー取得・ログアウト）を再現する
// - ログイン中のリクエストは authenticated ロール＋JWT の sub で実行するため、本番と同じ RLS・列の権限が効く
// - データはメモリ上だけにあり、プロセスの終了で消える（/__e2e/reset で初期状態に戻せる）
// - 127.0.0.1 でだけ待ち受ける
// =============================================================================
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const PORT = Number(process.env.E2E_FAKE_SUPABASE_PORT ?? 54329);
const ROOT = process.cwd();

/** テスト専用のダミーのアカウント（本番のアカウントとは無関係） */
// （e2e/fixtures.ts と同じ値。実在しないドメイン .test のダミー）
const E2E_ADMIN = { id: "e2e00000-0000-4000-8000-000000000001", email: "admin@e2e.test", password: "e2e-admin-password" };
const E2E_NON_ADMIN = { id: "e2e00000-0000-4000-8000-000000000002", email: "staff@e2e.test", password: "e2e-staff-password" };
const USERS = [E2E_ADMIN, E2E_NON_ADMIN];

const STUB = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth; grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public
    grant maintain, references, trigger, truncate on tables to anon, authenticated, service_role;
`;

const SEED = `
  insert into auth.users (id) values ('${E2E_ADMIN.id}'), ('${E2E_NON_ADMIN.id}');
  insert into public.admin_users (user_id, display_name) values ('${E2E_ADMIN.id}', 'E2E 管理者');
  update public.shop_settings set shop_name = 'E2E テスト店', phone = '03-0000-0000' where id = 1;
  insert into public.conversations (id, line_event_id, line_user_id, message_type, user_message, ai_status, bot_reply, reply_method, needs_owner, owner_notified_at, created_at)
  values
    ('e2e00000-0000-4000-8000-0000000000c1', 'e2e-ev-1', 'U${"1".repeat(32)}', 'text', 'E2E：シャンプーは売っていますか', 'cannot_answer', '確認が必要です', 'reply', true, now(), now() - interval '2 hours'),
    ('e2e00000-0000-4000-8000-0000000000c2', 'e2e-ev-2', 'U${"2".repeat(32)}', 'text', 'E2E：駐車場はありますか', 'cannot_answer', '確認が必要です', 'reply', true, null, now() - interval '1 hour'),
    ('e2e00000-0000-4000-8000-0000000000c3', 'e2e-ev-3', 'U${"3".repeat(32)}', 'text', 'E2E：営業時間は？', 'answered', '10時からです', 'reply', false, null, now() - interval '3 days');
`;

let db;
let queue = Promise.resolve();
/** PGlite は 1 接続のため、リクエストを 1 件ずつ順番に処理する */
const serial = (fn) => (queue = queue.then(fn, fn));

async function resetDb() {
  if (db) await db.close();
  db = new PGlite();
  await db.exec(STUB);
  const dir = join(ROOT, "supabase", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
  await db.exec(SEED);
}

// ---------------------------------------------------------------------------
// Auth（JWT は署名なしの検査用。偽のサーバーの中でだけ通用する）
// ---------------------------------------------------------------------------
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function issueToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600, session_id: crypto.randomUUID() };
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.${Buffer.from("e2e").toString("base64url")}`;
}
function userJson(user) {
  return { id: user.id, aud: "authenticated", role: "authenticated", email: user.email, email_confirmed_at: new Date(0).toISOString(), app_metadata: { provider: "email" }, user_metadata: {}, identities: [], created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
}
const refreshTokens = new Map();
function session(user) {
  const refresh = `e2e-refresh-${crypto.randomUUID()}`;
  refreshTokens.set(refresh, user);
  return { access_token: issueToken(user), token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: refresh, user: userJson(user) };
}
function userFromAuthHeader(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 3) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof p.exp !== "number" || p.exp < Date.now() / 1000) return null;
    return USERS.find((u) => u.id === p.sub) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// REST（PostgREST の一部）。識別子は許可した形式だけ、値はすべてパラメーターで渡す
// ---------------------------------------------------------------------------
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => {
  if (!IDENT.test(s)) throw httpError(400, "PGRST100", `invalid identifier: ${s}`);
  return `"${s}"`;
};
function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
const RESERVED = new Set(["select", "order", "limit", "offset", "columns", "on_conflict"]);

function buildWhere(params, args) {
  const conds = [];
  for (const [key, raw] of params) {
    if (RESERVED.has(key)) continue;
    const col = ident(key);
    const m = /^(not\.)?(eq|neq|gt|gte|lt|lte|is|in|like|ilike)\.(.*)$/s.exec(raw);
    if (!m) throw httpError(400, "PGRST100", `unsupported filter: ${key}`);
    const [, not, op, value] = m;
    let sql;
    if (op === "is") {
      const v = value.toLowerCase();
      if (!["null", "true", "false"].includes(v)) throw httpError(400, "PGRST100", "invalid is value");
      sql = `${col} is ${v}`;
    } else if (op === "in") {
      const inner = /^\((.*)\)$/s.exec(value);
      if (!inner) throw httpError(400, "PGRST100", "invalid in value");
      const items = inner[1] === "" ? [] : inner[1].split(",").map((x) => x.replace(/^"(.*)"$/s, "$1"));
      args.push(items);
      sql = `${col}::text = any($${args.length}::text[])`;
    } else {
      const sym = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "like", ilike: "ilike" }[op];
      args.push(op === "like" || op === "ilike" ? value.replace(/\*/g, "%") : value);
      sql = `${col} ${sym} $${args.length}`;
    }
    conds.push(not ? `not (${sql})` : sql);
  }
  return conds.length ? ` where ${conds.join(" and ")}` : "";
}

function selectList(params) {
  const s = params.get("select");
  if (!s || s === "*") return "*";
  return s.split(",").map((c) => ident(c.trim())).join(", ");
}

function orderBy(params) {
  const o = params.get("order");
  if (!o) return "";
  return ` order by ${o.split(",").map((part) => {
    const [col, dir, nulls] = part.split(".");
    const d = dir === "desc" ? "desc" : "asc";
    const n = nulls === "nullsfirst" ? " nulls first" : nulls === "nullslast" ? " nulls last" : "";
    return `${ident(col)} ${d}${n}`;
  }).join(", ")}`;
}

function limitClause(params) {
  const l = params.get("limit");
  if (l === null) return "";
  if (!/^\d{1,5}$/.test(l)) throw httpError(400, "PGRST100", "invalid limit");
  return ` limit ${Number(l)}`;
}

async function asRole(user, fn) {
  await db.exec("begin");
  try {
    if (user) {
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [user.id]);
      await db.exec("set local role authenticated");
    } else {
      await db.exec("set local role anon");
    }
    const r = await fn();
    await db.exec("commit");
    return r;
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}

async function handleRest(req, url, body, user) {
  const m = /^\/rest\/v1\/([a-z_]+)(?:\/([a-z_]+))?$/.exec(url.pathname);
  if (!m) throw httpError(404, "PGRST125", "not found");
  if (m[1] === "rpc") throw httpError(403, "42501", "rpc is not available in the E2E fake server");
  const table = `public.${ident(m[1])}`;
  const params = url.searchParams;
  const prefer = req.headers.prefer ?? "";
  const accept = req.headers.accept ?? "";
  const args = [];
  const ret = prefer.includes("return=representation");
  const cols = selectList(params);

  return asRole(user, async () => {
    let rows = [];
    let count = null;
    if (req.method === "GET" || req.method === "HEAD") {
      const where = buildWhere(params, args);
      if (/count=exact/.test(prefer)) {
        const c = await db.query(`select count(*)::int as n from ${table}${where}`, args);
        count = c.rows[0].n;
      }
      if (req.method === "GET") rows = (await db.query(`select ${cols} from ${table}${where}${orderBy(params)}${limitClause(params)}`, args)).rows;
    } else if (req.method === "POST") {
      const items = Array.isArray(body) ? body : [body];
      for (const item of items) {
        const keys = Object.keys(item);
        const values = keys.map((k) => {
          args.push(item[k]);
          return `$${args.length}`;
        });
        const sql = `insert into ${table} (${keys.map(ident).join(", ")}) values (${values.join(", ")})${ret ? ` returning ${cols}` : ""}`;
        rows.push(...(await db.query(sql, args)).rows);
        args.length = 0;
      }
    } else if (req.method === "PATCH") {
      const keys = Object.keys(body ?? {});
      if (!keys.length) throw httpError(400, "PGRST100", "empty update");
      const sets = keys.map((k) => {
        args.push(body[k]);
        return `${ident(k)} = $${args.length}`;
      });
      const where = buildWhere(params, args);
      rows = (await db.query(`update ${table} set ${sets.join(", ")}${where}${ret ? ` returning ${cols}` : ""}`, args)).rows;
    } else if (req.method === "DELETE") {
      const where = buildWhere(params, args);
      rows = (await db.query(`delete from ${table}${where}${ret ? ` returning ${cols}` : ""}`, args)).rows;
    } else {
      throw httpError(405, "PGRST100", "method not allowed");
    }

    if (accept.includes("application/vnd.pgrst.object")) {
      if (rows.length !== 1) throw httpError(406, "PGRST116", `JSON object requested, multiple (or no) rows returned (${rows.length})`);
      return { status: 200, json: rows[0], count };
    }
    if ((req.method === "POST" || req.method === "PATCH" || req.method === "DELETE") && !ret) return { status: 204, json: null, count };
    return { status: req.method === "POST" ? 201 : 200, json: rows, count };
  });
}

// ---------------------------------------------------------------------------
// HTTP サーバー
// ---------------------------------------------------------------------------
function send(res, status, json, extraHeaders = {}) {
  const headers = { "Content-Type": "application/json; charset=utf-8", ...extraHeaders };
  res.writeHead(status, headers);
  res.end(json === null || json === undefined ? "" : JSON.stringify(json));
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () =>
    serial(async () => {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      let body = null;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        body = text ? JSON.parse(text) : null;
      } catch {
        return send(res, 400, { message: "invalid json" });
      }
      try {
        // テスト用の操作（ローカルのテストからだけ呼ぶ）
        if (url.pathname === "/__e2e/health") return send(res, 200, { ok: true });
        if (url.pathname === "/__e2e/reset" && req.method === "POST") {
          await resetDb();
          refreshTokens.clear();
          return send(res, 200, { ok: true });
        }
        if (url.pathname === "/__e2e/query" && req.method === "POST") {
          const r = await db.query(String(body?.sql ?? ""), body?.params ?? []);
          return send(res, 200, { rows: r.rows });
        }

        // Auth
        if (url.pathname === "/auth/v1/token" && req.method === "POST") {
          const grant = url.searchParams.get("grant_type");
          if (grant === "password") {
            const user = USERS.find((u) => u.email === body?.email && u.password === body?.password);
            if (!user) return send(res, 400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
            return send(res, 200, session(user));
          }
          if (grant === "refresh_token") {
            const user = refreshTokens.get(body?.refresh_token);
            if (!user) return send(res, 400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
            refreshTokens.delete(body.refresh_token);
            return send(res, 200, session(user));
          }
          return send(res, 400, { code: 400, msg: "unsupported grant_type" });
        }
        if (url.pathname === "/auth/v1/user" && req.method === "GET") {
          const user = userFromAuthHeader(req);
          return user ? send(res, 200, userJson(user)) : send(res, 401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
        }
        if (url.pathname === "/auth/v1/logout" && req.method === "POST") {
          res.writeHead(204);
          return res.end();
        }

        // REST
        if (url.pathname.startsWith("/rest/v1/")) {
          const user = userFromAuthHeader(req);
          const r = await handleRest(req, url, body, user);
          const headers = {};
          if (r.count !== null) headers["Content-Range"] = `0-${Math.max(0, (Array.isArray(r.json) ? r.json.length : 1) - 1)}/${r.count}`;
          if (req.method === "HEAD") {
            res.writeHead(200, { ...headers, "Content-Type": "application/json" });
            return res.end();
          }
          return send(res, r.status, r.json, headers);
        }
        return send(res, 404, { message: "not found" });
      } catch (e) {
        const status = e.status ?? (e.code === "42501" ? 403 : 400);
        return send(res, status, { code: e.code ?? "XX000", message: e.message, details: null, hint: null });
      }
    }),
  );
});

await resetDb();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[e2e] fake supabase listening on http://127.0.0.1:${PORT}`);
});
