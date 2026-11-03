const DATABASE_NAME = "polar-h9-rr-viewer";
const DATABASE_VERSION = 1;

function openDatabase(indexedDBApi) {
  if (!indexedDBApi || typeof indexedDBApi.open !== "function") {
    return Promise.reject(new Error("IndexedDB is unavailable in this browser context."));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDBApi.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = event => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains("sessions")) {
        database.createObjectStore("sessions", { keyPath: "session_id" });
      }
      for (const storeName of ["packets", "intervals"]) {
        if (!database.objectStoreNames.contains(storeName)) {
          const store = database.createObjectStore(storeName, { keyPath: "storage_id" });
          store.createIndex("session_id", "session_id", { unique: false });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the local database."));
    request.onblocked = () => reject(new Error("The local database upgrade is blocked by another open tab."));
  });
}

function transact(database, storeNames, mode, operation) {
  return new Promise((resolve, reject) => {
    let result;
    let settled = false;
    let transaction;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error || new Error("IndexedDB transaction failed."));
    };

    try {
      transaction = database.transaction(storeNames, mode);
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      transaction.onerror = () => fail(transaction.error);
      transaction.onabort = () => fail(transaction.error);
      operation(transaction, value => { result = value; });
    } catch (error) {
      try { transaction?.abort(); } catch {}
      fail(error);
    }
  });
}

function storageId(sessionId, sequence) {
  return `${sessionId}:${String(sequence).padStart(12, "0")}`;
}

export async function createSessionStore(indexedDBApi = globalThis.indexedDB) {
  const database = await openDatabase(indexedDBApi);

  return {
    close() { database.close(); },

    createSession(session) {
      return transact(database, ["sessions"], "readwrite", tx => {
        tx.objectStore("sessions").add(session);
      });
    },

    appendNotification(sessionId, packet, intervals, events = []) {
      return transact(database, ["sessions", "packets", "intervals"], "readwrite", (tx, setResult) => {
        const sessions = tx.objectStore("sessions");
        const request = sessions.get(sessionId);
        request.onsuccess = () => {
          const session = request.result;
          if (!session) {
            tx.abort();
            return;
          }
          const storedPacket = { ...packet, storage_id: storageId(sessionId, packet.packet_id) };
          const storedIntervals = intervals.map(interval => ({
            ...interval,
            storage_id: storageId(sessionId, interval.sequence)
          }));
          tx.objectStore("packets").add(storedPacket);
          const intervalStore = tx.objectStore("intervals");
          for (const interval of storedIntervals) intervalStore.add(interval);

          session.packet_count += 1;
          session.interval_count += intervals.length;
          session.captured_rr_duration_ms += intervals.reduce(
            (sum, interval) => sum + (Number.isFinite(interval.rr_ms) && interval.rr_ms > 0 ? interval.rr_ms : 0),
            0
          );
          session.measurement_rr_duration_ms += intervals.reduce(
            (sum, interval) => sum + (interval.phase === "measurement" && Number.isFinite(interval.rr_ms) && interval.rr_ms > 0 ? interval.rr_ms : 0),
            0
          );
          session.last_notification_received_at = packet.notification_received_at;
          session.events.push(...events);
          sessions.put(session);
          setResult(session);
        };
      });
    },

    appendEvent(sessionId, event, patch = {}) {
      return transact(database, ["sessions"], "readwrite", (tx, setResult) => {
        const sessions = tx.objectStore("sessions");
        const request = sessions.get(sessionId);
        request.onsuccess = () => {
          const session = request.result;
          if (!session) {
            tx.abort();
            return;
          }
          session.events.push(event);
          Object.assign(session, patch);
          sessions.put(session);
          setResult(session);
        };
      });
    },

    listSessions() {
      return transact(database, ["sessions"], "readonly", (tx, setResult) => {
        const request = tx.objectStore("sessions").getAll();
        request.onsuccess = () => setResult(request.result.sort((a, b) => b.started_at.localeCompare(a.started_at)));
      });
    },

    loadSession(sessionId) {
      return transact(database, ["sessions", "packets", "intervals"], "readonly", (tx, setResult) => {
        const sessionRequest = tx.objectStore("sessions").get(sessionId);
        const packetsRequest = tx.objectStore("packets").index("session_id").getAll(sessionId);
        const intervalsRequest = tx.objectStore("intervals").index("session_id").getAll(sessionId);
        const result = { session: null, packets: null, intervals: null };
        let completed = 0;
        const finish = () => {
          completed++;
          if (completed === 3) {
            result.packets.sort((a, b) => a.packet_id - b.packet_id);
            result.intervals.sort((a, b) => a.sequence - b.sequence);
            setResult(result);
          }
        };
        sessionRequest.onsuccess = () => { result.session = sessionRequest.result || null; finish(); };
        packetsRequest.onsuccess = () => { result.packets = packetsRequest.result; finish(); };
        intervalsRequest.onsuccess = () => { result.intervals = intervalsRequest.result; finish(); };
      });
    },

    deleteSession(sessionId) {
      return transact(database, ["sessions", "packets", "intervals"], "readwrite", tx => {
        tx.objectStore("sessions").delete(sessionId);
        for (const storeName of ["packets", "intervals"]) {
          const store = tx.objectStore(storeName);
          const request = store.index("session_id").getAllKeys(sessionId);
          request.onsuccess = () => {
            for (const key of request.result) store.delete(key);
          };
        }
      });
    }
  };
}
