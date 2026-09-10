/**
 * firestore-rest.ts — Firestore access over the raw REST API (fetch only).
 *
 * WHY: @google-cloud/firestore (used by firebase-admin) routes EVERY
 * operation through google-gax, which eagerly loads the Firestore protos via
 * protobufjs — and protobufjs compiles its codecs with `new Function(...)`.
 * Cloudflare Workers disallow code generation from strings, so any Firestore
 * operation dies with `EvalError: Code generation from strings disallowed`.
 * Verified against gax v4 (admin 12) and gax v6 (admin 14).
 *
 * This module re-implements exactly the subset of the firebase-admin Firestore
 * API the Worker uses — same shapes, same semantics — on Firestore REST v1.
 * firebase-admin keeps AUTH (ID token verification, custom claims, FCM);
 * only Firestore is swapped out.
 *
 * Implemented surface (mirrors firebase-admin):
 *   db().doc(path)      → get / set(data,{merge}) / update / create / delete
 *                         / id / collection(sub)
 *   db().collection(p)  → doc(id) / add(data) / where(f,op,v) / limit(n) /
 *                         orderBy(f,dir) / get() / count().get()
 *   db().collectionGroup(id) → where / limit / get
 *   db().runTransaction(fn)  → tx.get / tx.set(merge) / tx.update / tx.delete
 *   db().bulkWriter()   → set / update / delete / close   (→ :batchWrite)
 *   FieldValue: serverTimestamp, delete, increment, arrayUnion, arrayRemove
 *   Timestamp: firebase-admin's real class (toMillis/toDate keep working)
 *
 * RETRY POLICY: only idempotent GETs auto-retry. Commits/batch writes fail
 * fast — a blind retry of `increment` could double-apply. Transactions
 * handle their own 409 ABORTED retries.
 */

import { Timestamp } from "firebase-admin/firestore";
import type { App } from "firebase-admin/app";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class RestError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "RestError";
  }
}

interface AccessToken {
  access_token: string;
  expires_in: number;
}

/* ───────────────────── FieldValue sentinel discrimination ──────────────── */

type SentinelKind =
  | "serverTimestamp"
  | "delete"
  | "increment"
  | "arrayUnion"
  | "arrayRemove";

interface Sentinel {
  kind: SentinelKind;
  operand?: unknown;
  elements?: unknown[];
}

/**
 * firebase-admin FieldValue sentinels carry `methodName`, e.g.
 * "FieldValue.serverTimestamp" / "FieldValue.delete" / "FieldValue.increment"
 * (+ `.operand`) / "FieldValue.arrayUnion" (+ `.elements`).
 */
function asSentinel(v: unknown): Sentinel | null {
  if (v === null || typeof v !== "object") return null;
  const m = (v as { methodName?: unknown }).methodName;
  if (typeof m !== "string" || !m.startsWith("FieldValue.")) return null;
  const kind = m.slice("FieldValue.".length) as SentinelKind;
  const s = v as { operand?: unknown; elements?: unknown[] };
  return { kind, operand: s.operand, elements: s.elements };
}

/* ────────────────────────── the REST client ────────────────────────────── */

interface TokenCache {
  token: string;
  expiresAt: number;
}

export class FirestoreRest {
  private token: TokenCache | null = null;
  private credential: { getAccessToken(): Promise<AccessToken> };
  public readonly base: string;
  public readonly projectId: string;

  constructor(app: App) {
    this.credential = app.options.credential as unknown as {
      getAccessToken(): Promise<AccessToken>;
    };
    this.projectId = app.options.projectId as string;
    this.base = `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)`;
  }

  docNameFor(path: string): string {
    return `${this.base}/documents/${path}`;
  }

  /** Relative resource name for request BODIES: projects/…/documents/… */
  resourceName(path: string): string {
    return `projects/${this.projectId}/databases/(default)/documents/${path}`;
  }

  private async authHeader(): Promise<Record<string, string>> {
    if (!this.token || Date.now() > this.token.expiresAt) {
      const res = await this.credential.getAccessToken();
      this.token = {
        token: res.access_token,
        expiresAt: Date.now() + Math.max(30, (res.expires_in ?? 3600) - 120) * 1000,
      };
    }
    return { authorization: `Bearer ${this.token.token}` };
  }

