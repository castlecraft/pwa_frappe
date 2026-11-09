import { openDB } from 'idb';

const DB_NAME = 'frappe_offline_db';
const DB_VERSION = 1;
const DOCS_STORE = 'docs';
const QUEUE_STORE = 'sync_queue';

/**
 * Initializes generic IndexedDB instance for Frappe documents and outbox mutations.
 */
export async function getDb() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // 1. Generic Document Cache store: keyed by composite "${doctype}:${name_or_local_id}"
      if (!db.objectStoreNames.contains(DOCS_STORE)) {
        const docStore = db.createObjectStore(DOCS_STORE, { keyPath: '_key' });
        docStore.createIndex('doctype', 'doctype', { unique: false });
        docStore.createIndex('doctype_name', ['doctype', 'name'], { unique: false });
        docStore.createIndex('sync_status', '_sync_status', { unique: false });
      }

      // 2. Generic Outbox queue for offline mutations (insert, update, delete)
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        const queueStore = db.createObjectStore(QUEUE_STORE, { keyPath: 'id', autoIncrement: true });
        queueStore.createIndex('doctype', 'doctype', { unique: false });
        queueStore.createIndex('status', 'status', { unique: false });
      }
    },
  });
}

function makeDocKey(doctype, nameOrId) {
  return `${doctype}:${nameOrId}`;
}

export const frappeDB = {
  /**
   * Insert a document offline-first.
   * Mirrors `frappe.new_doc()` + `doc.insert()`.
   */
  async insert(doctype, values = {}) {
    const db = await getDb();
    const localId = `local_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();

    const doc = {
      ...values,
      doctype,
      name: values.name || localId,
      _local_id: localId,
      _key: makeDocKey(doctype, values.name || localId),
      _sync_status: 'pending',
      creation: now,
      modified: now,
    };

    // Store in local documents cache
    await db.put(DOCS_STORE, doc);

    // Queue mutation in outbox
    await db.add(QUEUE_STORE, {
      action: 'insert',
      doctype,
      local_id: localId,
      doc_key: doc._key,
      data: values,
      status: 'pending',
      attempts: 0,
      timestamp: now,
    });

    return doc;
  },

  /**
   * Get a single doc by DocType and name/key.
   */
  async getDoc(doctype, name) {
    const db = await getDb();
    return db.get(DOCS_STORE, makeDocKey(doctype, name));
  },

  /**
   * Get list of docs filtered by DocType, mirrors `frappe.get_list(doctype, ...)`.
   */
  async getList(doctype, { filters = {}, orderBy = 'modified', orderDir = 'desc' } = {}) {
    const db = await getDb();
    const all = await db.getAllFromIndex(DOCS_STORE, 'doctype', doctype);

    // Filter in-memory
    let result = all.filter((doc) => {
      for (const [key, val] of Object.entries(filters)) {
        if (doc[key] !== val) return false;
      }
      return true;
    });

    // Sort
    result.sort((a, b) => {
      const aVal = a[orderBy] || '';
      const bVal = b[orderBy] || '';
      return orderDir === 'desc'
        ? (bVal > aVal ? 1 : bVal < aVal ? -1 : 0)
        : (aVal > bVal ? 1 : aVal < bVal ? -1 : 0);
    });

    return result;
  },

  /**
   * Syncs pending outbox queue mutations with Frappe REST endpoints (/api/resource/<DocType>).
   */
  async sync() {
    const db = await getDb();
    const queue = await db.getAllFromIndex(QUEUE_STORE, 'status', 'pending');

    let syncedCount = 0;
    const errors = [];

    for (const item of queue) {
      try {
        let response;
        if (item.action === 'insert') {
          response = await fetch(`/api/resource/${encodeURIComponent(item.doctype)}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify(item.data),
          });
        }

        if (response && response.ok) {
          const resJson = await response.json();
          const serverDoc = resJson.data || resJson.message;

          // Update cached local doc with server document data & name
          const localDoc = await db.get(DOCS_STORE, item.doc_key);
          if (localDoc) {
            // Remove old local key if server assigned an official name
            if (serverDoc.name && serverDoc.name !== localDoc.name) {
              await db.delete(DOCS_STORE, localDoc._key);
            }
            const updated = {
              ...localDoc,
              ...serverDoc,
              _key: makeDocKey(item.doctype, serverDoc.name),
              _sync_status: 'synced',
              _server_synced_at: new Date().toISOString(),
            };
            await db.put(DOCS_STORE, updated);
          }

          // Mark queue item completed and clean up
          await db.delete(QUEUE_STORE, item.id);
          syncedCount++;
        } else if (response && response.status === 401) {
          throw new Error('Authentication required');
        } else {
          item.attempts = (item.attempts || 0) + 1;
          await db.put(QUEUE_STORE, item);
          const errData = response ? await response.text() : 'Network error';
          errors.push({ id: item.id, error: errData });
        }
      } catch (err) {
        errors.push({ id: item.id, error: err.message });
        break; // Stop loop on offline/network disconnection or 401
      }
    }

    return { total: queue.length, synced: syncedCount, errors };
  },

  /**
   * Optionally populate local IndexedDB cache from Frappe REST API.
   * Mirrors `frappe.db.get_list(...)` over network.
   */
  async fetchAndCacheList(doctype, fields = ['*'], limit = 50) {
    try {
      const fieldParam = JSON.stringify(fields);
      const url = `/api/resource/${encodeURIComponent(doctype)}?fields=${encodeURIComponent(fieldParam)}&limit=${limit}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return [];

      const json = await res.json();
      const docs = json.data || [];
      const db = await getDb();

      for (const d of docs) {
        const item = {
          ...d,
          doctype,
          _key: makeDocKey(doctype, d.name),
          _sync_status: 'synced',
          _server_synced_at: new Date().toISOString(),
        };
        await db.put(DOCS_STORE, item);
      }
      return docs;
    } catch {
      return [];
    }
  },
};
