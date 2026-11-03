const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createSessionStore } = require("../src/storage.mjs");

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class FakeObjectStore {
  constructor(name, keyPath) {
    this.name = name;
    this.keyPath = keyPath;
    this.records = new Map();
    this.indexes = new Map();
  }
  createIndex(name, keyPath) { this.indexes.set(name, keyPath); }
  index(name) {
    const keyPath = this.indexes.get(name);
    if (!keyPath) throw new Error("Unknown index " + name);
    return new FakeIndex(this, keyPath);
  }
  add(record) {
    return this._request(() => {
      const key = record[this.keyPath];
      if (this.records.has(key)) throw new Error("Duplicate key");
      this.records.set(key, clone(record));
      return key;
    });
  }
  put(record) {
    return this._request(() => {
      const key = record[this.keyPath];
      this.records.set(key, clone(record));
      return key;
    });
  }
  get(key) { return this._request(() => clone(this.records.get(key))); }
  getAll() { return this._request(() => [...this.records.values()].map(clone)); }
  delete(key) { return this._request(() => this.records.delete(key)); }
  _request(operation) { return FakeTransaction.current._schedule(operation); }
}

class FakeIndex {
  constructor(store, keyPath) { this.store = store; this.keyPath = keyPath; }
  getAll(value) {
    return FakeTransaction.current._schedule(() => [...this.store.records.values()]
      .filter(record => record[this.keyPath] === value).map(clone));
  }
  getAllKeys(value) {
    return FakeTransaction.current._schedule(() => [...this.store.records.entries()]
      .filter(([, record]) => record[this.keyPath] === value).map(([key]) => key));
  }
}

class FakeTransaction {
  static current = null;
  constructor(database) {
    this.database = database;
    this.pending = 0;
    this.aborted = false;
    this.completed = false;
    this.error = null;
    FakeTransaction.current = this;
  }
  objectStore(name) { return this.database.stores.get(name); }
  _schedule(operation) {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.pending++;
    queueMicrotask(() => {
      if (!this.aborted) {
        try {
          request.result = operation();
          request.onsuccess?.({ target: request });
        } catch (error) {
          request.error = error;
          this.error = error;
          request.onerror?.({ target: request });
          this.abort();
        }
      }
      this.pending--;
      this._maybeComplete();
    });
    return request;
  }
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    queueMicrotask(() => this.onabort?.({ target: this }));
  }
  _maybeComplete() {
    if (this.aborted || this.pending !== 0 || this.completed) return;
    this.completed = true;
    queueMicrotask(() => this.oncomplete?.({ target: this }));
  }
}

class FakeDatabase {
  constructor() {
    this.stores = new Map();
    this.objectStoreNames = { contains: name => this.stores.has(name) };
  }
  createObjectStore(name, options) {
    const store = new FakeObjectStore(name, options.keyPath);
    this.stores.set(name, store);
    return store;
  }
  transaction() { return new FakeTransaction(this); }
  close() {}
}

class FakeIndexedDB {
  constructor() { this.database = null; }
  open() {
    const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (!this.database) {
        this.database = new FakeDatabase();
        request.result = this.database;
        request.onupgradeneeded?.({ target: { result: this.database } });
      }
      request.result = this.database;
      queueMicrotask(() => request.onsuccess?.({ target: request }));
    });
    return request;
  }
}

test("IndexedDB session records recover through a new store instance and delete atomically by session", async () => {
  const indexedDB = new FakeIndexedDB();
  const store = await createSessionStore(indexedDB);
  const session = {
    schema_version: 1,
    session_id: "synthetic-session",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: null,
    status: "recording",
    packet_count: 0,
    interval_count: 0,
    captured_rr_duration_ms: 0,
    measurement_rr_duration_ms: 0,
    last_notification_received_at: null,
    events: []
  };
  await store.createSession(session);
  const packet = {
    session_id: session.session_id, packet_id: 1, notification_received_at: session.started_at,
    sensor_bpm: 60, rr_count: 1, raw_payload: "003caa", segment_id: 1, parse_status: "malformed"
  };
  const interval = {
    session_id: session.session_id, sequence: 1, packet_id: 1,
    rr_ms: 1000, phase: "measurement", segment_id: 1
  };
  await store.appendNotification(session.session_id, packet, [interval], [
    { event_id: 1, type: "malformed_packet", details: { packet_id: 1 } }
  ]);
  await store.appendEvent(session.session_id, { event_id: 2, type: "synthetic_event" });

  const reopenedStore = await createSessionStore(indexedDB);
  const recovered = await reopenedStore.loadSession(session.session_id);
  assert.equal(recovered.session.packet_count, 1);
  assert.equal(recovered.session.interval_count, 1);
  assert.equal(recovered.session.measurement_rr_duration_ms, 1000);
  assert.equal(recovered.packets[0].raw_payload, "003caa");
  assert.equal(recovered.packets[0].parse_status, "malformed");
  assert.equal(recovered.intervals[0].rr_ms, 1000);
  assert.deepEqual(recovered.session.events.map(event => event.type), ["malformed_packet", "synthetic_event"]);

  await reopenedStore.deleteSession(session.session_id);
  assert.equal((await reopenedStore.listSessions()).length, 0);
  assert.equal((await reopenedStore.loadSession(session.session_id)).session, null);
});

test("reports unavailable IndexedDB instead of silently falling back to memory", async () => {
  await assert.rejects(createSessionStore(null), /IndexedDB is unavailable/);
});