  async call(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>
  ): Promise<Record<string, any>> {
    const url = new URL(`${this.base}/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

    let lastErr: RestError | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const headers = { ...(await this.authHeader()), "content-type": "application/json" };
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) {
        const text = await res.text();
        return text ? (JSON.parse(text) as Record<string, any>) : {};
      }
      const errText = await res.text().catch(() => "");
      const err = new RestError(
        res.status,
        `Firestore REST ${method} ${path} → ${res.status}: ${errText.slice(0, 300)}`
      );
      // Retry only idempotent reads; writes fail fast (see header note).
      if (method === "GET" && RETRYABLE.has(res.status) && attempt < 3) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt + Math.random() * 200));
        continue;
      }
      throw err;
    }
    throw lastErr ?? new RestError(500, "unreachable");
  }

  private docName(path: string): string {
    return this.docNameFor(path);
  }

  private static nameToPath(name: string): string {
    const marker = "documents/";
    const idx = name.indexOf(marker);
    return name.slice(idx + marker.length);
  }

  /* ────────────────────────── value codec ──────────────────────────────── */

  private encodeValue(v: unknown): Record<string, unknown> {
    if (v === null || v === undefined) return { nullValue: null };
    if (asSentinel(v)) {
      throw new Error("FieldValue sentinel must be handled by buildWrite");
    }
    if (v instanceof Timestamp) return { timestampValue: v.toDate().toISOString() };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") {
      return Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER
        ? { integerValue: String(v) }
        : { doubleValue: v };
    }
    if (typeof v === "string") return { stringValue: v };
    if (v instanceof Uint8Array) return { bytesValue: Buffer.from(v).toString("base64") };
    if (Array.isArray(v)) {
      return { arrayValue: { values: v.map((x) => this.encodeValue(x)) } };
    }
    if (typeof v === "object") {
      const fields: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (val === undefined) continue;
        fields[k] = this.encodeValue(val);
      }
      return { mapValue: { fields } };
    }
    throw new Error(`Unsupported Firestore value type: ${typeof v}`);
  }

  private decodeValue(v: Record<string, any>): unknown {
    const kind = Object.keys(v)[0];
    switch (kind) {
      case "nullValue":
        return null;
      case "booleanValue":
        return v.booleanValue;
      case "integerValue":
      case "doubleValue":
        return Number(v[kind]);
      case "timestampValue":
        return Timestamp.fromMillis(Date.parse(v.timestampValue));
      case "stringValue":
        return v.stringValue;
      case "bytesValue":
        return new Uint8Array(Buffer.from(v.bytesValue, "base64"));
      case "referenceValue":
        return v.referenceValue; // raw resource name (handlers never store refs)
      case "arrayValue":
        return (v.arrayValue.values ?? []).map((x: Record<string, any>) => this.decodeValue(x));
      case "mapValue": {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v.mapValue.fields ?? {})) {
          out[k] = this.decodeValue(val as Record<string, any>);
        }
        return out;
      }
      default:
        return null;
    }
  }

  private decodeFields(fields: Record<string, any> | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields ?? {})) out[k] = this.decodeValue(v);
    return out;
  }

  /* ─────────────── write builder (flatten + mask + transforms) ─────────── */

  /** Flattens nested maps into leaf paths (arrays/atoms stay atomic). */
  private static flatten(data: Record<string, unknown>, prefix = ""): [string, unknown][] {
    const out: [string, unknown][] = [];
    for (const [key, value] of Object.entries(data)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (
        value !== null &&
        typeof value === "object" &&
        !asSentinel(value) &&
        !(value instanceof Timestamp) &&
        !(value instanceof Date) &&
        !(value instanceof Uint8Array) &&
        !Array.isArray(value)
      ) {
        const entries = FirestoreRest.flatten(value as Record<string, unknown>, path);
        // An empty map is an atomic empty-map value.
        if (entries.length === 0) out.push([path, value]);
        else out.push(...entries);
      } else {
        out.push([path, value]);
      }
    }
    return out;
  }

  /**
   * Encodes the field MAP in proper nested REST structure. Sentinel leaves
   * (FieldValue.*) and undefined values are omitted — they surface only in
   * updateMask / updateTransforms.
   */
  private buildFields(data: Record<string, unknown>): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || asSentinel(v)) continue;
      if (
        v !== null &&
        typeof v === "object" &&
        !(v instanceof Timestamp) &&
        !(v instanceof Date) &&
        !(v instanceof Uint8Array) &&
        !Array.isArray(v)
      ) {
        fields[k] = { mapValue: { fields: this.buildFields(v as Record<string, unknown>) } };
      } else {
        fields[k] = this.encodeValue(v);
      }
    }
    return fields;
  }

  /**
   * Builds a REST `writes[]` entry. mode:
   *   "replace" → set() (full overwrite; no updateMask unless deletes)
   *   "merge"   → set(data, {merge:true}) (mask = every provided path)
   *   "update"  → update() (mask + exists:true precondition)
   */
  buildWrite(
    ref: DocRef,
    data: Record<string, unknown>,
    mode: "replace" | "merge" | "update",
    precondition?: Record<string, unknown>
  ): Record<string, unknown> {
    const flat = FirestoreRest.flatten(data);
    const maskPaths: string[] = [];
    const maskOnly: string[] = []; // FieldValue.delete → mask, no field
    const transforms: Record<string, unknown>[] = [];

    for (const [path, value] of flat) {
      const sentinel = asSentinel(value);
      if (sentinel) {
        switch (sentinel.kind) {
          case "delete":
            maskOnly.push(path);
            break;
          case "serverTimestamp":
            maskPaths.push(path);
            transforms.push({ fieldPath: path, setToServerValue: "REQUEST_TIME" });
            break;
          case "increment":
            maskPaths.push(path);
            transforms.push({ fieldPath: path, increment: this.encodeValue(sentinel.operand) });
            break;
          case "arrayUnion":
            maskPaths.push(path);
            transforms.push({
              fieldPath: path,
              appendMissingElements: { values: sentinel.elements!.map((o) => this.encodeValue(o)) },
            });
            break;
          case "arrayRemove":
            maskPaths.push(path);
            transforms.push({
              fieldPath: path,
              removeAllElements: { values: sentinel.elements!.map((o) => this.encodeValue(o)) },
            });
            break;
        }
        continue;
      }
      if (value === undefined) continue; // admin skips undefined
      maskPaths.push(path);
    }

    // `fields` must be the properly NESTED REST structure — dotted paths are
    // only valid inside updateMask / fieldTransforms / query filters.
    const update: Record<string, unknown> = {
      name: this.resourceName(ref.path),
      fields: this.buildFields(data),
    };
    const write: Record<string, unknown> = { update };

    if (mode === "merge" || mode === "update") {
      write["updateMask"] = { fieldPaths: [...maskPaths, ...maskOnly] };
    } else if (maskOnly.length > 0) {
      write["updateMask"] = { fieldPaths: maskOnly };
    }
    if (mode === "update" && !precondition) write["currentDocument"] = { exists: true };
    if (precondition) write["currentDocument"] = precondition;
    if (transforms.length > 0) write["updateTransforms"] = transforms;
    return write;
  }

  /* ─────────────────────────── document ops ────────────────────────────── */

  async docGet(path: string, transaction?: string): Promise<DocSnap> {
    const query: Record<string, string> = {};
    if (transaction) query.transaction = transaction;
    try {
      const doc = await this.call("GET", `documents/${path}`, undefined, query);
      return new DocSnap(this, path, true, this.decodeFields(doc.fields), doc);
    } catch (e) {
      if (e instanceof RestError && e.status === 404) {
        return new DocSnap(this, path, false, {}, undefined);
      }
      throw e;
    }
  }

  async commit(writes: Record<string, unknown>[], transaction?: string): Promise<void> {
    if (writes.length === 0) return;
    const body: Record<string, unknown> = { writes };
    if (transaction) body.transaction = transaction;
    await this.call("POST", "documents:commit", body);
  }

  /* ───────────────────────────── queries ───────────────────────────────── */

  buildStructuredQuery(q: Query): Record<string, unknown> {
    const filters = q.filters.map((f) => ({
      fieldFilter: {
        field: { fieldPath: f.field },
        op:
          f.op === "=="
            ? "EQUAL"
            : f.op === "<"
              ? "LESS_THAN"
              : f.op === "<="
                ? "LESS_THAN_OR_EQUAL"
                : f.op === ">"
                  ? "GREATER_THAN"
                  : f.op === ">="
                    ? "GREATER_THAN_OR_EQUAL"
                    : f.op === "!="
                      ? "NOT_EQUAL"
                      : "IN",
        value: Array.isArray(f.value)
          ? { arrayValue: { values: f.value.map((v) => this.encodeValue(v)) } }
          : this.encodeValue(f.value),
      },
    }));
    const structured: Record<string, unknown> = {
      from: [{ collectionId: q.collectionId, allDescendants: q.allDescendants }],
    };
    if (filters.length === 1) structured.where = filters[0];
    else if (filters.length > 1)
      structured.where = { compositeFilter: { op: "AND", filters } };
    if (q.limitCount !== undefined) structured.limit = q.limitCount;
    return structured;
  }

  async queryGet(q: Query): Promise<QuerySnap> {
    const body = {
      parent: `${this.base}/documents`,
      structuredQuery: this.buildStructuredQuery(q),
    };
    const res = await this.call("POST", "documents:runQuery", body);
    const rows = Array.isArray(res) ? res : [];
    const snaps = rows
      .filter((r) => r.document)
      .map((r: any) => {
        const path = FirestoreRest.nameToPath(r.document.name);
        return new DocSnap(this, path, true, this.decodeFields(r.document.fields), r.document);
      });
    return new QuerySnap(snaps);
  }

  async queryCount(q: Query): Promise<number> {
    const body = {
      parent: `${this.base}/documents`,
      structuredAggregationQuery: {
        structuredQuery: this.buildStructuredQuery(q),
        aggregates: [{ alias: "count", count: {} }],
      },
    };
    const res = await this.call("POST", "documents:runAggregationQuery", body);
    const first = Array.isArray(res) ? res[0] : res;
    const count = first?.result?.aggregateFields?.count;
    return count ? Number(count.integerValue ?? count.doubleValue ?? 0) : 0;
  }

  /* ─────────────────────────── transactions ────────────────────────────── */

  async runTransaction<T>(fn: (tx: FsTransaction) => Promise<T>, attempts = 5): Promise<T> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const begun = await this.call("POST", "documents:beginTransaction", { options: {} });
      const tx = new FsTransaction(this, begun.transaction as string);
      try {
        const result = await fn(tx);
        await tx.commit();
        return result;
      } catch (e) {
        const aborted = e instanceof RestError && (e.status === 409 || /\bABORTED\b/.test(e.message));
        if (aborted && attempt < attempts) {
          await new Promise((r) => setTimeout(r, 150 * attempt + Math.random() * 150));
          continue;
        }
        throw e;
      }
    }
    throw new RestError(409, "Transaction exceeded retry attempts.");
  }

  /* ─────────────────────────── batch writes ────────────────────────────── */

  async batchWrite(writes: Record<string, unknown>[]): Promise<void> {
    for (let i = 0; i < writes.length; i += 500) {
      const chunk = writes.slice(i, i + 500);
      const res = await this.call("POST", "documents:batchWrite", { writes: chunk });
      const results: any[] = res.writeResults ?? [];
      const bad = results.find((r) => r.status && r.status.code !== 0);
      if (bad) {
        throw new RestError(500, `batchWrite partial failure: ${JSON.stringify(bad).slice(0, 200)}`);
      }
    }
  }
}

/* ───────────────────────────── snapshot types ──────────────────────────── */

export class DocSnap {
  constructor(
    private store: FirestoreRest,
    public readonly refPath: string,
    public readonly exists: boolean,
    private readonly dataMap: Record<string, unknown>,
    private readonly raw: Record<string, any> | undefined
  ) {}

  get id(): string {
    const parts = this.refPath.split("/");
    return parts[parts.length - 1];
  }

  get ref(): DocRef {
    return new DocRef(this.store, this.refPath);
  }

  data(): Record<string, unknown> | undefined {
    return this.exists ? this.dataMap : undefined;
  }

  /** admin SDK throws on missing fields; undefined is close enough here. */
  get(fieldPath: string): unknown {
    let cur: unknown = this.dataMap;
    for (const seg of fieldPath.split(".")) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
  }
}

export class QuerySnap {
  constructor(public readonly docs: DocSnap[]) {}
  get empty(): boolean {
    return this.docs.length === 0;
  }
  get size(): number {
    return this.docs.length;
  }
  forEach(fn: (d: DocSnap, i: number) => void): void {
    this.docs.forEach(fn);
  }
}

/* ───────────────────────────── reference types ─────────────────────────── */

export class DocRef {
  constructor(
    private store: FirestoreRest,
    public readonly path: string
  ) {}

  get id(): string {
    const parts = this.path.split("/");
    return parts[parts.length - 1];
  }

  collection(sub: string): CollectionRef {
    return new CollectionRef(this.store, `${this.path}/${sub}`);
  }

  async get(): Promise<DocSnap> {
    return this.store.docGet(this.path);
  }

  async set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void> {
    return this.store.commit([this.store.buildWrite(this, data, (opts?.merge ?? false) ? "merge" : "replace")]);
  }

  async update(data: Record<string, unknown>): Promise<void> {
    return this.store.commit([this.store.buildWrite(this, data, "update")]);
  }

  async delete(): Promise<void> {
    await this.store.call("DELETE", `documents/${this.path}`);
  }

  async create(data: Record<string, unknown>): Promise<void> {
    return this.store.commit([
      this.store.buildWrite(this, data, "replace", { exists: false }),
    ]);
  }
}

export interface Filter {
  field: string;
  op: string;
  value: unknown;
}

export class Query {
  constructor(
    private store: FirestoreRest,
    public readonly parentPath: string,
    public readonly collectionId: string,
    public readonly allDescendants: boolean,
    public readonly filters: Filter[] = [],
    public readonly limitCount: number | undefined = undefined
  ) {}

  where(field: string, op: string, value: unknown): Query {
    return new Query(this.store, this.parentPath, this.collectionId, this.allDescendants, [
      ...this.filters,
      { field, op, value },
    ], this.limitCount);
  }

  limit(n: number): Query {
    return new Query(this.store, this.parentPath, this.collectionId, this.allDescendants, this.filters, n);
  }

  count(): CountQuery {
    return new CountQuery(this.store, this);
  }

  async get(): Promise<QuerySnap> {
    return this.store.queryGet(this);
  }
}

export class CountQuery {
  constructor(
    private store: FirestoreRest,
    private query: Query
  ) {}
  async get(): Promise<{ data(): { count: number } }> {
    const count = await this.store.queryCount(this.query);
    return { data: () => ({ count }) };
  }
}

export class CollectionRef {
  constructor(
    private store: FirestoreRest,
    public readonly path: string
  ) {}

  get id(): string {
    const parts = this.path.split("/");
    return parts[parts.length - 1];
  }

  doc(id?: string): DocRef {
    return new DocRef(this.store, `${this.path}/${id ?? randomId()}`);
  }

  where(field: string, op: string, value: unknown): Query {
    return new Query(this.store, this.path, this.id, false).where(field, op, value);
  }

  limit(n: number): Query {
    return new Query(this.store, this.path, this.id, false, [], n);
  }

  async get(): Promise<QuerySnap> {
    return this.store.queryGet(new Query(this.store, this.path, this.id, false));
  }

  async add(data: Record<string, unknown>): Promise<DocRef> {
    const ref = this.doc();
    await ref.create(data);
    return ref;
  }
}

/* ───────────────────────────── transactions ────────────────────────────── */

export class FsTransaction {
  private writes: Record<string, unknown>[] = [];

  constructor(
    private store: FirestoreRest,
    public readonly id: string
  ) {}

  async get(ref: DocRef): Promise<DocSnap> {
    return this.store.docGet(ref.path, this.id);
  }

  set(ref: DocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): this {
    this.writes.push(this.store.buildWrite(ref, data, (opts?.merge ?? false) ? "merge" : "replace"));
    return this;
  }

  update(ref: DocRef, data: Record<string, unknown>): this {
    this.writes.push(this.store.buildWrite(ref, data, "update"));
    return this;
  }

  delete(ref: DocRef): this {
    this.writes.push({ delete: this.store.resourceName(ref.path) });
    return this;
  }

  async commit(): Promise<void> {
    if (this.writes.length > 0) await this.store.commit(this.writes, this.id);
  }
}

/* ────────────────────────────── bulk writer ────────────────────────────── */

export class BulkWriterLite {
  private writes: Record<string, unknown>[] = [];

  constructor(private store: FirestoreRest) {}

  set(ref: DocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): void {
    this.writes.push(this.store.buildWrite(ref, data, (opts?.merge ?? false) ? "merge" : "replace"));
  }

  update(ref: DocRef, data: Record<string, unknown>): void {
    this.writes.push(this.store.buildWrite(ref, data, "update"));
  }

  delete(ref: DocRef): void {
    this.writes.push({ delete: this.store.resourceName(ref.path) });
  }

  async close(): Promise<void> {
    if (this.writes.length > 0) {
      const pending = this.writes;
      this.writes = [];
      await this.store.batchWrite(pending);
    }
  }
}

/* ─────────────────────────── top-level facade ──────────────────────────── */

export class FirestoreLite {
  constructor(private store: FirestoreRest) {}

  doc(path: string): DocRef {
    return new DocRef(this.store, path);
  }

  collection(path: string): CollectionRef {
    return new CollectionRef(this.store, path);
  }

  collectionGroup(collectionId: string): Query {
    return new Query(this.store, "", collectionId, true);
  }

  bulkWriter(): BulkWriterLite {
    return new BulkWriterLite(this.store);
  }

  runTransaction<T>(fn: (tx: FsTransaction) => Promise<T>): Promise<T> {
    return this.store.runTransaction(fn);
  }
}

function randomId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}
