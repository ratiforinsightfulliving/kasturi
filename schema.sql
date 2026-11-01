-- Kasturi CRM — D1 schema. Idempotent: safe to run again (CREATE ... IF NOT EXISTS).
-- New columns on an existing database need a file in migrations/ (ALTER TABLE), not an edit here.
-- Timestamps are IST strings 'YYYY-MM-DD HH:MM:SS'.

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'counsellor',        -- admin | counsellor
  pass_hash TEXT NOT NULL,
  temp_pass TEXT,                                  -- sealed temporary password until the user sets their own
  must_change INTEGER NOT NULL DEFAULT 1,
  token_ver INTEGER NOT NULL DEFAULT 1,            -- bump to sign the user out everywhere
  active INTEGER NOT NULL DEFAULT 1,
  in_rotation INTEGER NOT NULL DEFAULT 1,          -- gets new leads in round-robin
  last_assigned_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6b6480',
  kind TEXT NOT NULL DEFAULT 'open',               -- new | open | won | lost
  sort INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO stages (id,name,color,kind,sort) VALUES
  (1,'New','#2563eb','new',1),
  (2,'Contacted','#7c3aed','open',2),
  (3,'Interested','#c47a12','open',3),
  (4,'Follow-up','#0891b2','open',4),
  (5,'Enrolled','#15803d','won',5),
  (6,'Not interested','#9a93ad','lost',6);

-- Where leads come from. Webhooks are authenticated by the random key in their URL.
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,                              -- meta | google | gform | web | whatsapp | other
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  secret TEXT,                                     -- google_key for Google Ads
  status TEXT NOT NULL DEFAULT 'active',           -- active | paused
  page_id TEXT, form_ids TEXT, page_token TEXT,    -- Meta Lead Ads
  wa_phone_id TEXT,                                -- WhatsApp Cloud API phone_number_id
  lead_count INTEGER NOT NULL DEFAULT 0,
  last_lead_at TEXT, last_error TEXT, last_error_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sources_page ON sources(page_id);
CREATE INDEX IF NOT EXISTS sources_wa ON sources(wa_phone_id);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  name TEXT, phone TEXT, email TEXT, city TEXT,
  message TEXT, interest TEXT,                     -- what they asked about / which course
  source_id INTEGER, stage_id INTEGER, owner_id INTEGER,
  campaign TEXT, adset TEXT, ad TEXT, form TEXT, platform TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, landing_page TEXT,
  extra TEXT,                                      -- JSON of any other form answers
  external_id TEXT,                                -- Meta leadgen_id / Google lead_id (no double imports)
  enquiry_count INTEGER NOT NULL DEFAULT 1,
  next_followup_at TEXT, last_contact_at TEXT,
  student_id INTEGER,
  created_at TEXT NOT NULL, created_day TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS leads_email ON leads(email);
CREATE UNIQUE INDEX IF NOT EXISTS leads_ext ON leads(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_stage ON leads(stage_id, id);
CREATE INDEX IF NOT EXISTS leads_owner ON leads(owner_id, id);
CREATE INDEX IF NOT EXISTS leads_day ON leads(created_day);
CREATE INDEX IF NOT EXISTS leads_fu ON leads(next_followup_at) WHERE next_followup_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL,
  user_id INTEGER,
  type TEXT NOT NULL,                              -- system | note | call | whatsapp | email | stage
  outcome TEXT,                                    -- calls: connected | no_answer | busy | switched_off | wrong_number | call_back
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS act_lead ON activities(lead_id, id);

-- Programs the students join (a course, a batch, a workshop …)
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  schedule TEXT,                                   -- e.g. "Every Sat & Sun, 7–8 pm IST"
  class_link TEXT,                                 -- Zoom / Google Meet link
  starts_on TEXT,
  price INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO courses (id,name,description,schedule,price,active,created_at) VALUES
  (1,'Kasturi Meditation Classes','An ongoing guided meditation course for IT professionals: self-awareness, handling work pressure and making space for personal well-being. Guided online classes on Google Meet.',
   NULL,3000,1,datetime('now','+330 minutes'));

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT,
  token TEXT NOT NULL,                             -- part of the personal portal link; rotate to revoke
  active INTEGER NOT NULL DEFAULT 1,
  link_sent_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS students_email ON students(email);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',           -- active | completed | cancelled
  enrolled_by INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(student_id, course_id)
);
CREATE INDEX IF NOT EXISTS enr_course ON enrollments(course_id);
CREATE INDEX IF NOT EXISTS enr_day ON enrollments(created_at);

-- What students see in their portal: class notes, recordings, wellness tips, announcements.
CREATE TABLE IF NOT EXISTS updates (
  id INTEGER PRIMARY KEY,
  course_id INTEGER,                               -- NULL = every student
  kind TEXT NOT NULL DEFAULT 'announcement',       -- class | notes | recording | wellness | announcement
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS updates_course ON updates(course_id, id);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY,
  to_email TEXT, subject TEXT, kind TEXT, provider TEXT, ok INTEGER, detail TEXT, created_at TEXT NOT NULL
);

-- Fixed-window rate limits (login attempts, student phone lookups).
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL);
