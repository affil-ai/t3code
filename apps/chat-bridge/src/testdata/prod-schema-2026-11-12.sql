-- Production bridge.db schema on 2026-11-12 (commit 9c5819934), structure only; no rows.
CREATE TABLE handled_message (
      event_id TEXT PRIMARY KEY,
      handled_at INTEGER NOT NULL
    );
CREATE TABLE delegated_follow (
      thread_id TEXT PRIMARY KEY,
      chat_thread_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      requested_by TEXT,
      cursor INTEGER NOT NULL,
      until_ms INTEGER NOT NULL
    );
CREATE TABLE inbox (
      event_id TEXT PRIMARY KEY,
      chat_thread_key TEXT NOT NULL,
      event TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL,
      last_error TEXT
    );
CREATE INDEX inbox_thread ON inbox (chat_thread_key);
CREATE TABLE bridge_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
CREATE TABLE thread_context (
      event_id TEXT PRIMARY KEY,
      chat_thread_key TEXT NOT NULL,
      line TEXT NOT NULL
    );
CREATE TABLE conversation_seed (
      chat_thread_key TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      old_thread_id TEXT NOT NULL,
      sync INTEGER NOT NULL
    );
CREATE INDEX seed_chat ON conversation_seed (chat_id);
CREATE TABLE seed_receipt (
      chat_thread_key TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      old_thread_id TEXT NOT NULL,
      thread_id TEXT NOT NULL
    );
CREATE TABLE owed_dispatch (
      event_id TEXT PRIMARY KEY,
      chat_thread_key TEXT NOT NULL,
      run_id TEXT NOT NULL
    );
CREATE TABLE slack_relay_row (
      row_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      at INTEGER NOT NULL
    );
CREATE INDEX slack_relay_row_at ON slack_relay_row (at);
CREATE TABLE binding_group (
        thread_id TEXT PRIMARY KEY,
        sync INTEGER NOT NULL DEFAULT 0,
        last_chat_thread_key TEXT NOT NULL
      );
CREATE TABLE IF NOT EXISTS "binding" (
        chat_thread_key TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        chat_key TEXT NOT NULL UNIQUE,
        created_by_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        muted INTEGER NOT NULL DEFAULT 0
      , followed_model TEXT, model_switched INTEGER NOT NULL DEFAULT 0);
CREATE INDEX binding_thread ON binding (thread_id);
CREATE TABLE IF NOT EXISTS "owed_reply" (
        run_id TEXT NOT NULL, thread_id TEXT NOT NULL, chat_thread_key TEXT NOT NULL,
        posted_at INTEGER, requested_by TEXT, claimed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id, chat_thread_key)
      );
CREATE TABLE IF NOT EXISTS "question" (
        request_id TEXT NOT NULL, chat_thread_key TEXT NOT NULL, thread_id TEXT NOT NULL,
        asked TEXT NOT NULL, message_id TEXT NOT NULL DEFAULT '', closed INTEGER NOT NULL DEFAULT 0, posted INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (request_id, chat_thread_key)
      );
CREATE INDEX question_thread ON question (chat_thread_key);
CREATE TABLE state_subscription (thread_id TEXT PRIMARY KEY);
CREATE TABLE state_lock (
      thread_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
CREATE TABLE state_cache (
      cache_key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER
    );
CREATE TABLE state_list (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      list_key TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER
    );
CREATE INDEX state_list_key ON state_list (list_key, seq);
CREATE TABLE state_queue (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
CREATE INDEX state_queue_thread ON state_queue (thread_id, seq);
CREATE TABLE delivered_message (
      event_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      delivered_at INTEGER NOT NULL
    );
CREATE TABLE article_access (
      event_id TEXT PRIMARY KEY,
      chat_thread_key TEXT NOT NULL,
      author TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      office_run_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      run_id TEXT
    , dispatched_run_id TEXT);
CREATE INDEX article_access_run ON article_access (run_id);
CREATE TABLE delegated_follow_run (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      chat_thread_key TEXT NOT NULL,
      requested_by TEXT,
      until_ms INTEGER NOT NULL
    );
CREATE INDEX delegated_follow_run_thread ON delegated_follow_run (thread_id);
CREATE TABLE notification_cursor (
      thread_id TEXT PRIMARY KEY,
      cursor INTEGER NOT NULL
    );
