-- Meta / Google lead ids merged into an older lead, so re-importing the same export never duplicates them.
CREATE TABLE IF NOT EXISTS lead_ext_ids (external_id TEXT PRIMARY KEY, lead_id INTEGER NOT NULL);
