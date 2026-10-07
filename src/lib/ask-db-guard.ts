/**
 * The gate every AI-written query passes through before it reaches Postgres.
 *
 * A local 8B model writes this SQL from an admin's plain-English question, so
 * the text arriving here is untrusted in both directions: the model can be
 * wrong, and the question itself can try to steer it ("…and delete the rest").
 * Nothing downstream may depend on the model behaving. Three layers hold:
 *
 *  1. this guard — one statement, SELECT/WITH only, no DML/DDL keywords, no
 *     file or session functions, and every table named in an allowlist that
 *     leaves out health records, documents and provider credentials;
 *  2. the wrapper in ask-db-run.ts, which caps rows and the statement clock;
 *  3. a READ ONLY transaction, so Postgres itself refuses a write even if
 *     both layers above were somehow talked past.
 *
 * Checks run over a MASKED copy of the query — comments blanked, string
 * contents replaced by x's, both keeping their original length. A guest whose
 * note reads 'drop by tomorrow' must not look like DROP, and an offset in the
 * mask is still the right offset in the real SQL, which is what lets the
 * table-name fix below be applied safely.
 */

import { ALLOWED_TABLES, KNOWN_COLUMNS } from "./ask-db-catalog";

export { ALLOWED_TABLES };

/**
 * Deliberately NOT readable here, and why:
 *
 *  • HealthProfile / Document — screening forms and uploaded files. The health
 *    blob is encrypted, so a query would return ciphertext, but the subject
 *    names and filenames around it are still PHI. Health data has its own
 *    permission (health.view) and its own screen; it does not leak through a
 *    reporting tool.
 *  • WhatsAppNumber / AutoReply / EmailAutoReply / WelcomeEmailSetting —
 *    WhatsAppNumber carries instanceToken and metaAccessToken in plain
 *    columns. A single "select * " would print live WhatsApp credentials onto
 *    a screen. Which line a message went out on is answerable without it:
 *    Message.fromEmail holds the sending number.
 *  • MailboxState, UserPreference, *Settings — plumbing, no reporting value.
 */
const ALLOWED = new Set<string>(ALLOWED_TABLES);

/** Statement verbs that must never appear, whatever the model was asked. */
const FORBIDDEN_KEYWORDS = [
  "insert", "update", "delete", "drop", "alter", "create", "truncate", "merge",
  "grant", "revoke", "copy", "vacuum", "analyze", "cluster", "reindex", "refresh",
  "call", "do", "execute", "prepare", "deallocate", "listen", "notify", "unlisten",
  "lock", "begin", "commit", "rollback", "savepoint", "set", "reset", "discard",
  "comment", "import", "into",
];

/** Functions that read the filesystem, rewrite the session or stall it. */
const FORBIDDEN_FUNCTIONS = [
  "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file", "pg_logdir_ls",
  "lo_import", "lo_export", "dblink", "dblink_exec", "pg_sleep", "pg_sleep_for",
  "set_config", "pg_terminate_backend", "pg_cancel_backend", "query_to_xml",
];

/** Columns holding a secret: refused even inside an otherwise fine query. */
const FORBIDDEN_COLUMNS = ["instancetoken", "metaaccesstoken", "consenttexthash"];

export type GuardResult =
  | { ok: true; sql: string; tables: string[] }
  | { ok: false; reason: string };

/**
 * Blank comments and string contents, preserving length and, with it, every
 * offset into the original text.
 */
function maskSql(sql: string): { clean: string; code: string } {
  const clean: string[] = [];
  const code: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        clean.push(" ");
        code.push(" ");
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      // Postgres block comments nest.
      let depth = 0;
      while (i < sql.length) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; clean.push(" ", " "); code.push(" ", " "); i += 2; continue; }
        if (sql[i] === "*" && sql[i + 1] === "/") { depth--; clean.push(" ", " "); code.push(" ", " "); i += 2; if (depth === 0) break; continue; }
        clean.push(" ");
        code.push(" ");
        i++;
      }
      continue;
    }
    if (ch === "'") {
      clean.push(ch);
      code.push(ch);
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { clean.push("'", "'"); code.push("x", "x"); i += 2; continue; }
        if (sql[i] === "'") { clean.push("'"); code.push("'"); i++; break; }
        clean.push(sql[i]);
        code.push("x");
        i++;
      }
      continue;
    }
    if (ch === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      // Dollar-quoted string — only ever used to smuggle a body past a
      // keyword check here, so it is refused outright further down. Masked
      // so the refusal is the one that fires, not a parse accident.
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      for (; i < stop; i++) {
        clean.push(sql[i]);
        // The opening/closing tags stay legible so the refusal below sees them.
        code.push(i < sql.length && sql[i] === "$" ? "$" : "x");
      }
      continue;
    }
    clean.push(ch);
    code.push(ch);
    i++;
  }
  return { clean: clean.join(""), code: code.join("") };
}

