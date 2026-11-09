import React, { useState, useEffect } from 'react';
import { frappeDB } from './db.js';

export default function App() {
  const [userInfo, setUserInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // Generic Frappe DocType demo (Note)
  const [notes, setNotes] = useState([]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');

  useEffect(() => {
    fetchLoggedUser();
    refreshNotes();

    const handleOnline = () => {
      setIsOnline(true);
      triggerSync();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const refreshNotes = async () => {
    // Uses generic frappeDB.getList('Note')
    const list = await frappeDB.getList('Note', { orderBy: 'modified', orderDir: 'desc' });
    setNotes(list);
  };

  const fetchLoggedUser = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/method/frappe.auth.get_logged_user', {
        headers: { Accept: 'application/json' },
      });

      if (!res.ok || res.status === 401 || res.status === 403 || res.redirected) {
        setUserInfo(null);
        return;
      }

      const data = await res.json();
      const user = data.message;
      if (typeof user === 'string') {
        setUserInfo(user);
        // Once user is identified, optionally refresh server list into local cache
        await frappeDB.fetchAndCacheList('Note', ['name', 'title', 'content', 'modified']);
        await refreshNotes();
      } else {
        setUserInfo(null);
      }
    } catch {
      setUserInfo(null);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateNote = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;

    // Uses generic frappeDB.insert(doctype, docData)
    await frappeDB.insert('Note', {
      title: title.trim(),
      content: content.trim(),
      public: 0,
    });

    setTitle('');
    setContent('');
    await refreshNotes();

    if (navigator.onLine) {
      triggerSync();
    }
  };

  const triggerSync = async () => {
    setSyncing(true);
    setSyncMessage('');
    try {
      const res = await frappeDB.sync();
      if (res.synced > 0) {
        setSyncMessage(`Synced ${res.synced} document(s) with Frappe.`);
      }
      await refreshNotes();
    } catch {
      setSyncMessage('Sync halted: network offline or session expired.');
    } finally {
      setSyncing(false);
    }
  };

  const handleLogin = () => {
    window.location.href = '/oauth2/start?rd=' + encodeURIComponent(window.location.href);
  };

  const handleLogout = () => {
    window.location.href = '/oauth2/sign_out?rd=' + encodeURIComponent(window.location.origin);
  };

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '680px', margin: '0 auto', color: '#1a202c' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0 }}>Frappe Offline PWA</h2>
          <small style={{ color: '#64748b' }}>Generic <code>frappeDB</code> IndexedDB Outbox</small>
        </div>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 10px',
            borderRadius: '12px',
            fontSize: '12px',
            fontWeight: 600,
            background: isOnline ? '#def7ec' : '#fde8e8',
            color: isOnline ? '#03543f' : '#9b1c1c',
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: isOnline ? '#31c48d' : '#f98080' }}></span>
          {isOnline ? 'Online' : 'Offline'}
        </span>
      </header>

      {/* Session Box */}
      <section style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '1rem', marginTop: '1rem', background: '#f8fafc' }}>
        {loading ? (
          <p style={{ margin: 0 }}>Verifying forward auth session...</p>
        ) : userInfo ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Logged in as: <strong>{userInfo}</strong></span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={triggerSync} disabled={syncing} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', border: '1px solid #cbd5e1' }}>
                {syncing ? 'Syncing...' : 'Sync Outbox'}
              </button>
              <button onClick={handleLogout} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', background: '#ef4444', color: '#fff', border: 'none' }}>
                Sign Out
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Not logged in with Dex</span>
            <button onClick={handleLogin} style={{ padding: '6px 14px', cursor: 'pointer', borderRadius: '4px', background: '#2563eb', color: '#fff', border: 'none', fontWeight: 600 }}>
              Sign In via Dex
            </button>
          </div>
        )}
      </section>

      {syncMessage && (
        <div style={{ padding: '8px 12px', marginTop: '10px', borderRadius: '4px', background: '#eff6ff', color: '#1d4ed8', fontSize: '13px' }}>
          {syncMessage}
        </div>
      )}

      {/* Generic Form */}
      <section style={{ marginTop: '1.5rem', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '1.25rem' }}>
        <h3 style={{ marginTop: 0 }}>New Doc (DocType: <code>Note</code>)</h3>
        <form onSubmit={handleCreateNote}>
          <div style={{ marginBottom: '10px' }}>
            <input
              type="text"
              placeholder="Title *"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '4px', border: '1px solid #cbd5e1' }}
            />
          </div>
          <div style={{ marginBottom: '10px' }}>
            <textarea
              placeholder="Content..."
              rows={3}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '4px', border: '1px solid #cbd5e1' }}
            />
          </div>
          <button
            type="submit"
            style={{ padding: '8px 16px', borderRadius: '4px', background: '#059669', color: '#fff', border: 'none', fontWeight: 600, cursor: 'pointer' }}
          >
            Insert via frappeDB.insert()
          </button>
        </form>
      </section>

      {/* Docs List */}
      <section style={{ marginTop: '1.5rem' }}>
        <h3>Cached Documents ({notes.length})</h3>
        {notes.length === 0 ? (
          <p style={{ color: '#94a3b8' }}>No local documents stored.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {notes.map((n) => (
              <div key={n._key || n.name} style={{ border: '1px solid #e2e8f0', borderRadius: '6px', padding: '10px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4 style={{ margin: '0 0 4px 0' }}>{n.title}</h4>
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      fontWeight: 600,
                      background: n._sync_status === 'synced' ? '#def7ec' : '#fef08a',
                      color: n._sync_status === 'synced' ? '#03543f' : '#713f12',
                    }}
                  >
                    {n._sync_status === 'synced' ? `Synced: ${n.name}` : 'Local (Pending Sync)'}
                  </span>
                </div>
                {n.content && <p style={{ margin: '4px 0', fontSize: '14px', color: '#334155' }}>{n.content}</p>}
                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '6px' }}>
                  DocType: <code>{n.doctype}</code> | Modified: {n.modified ? new Date(n.modified).toLocaleTimeString() : 'now'}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
