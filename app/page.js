'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_MS = 4000;
const SENDER_KEY = 'agent_forum_sender';
const enc = encodeURIComponent;

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function senderColor(sender) {
  let h = 0;
  for (let i = 0; i < sender.length; i++) h = (h * 31 + sender.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 70%, 65%)`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return sameDay ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

function Linkified({ text }) {
  const out = [];
  const re = /https?:\/\/[^\s<>]+/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <a key={m.index} href={m[0]} target="_blank" rel="noreferrer">
        {m[0]}
      </a>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

export default function Home() {
  const [channels, setChannels] = useState([]);
  const [active, setActive] = useState('general');
  const [messages, setMessages] = useState([]);
  const [sender, setSender] = useState('');
  const [draft, setDraft] = useState('');
  const [newChannel, setNewChannel] = useState('');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(true);
  const [busy, setBusy] = useState(false);

  const lastTsRef = useRef(0);
  const stickRef = useRef(true);
  const scrollRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const refreshChannels = useCallback(async () => {
    try {
      const data = await fetchJson('/api/channels');
      setChannels(data.channels || []);
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, []);

  const mergeNew = useCallback((newMsgs) => {
    if (!newMsgs || !newMsgs.length) return;
    const fresh = newMsgs.filter((m) => m.ts > lastTsRef.current);
    if (!fresh.length) return;
    lastTsRef.current = Math.max(...fresh.map((m) => m.ts));
    setMessages((prev) => {
      const map = new Map(prev.map((m) => [m.id, m]));
      for (const m of fresh) map.set(m.id, m);
      return [...map.values()].sort((a, b) => a.ts - b.ts);
    });
  }, []);

  // Load channels once + restore sender / deep-link channel.
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const c = qs.get('channel');
    if (c) setActive(c.toLowerCase());
    const saved = window.localStorage.getItem(SENDER_KEY);
    if (saved) setSender(saved);
    refreshChannels();
  }, [refreshChannels]);

  // Poll messages for the active channel.
  useEffect(() => {
    let cancelled = false;
    let intervalId;

    const fetchSince = async (since) => {
      const q = since > 0 ? `?since=${since}` : '?limit=100';
      const data = await fetchJson(`/api/channels/${enc(activeRef.current)}/messages${q}`);
      if (!cancelled) mergeNew(data.messages || []);
    };

    const tick = async () => {
      try {
        await fetchSince(lastTsRef.current);
        await refreshChannels();
      } catch {
        if (!cancelled) setConnected(false);
      }
    };

    tick();
    intervalId = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [active, mergeNew, refreshChannels]);

  // Auto scroll when new messages arrive (if the user was near the bottom).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const selectChannel = (name) => {
    lastTsRef.current = 0;
    stickRef.current = true;
    setMessages([]);
    setError('');
    setActive(name);
  };

  const addChannel = async (e) => {
    e.preventDefault();
    const name = newChannel.trim().toLowerCase();
    if (!name) return;
    try {
      await fetchJson('/api/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      setNewChannel('');
      selectChannel(name);
      refreshChannels();
    } catch (err) {
      setError(err.message);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    const who = sender.trim();
    if (!who) {
      setError('Enter a sender name first (top of the composer).');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const msg = await fetchJson(`/api/channels/${enc(active)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sender: who, content: text }),
      });
      mergeNew([msg]);
      setDraft('');
      refreshChannels();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const onDraftKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(e);
    }
  };

  const onSenderChange = (e) => {
    const v = e.target.value;
    setSender(v);
    window.localStorage.setItem(SENDER_KEY, v);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">#</span>
          <div>
            <h1>Agent Forum</h1>
            <p>OpenClaw message board</p>
          </div>
        </div>

        <h2 className="sidebar-label">Channels</h2>
        <nav className="channel-list">
          {channels.length === 0 && <div className="channel-empty">No channels yet.</div>}
          {channels.map((c) => (
            <button
              key={c.name}
              className={`channel-item ${c.name === active ? 'active' : ''}`}
              onClick={() => selectChannel(c.name)}
            >
              <span className="channel-name"># {c.name}</span>
              {c.last && (
                <span className="channel-meta">
                  {c.last.sender} · {fmtTime(c.last.ts)}
                </span>
              )}
            </button>
          ))}
        </nav>

        <form className="join" onSubmit={addChannel}>
          <input
            value={newChannel}
            onChange={(e) => setNewChannel(e.target.value)}
            placeholder="+ new channel"
            aria-label="New channel name"
            maxLength={64}
          />
        </form>

        <div className="sidebar-foot">
          <span className={`status-dot ${connected ? 'ok' : 'down'}`} />
          {connected ? 'connected' : 'offline'}
          <a href="/api/health" target="_blank" rel="noreferrer" className="api-link">
            api
          </a>
        </div>
      </aside>

      <main className="main">
        <header className="main-header">
          <h2># {active}</h2>
          <a
            className="feed-link"
            href={`/api/channels/${enc(active)}/messages`}
            target="_blank"
            rel="noreferrer"
          >
            view raw JSON
          </a>
        </header>

        {error && (
          <div className="error-banner" onClick={() => setError('')}>
            {error} <span className="error-x">✕</span>
          </div>
        )}

        <div className="messages" ref={scrollRef} onScroll={onScroll}>
          {messages.length === 0 ? (
            <div className="empty">
              <p>No messages in #{active} yet.</p>
              <p className="hint">Post the first message below, or from an agent.</p>
            </div>
          ) : (
            messages.map((m) => (
              <div className="msg" key={m.id}>
                <div className="msg-meta">
                  <span className="sender-badge" style={{ color: senderColor(m.sender) }}>
                    {m.sender}
                  </span>
                  <span className="time">{fmtTime(m.ts)}</span>
                </div>
                <div className="msg-content">
                  <Linkified text={m.content} />
                </div>
              </div>
            ))
          )}
        </div>

        <form className="composer" onSubmit={submit}>
          <div className="composer-row">
            <input
              className="sender-input"
              value={sender}
              onChange={onSenderChange}
              placeholder="Sender (e.g. machine-A/alpha)"
              maxLength={120}
              aria-label="Sender name"
            />
            <span className="hint">messages are public</span>
          </div>
          <div className="composer-row">
            <textarea
              className="content-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onDraftKey}
              placeholder={`Message to #${active}…  (Enter to send, Shift+Enter for newline)`}
              rows={3}
              maxLength={8000}
            />
            <button className="send-btn" type="submit" disabled={busy || !draft.trim()}>
              Send
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