/**
 * Blank the contents of double-quoted identifiers, keeping length.
 *
 * Statement keywords and table names share words: CALL is a statement, "Call"
 * is the table every phone call lives in, and a keyword scan that cannot tell
 * them apart refuses "how many calls lasted over five minutes" — which it did,
 * until this existed. Quoted text is an identifier by definition, never a
 * verb, so keyword checks run over a copy with the quoted parts blanked.
 */
function maskIdentifiers(code: string): string {
  const out = code.split("");
  let i = 0;
  while (i < code.length) {
    if (code[i] !== '"') { i++; continue; }
    i++;
    while (i < code.length) {
      if (code[i] === '"' && code[i + 1] === '"') { out[i] = "x"; out[i + 1] = "x"; i += 2; continue; }
      if (code[i] === '"') { i++; break; }
      out[i] = "x";
      i++;
    }
  }
  return out.join("");
}

/** Names introduced by WITH … AS (…), which are not real tables. */
function cteNames(code: string): Set<string> {
  const names = new Set<string>();
  const re = /(?:\bwith\b|,)\s*(?:recursive\s+)?("?)([A-Za-z_][A-Za-z0-9_$]*)\1\s*(?:\([^)]*\)\s*)?as\s*(?:materialized\s+|not\s+materialized\s+)?\(/gi;
  for (const m of code.matchAll(re)) names.add(m[2].toLowerCase());
  return names;
}

/**
 * Check one model-written query, and hand back the exact text to execute.
 *
 * Unquoted table names are repaired rather than refused: Postgres folds a bare
 * `Message` to `message`, which does not exist — Prisma's tables are quoted
 * PascalCase — and a small model writes it that way often enough that
 * refusing would make the feature feel broken. The repair only ever turns a
 * name that IS on the allowlist into its quoted spelling; an unknown name is
 * still refused.
 */
export function checkSql(raw: string): GuardResult {
  // Models like to fence their answer.
  const unfenced = raw.replace(/```(?:sql)?/gi, "").trim();
  const withoutTrailing = unfenced.replace(/;\s*$/, "").trim();
  if (!withoutTrailing) return { ok: false, reason: "The model returned no SQL." };

  const { clean, code } = maskSql(withoutTrailing);

  if (code.includes(";")) {
    return { ok: false, reason: "Only one statement can be run at a time." };
  }
  if (/\$[A-Za-z_]*\$/.test(code)) {
    return { ok: false, reason: "Dollar-quoted text is not allowed." };
  }
  if (!/^\s*(select|with)\b/i.test(code)) {
    return { ok: false, reason: "Only SELECT queries are allowed — this one starts with something else." };
  }

  for (const col of FORBIDDEN_COLUMNS) {
    if (new RegExp(`\\b${col}\\b`, "i").test(code)) {
      return { ok: false, reason: "That query reads a credential column, which is never returned." };
    }
  }

  const ctes = cteNames(code);
  const tables: string[] = [];
  // Every table position: after FROM or a JOIN, optionally schema-qualified.
  // The optional trailing group is the table's ALIAS. It has to be recognised
  // because a model writes `FROM "Call" call` readily, and an alias spelled
  // like a statement verb used to trip the keyword scan below: the query was
  // refused as if it contained a CALL statement. Seen in production.
  const refRe =
    /\b(?:from|join)\s+(?:(?:"?[A-Za-z_][A-Za-z0-9_$]*"?)\.)?("?)([A-Za-z_][A-Za-z0-9_$]*)\1(\s+(?!on\b|using\b|where\b|join\b|inner\b|left\b|right\b|full\b|cross\b|group\b|order\b|limit\b|having\b|union\b|as\b)([A-Za-z_][A-Za-z0-9_$]*))?/gi;
  const fixes: { start: number; end: number; text: string }[] = [];
  /** Alias names, blanked before the keyword scan — see below. */
  const aliasNames = new Set<string>();

  for (const m of code.matchAll(refRe)) {
    const quoted = m[1] === '"';
    const name = m[2];
    const lower = name.toLowerCase();
    // The match may carry a trailing alias, so the table's own span ends
    // before it rather than at the end of the match.
    const tableEnd = m.index! + m[0].length - (m[3]?.length ?? 0);
    const tableStart = tableEnd - (quoted ? name.length + 2 : name.length);
    if (ctes.has(lower)) continue;
    if (/^\s*\(/.test(code.slice(tableEnd))) continue; // a function call, e.g. from generate_series(

    const canonical = [...ALLOWED].find((t) => t.toLowerCase() === lower);
    if (!canonical) {
      return {
        ok: false,
        reason: `The table "${name}" is not available to this tool. Readable tables: ${ALLOWED_TABLES.join(", ")}.`,
      };
    }
    if (m[4]) aliasNames.add(m[4].toLowerCase());
    if (!quoted || name !== canonical) {
      // Rewrite to the exact quoted spelling Postgres needs.
      fixes.push({ start: tableStart, end: tableEnd, text: `"${canonical}"` });
    }
    tables.push(canonical);
  }

  if (!tables.length) {
    return { ok: false, reason: "The query reads no known table." };
  }

  // Put the quotes back on a known camelCase column the model left bare —
  // `a.actorName` reaches Postgres as `actorname` and fails. Only names that
  // ARE columns of the readable tables are touched, so an alias the model
  // invented, a function and a keyword are all left exactly as written.
  const identRe = /(?<!["\w$])([A-Za-z_][A-Za-z0-9_$]*)(?!["\w$])/g;
  for (const m of code.matchAll(identRe)) {
    const canonical = KNOWN_COLUMNS.get(m[1].toLowerCase());
    if (!canonical) continue;
    const start = m.index!;
    const end = start + m[1].length;
    if (fixes.some((f) => start < f.end && end > f.start)) continue;
    fixes.push({ start, end, text: `"${canonical}"` });
  }

  let sql = clean;
  for (const fix of fixes.sort((a, b) => b.start - a.start)) {
    sql = sql.slice(0, fix.start) + fix.text + sql.slice(fix.end);
  }

  // Keyword and function checks run last, over the repaired query with both
  // string literals and quoted identifiers blanked — so a table called "Call"
  // and a note mentioning a drop are read as what they are, while a bare CALL
  // or DROP still has nowhere to hide.
  let verbs = maskIdentifiers(maskSql(sql).code);
  const blank = (text: string) => "x".repeat(text.length);
  for (const alias of aliasNames) {
    // Where the alias is DECLARED — `FROM "Call" call` — and wherever it
    // QUALIFIES a column — `call."durationSec"`. Both are plainly identifiers.
    //
    // A bare occurrence of the word elsewhere is left visible on purpose: an
    // alias called "update" must not hide a data-modifying CTE such as
    // `WITH x AS (UPDATE … RETURNING id)`, which is a write and stays refused.
    verbs = verbs
      .replace(new RegExp(`\\b(from|join)(\\s+)("?[A-Za-z_][A-Za-z0-9_$]*"?\\s+)(${alias})\\b`, "gi"), (_m, kw, ws, tbl, al) => `${kw}${ws}${tbl}${blank(al)}`)
      .replace(new RegExp(`\\b${alias}(\\s*\\.)`, "gi"), (_m, dot) => `${blank(alias)}${dot}`);
  }
  for (const word of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${word}\\b`, "i").test(verbs)) {
      return { ok: false, reason: `\`${word.toUpperCase()}\` is not allowed — this tool only reads.` };
    }
  }
  for (const fn of FORBIDDEN_FUNCTIONS) {
    if (new RegExp(`\\b${fn}\\s*\\(`, "i").test(verbs)) {
      return { ok: false, reason: `The function ${fn}() is not allowed.` };
    }
  }

  return { ok: true, sql: sql.trim(), tables: [...new Set(tables)] };
}
