-- LoanDesk schema for MariaDB 10.6+. Applied automatically at server start (idempotent).
-- Statements are split on semicolons, so don't use one inside a string or comment.
-- Timestamps are local time in the server's configured TZ (default Asia/Kolkata).

CREATE TABLE IF NOT EXISTS users (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(12)  NOT NULL,
  name        VARCHAR(100) NOT NULL,
  role        ENUM('officer', 'supervisor') NOT NULL,
  branch      VARCHAR(100) NOT NULL,
  pin_hash    VARCHAR(200) NOT NULL,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  CHAR(64)     NOT NULL PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  created_at  DATETIME     NOT NULL,
  expires_at  DATETIME     NOT NULL,
  KEY ix_sessions_user (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS loans (
  id              VARCHAR(40)   NOT NULL PRIMARY KEY,
  loan_no         VARCHAR(40)   NOT NULL,
  branch          VARCHAR(100)  NOT NULL,
  officer_code    VARCHAR(12)   NULL,
  product         VARCHAR(60)   NOT NULL,
  principal       DECIMAL(12,2) NOT NULL,
  emi             DECIMAL(12,2) NOT NULL,
  disbursed_on    DATE          NOT NULL,
  borrower        LONGTEXT      NOT NULL CHECK (JSON_VALID(borrower)),
  installments    LONGTEXT      NOT NULL CHECK (JSON_VALID(installments)),
  follow_up_date  DATE          NULL,
  UNIQUE KEY uq_loans_loan_no (loan_no),
  KEY ix_loans_officer (officer_code),
  KEY ix_loans_branch (branch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id                 VARCHAR(64)   NOT NULL PRIMARY KEY,
  loan_id            VARCHAR(40)   NOT NULL,
  recorded_at        DATETIME      NOT NULL,
  amount             DECIMAL(12,2) NOT NULL,
  mode               VARCHAR(20)   NOT NULL,
  reference          VARCHAR(60)   NOT NULL DEFAULT '',
  receipt_no         VARCHAR(40)   NOT NULL,
  officer_code       VARCHAR(12)   NOT NULL,
  location           LONGTEXT      NULL CHECK (location IS NULL OR JSON_VALID(location)),
  received_at        DATETIME      NOT NULL,
  -- Bank deposit details (NULL for cash/UPI/etc.)
  slip_no            VARCHAR(40)   NULL,
  slip_key           VARCHAR(40)   NULL COMMENT 'normalised slip_no, cleared on rejection so the slip can be re-entered',
  deposit_bank       VARCHAR(100)  NULL,
  deposit_date       DATE          NULL,
  verification       ENUM('pending', 'verified', 'rejected') NULL,
  verified_by        VARCHAR(12)   NULL,
  verified_at        DATETIME      NULL,
  verification_note  VARCHAR(300)  NULL,
  UNIQUE KEY uq_payments_slip_key (slip_key),
  KEY ix_payments_loan (loan_id),
  KEY ix_payments_verification (verification, recorded_at),
  KEY ix_payments_receipt (officer_code, receipt_no),
  CONSTRAINT fk_payments_loan FOREIGN KEY (loan_id) REFERENCES loans (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS deposit_slips (
  payment_id  VARCHAR(64) NOT NULL PRIMARY KEY,
  mime_type   VARCHAR(40) NOT NULL,
  data        MEDIUMBLOB  NOT NULL,
  CONSTRAINT fk_slips_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS visits (
  id              VARCHAR(64)   NOT NULL PRIMARY KEY,
  loan_id         VARCHAR(40)   NOT NULL,
  recorded_at     DATETIME      NOT NULL,
  outcome         VARCHAR(20)   NOT NULL,
  notes           VARCHAR(500)  NOT NULL DEFAULT '',
  ptp_date        DATE          NULL,
  ptp_amount      DECIMAL(12,2) NULL,
  follow_up_date  DATE          NULL,
  officer_code    VARCHAR(12)   NOT NULL,
  location        LONGTEXT      NULL CHECK (location IS NULL OR JSON_VALID(location)),
  received_at     DATETIME      NOT NULL,
  KEY ix_visits_loan (loan_id),
  CONSTRAINT fk_visits_loan FOREIGN KEY (loan_id) REFERENCES loans (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  at         DATETIME    NOT NULL,
  user_code  VARCHAR(12) NULL,
  action     VARCHAR(40) NOT NULL,
  entity_id  VARCHAR(64) NULL,
  detail     TEXT        NULL,
  KEY ix_audit_entity (entity_id),
  KEY ix_audit_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- v2: admin console. ALTERs are idempotent so existing databases upgrade in place.
ALTER TABLE users MODIFY role ENUM('officer', 'supervisor', 'admin') NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at DATETIME NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at DATETIME NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS created_at DATETIME NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS updated_at DATETIME NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS import_id INT UNSIGNED NULL;

CREATE TABLE IF NOT EXISTS imports (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  at          DATETIME     NOT NULL,
  user_code   VARCHAR(12)  NOT NULL,
  file_name   VARCHAR(200) NOT NULL,
  total_rows  INT UNSIGNED NOT NULL,
  created     INT UNSIGNED NOT NULL,
  updated     INT UNSIGNED NOT NULL,
  skipped     INT UNSIGNED NOT NULL,
  KEY ix_imports_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- v3: multi-company (each lending company is an isolated workspace) and the overlord console.
CREATE TABLE IF NOT EXISTS companies (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code           VARCHAR(12)  NOT NULL,
  name           VARCHAR(150) NOT NULL,
  plan           ENUM('regular', 'pro', 'enterprise') NOT NULL DEFAULT 'regular',
  max_officers   INT UNSIGNED NULL COMMENT 'overrides the plan limit when set',
  status         ENUM('active', 'locked', 'archived') NOT NULL DEFAULT 'active',
  status_reason  VARCHAR(300) NULL,
  status_at      DATETIME     NULL,
  status_by      VARCHAR(190) NULL,
  contact_name   VARCHAR(100) NULL,
  contact_email  VARCHAR(190) NULL,
  contact_phone  VARCHAR(20)  NULL,
  created_at     DATETIME     NOT NULL,
  UNIQUE KEY uq_companies_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- First run of v3: existing data belongs to company 1, plus an empty in-house company for testing.
-- created_at is India time here (the app's default zone), since NOW() follows the database server's zone.
INSERT INTO companies (id, code, name, plan, created_at)
  SELECT 1, 'BRMC', 'Bihar Risk Management Consultancy Private Limited', 'enterprise', CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30') FROM DUAL
  WHERE NOT EXISTS (SELECT 1 FROM companies);
INSERT INTO companies (id, code, name, plan, created_at)
  SELECT 2, 'DATAHAAT', 'DataHaat', 'enterprise', CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30') FROM DUAL
  WHERE (SELECT COUNT(*) FROM companies) = 1 AND NOT EXISTS (SELECT 1 FROM companies WHERE code = 'DATAHAAT');

ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INT UNSIGNED NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE users MODIFY company_id INT UNSIGNED NOT NULL;
ALTER TABLE users ADD UNIQUE KEY IF NOT EXISTS uq_users_company_code (company_id, code);
ALTER TABLE users DROP INDEX IF EXISTS uq_users_code;

ALTER TABLE loans ADD COLUMN IF NOT EXISTS company_id INT UNSIGNED NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE loans MODIFY company_id INT UNSIGNED NOT NULL;
ALTER TABLE loans ADD KEY IF NOT EXISTS ix_loans_company_officer (company_id, officer_code);
ALTER TABLE loans ADD KEY IF NOT EXISTS ix_loans_company_branch (company_id, branch);
ALTER TABLE loans DROP INDEX IF EXISTS uq_loans_loan_no;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS company_id INT UNSIGNED NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE payments MODIFY company_id INT UNSIGNED NOT NULL;
ALTER TABLE payments ADD UNIQUE KEY IF NOT EXISTS uq_payments_company_slip (company_id, slip_key);
ALTER TABLE payments ADD KEY IF NOT EXISTS ix_payments_company_time (company_id, recorded_at);
ALTER TABLE payments DROP INDEX IF EXISTS uq_payments_slip_key;

ALTER TABLE imports ADD COLUMN IF NOT EXISTS company_id INT UNSIGNED NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE imports MODIFY company_id INT UNSIGNED NOT NULL;
ALTER TABLE imports ADD KEY IF NOT EXISTS ix_imports_company (company_id, id);

-- NULL company: a failed sign-in that matched no company.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS company_id INT UNSIGNED NULL DEFAULT 1 AFTER id;
ALTER TABLE audit_log MODIFY company_id INT UNSIGNED NULL DEFAULT NULL;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS support_id BIGINT UNSIGNED NULL;
ALTER TABLE audit_log ADD KEY IF NOT EXISTS ix_audit_company (company_id, id);

-- Support sessions have no user row: they act as a virtual admin of the company.
ALTER TABLE sessions MODIFY user_id INT UNSIGNED NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS company_id INT UNSIGNED NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS support_id BIGINT UNSIGNED NULL;

CREATE TABLE IF NOT EXISTS overlords (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email          VARCHAR(190) NOT NULL,
  name           VARCHAR(100) NOT NULL,
  password_hash  VARCHAR(200) NOT NULL,
  totp_secret    VARCHAR(64)  NULL,
  totp_enabled   TINYINT(1)   NOT NULL DEFAULT 0,
  totp_last_step BIGINT       NULL,
  active         TINYINT(1)   NOT NULL DEFAULT 1,
  created_at     DATETIME     NOT NULL,
  last_login_at  DATETIME     NULL,
  UNIQUE KEY uq_overlords_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS overlord_sessions (
  token_hash   CHAR(64)     NOT NULL PRIMARY KEY,
  overlord_id  INT UNSIGNED NOT NULL,
  stage        ENUM('password', 'full') NOT NULL,
  attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at   DATETIME     NOT NULL,
  expires_at   DATETIME     NOT NULL,
  KEY ix_overlord_sessions_overlord (overlord_id),
  CONSTRAINT fk_overlord_sessions FOREIGN KEY (overlord_id) REFERENCES overlords (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_sessions (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  overlord_id     INT UNSIGNED NOT NULL,
  company_id      INT UNSIGNED NOT NULL,
  reason          VARCHAR(300) NOT NULL,
  started_at      DATETIME     NOT NULL,
  expires_at      DATETIME     NOT NULL,
  ended_at        DATETIME     NULL,
  ip              VARCHAR(45)  NULL,
  owner_notified  TINYINT(1)   NOT NULL DEFAULT 0,
  KEY ix_support_company (company_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only record of everything done from the overlord console.
CREATE TABLE IF NOT EXISTS overlord_audit (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  at              DATETIME     NOT NULL,
  overlord_id     INT UNSIGNED NULL,
  overlord_email  VARCHAR(190) NULL,
  action          VARCHAR(40)  NOT NULL,
  company_id      INT UNSIGNED NULL,
  detail          TEXT         NULL,
  ip              VARCHAR(45)  NULL,
  KEY ix_overlord_audit_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Plan matrix: rows exist only where the overlord changed the built-in default.
CREATE TABLE IF NOT EXISTS plans (
  code          ENUM('regular', 'pro', 'enterprise') NOT NULL PRIMARY KEY,
  max_officers  INT UNSIGNED NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO plans (code, max_officers) VALUES ('regular', 10), ('pro', 50), ('enterprise', NULL);

CREATE TABLE IF NOT EXISTS plan_features (
  plan     ENUM('regular', 'pro', 'enterprise') NOT NULL,
  feature  VARCHAR(40) NOT NULL,
  enabled  TINYINT(1)  NOT NULL,
  PRIMARY KEY (plan, feature)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS company_feature_overrides (
  company_id  INT UNSIGNED NOT NULL,
  feature     VARCHAR(40)  NOT NULL,
  enabled     TINYINT(1)   NOT NULL,
  PRIMARY KEY (company_id, feature)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- v4: signed updates. The updater agent (server/supervisor.js) applies packages staged in the overlord console.
CREATE TABLE IF NOT EXISTS platform_updates (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  from_version    VARCHAR(20)  NOT NULL,
  to_version      VARCHAR(20)  NOT NULL,
  file_name       VARCHAR(200) NOT NULL,
  sha256          CHAR(64)     NOT NULL,
  size            INT UNSIGNED NOT NULL,
  schema_changes  TINYINT(1)   NOT NULL DEFAULT 0,
  staged_by       VARCHAR(190) NOT NULL,
  staged_at       DATETIME     NOT NULL,
  status          ENUM('staged', 'applying', 'applied', 'rolled_back', 'failed', 'cancelled') NOT NULL,
  started_at      DATETIME     NULL,
  finished_at     DATETIME     NULL,
  detail          TEXT         NULL,
  KEY ix_platform_updates_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every verify, stage and cancel (refusals included) and each step the agent takes.
CREATE TABLE IF NOT EXISTS platform_update_events (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  at         DATETIME     NOT NULL,
  actor      VARCHAR(190) NOT NULL,
  action     VARCHAR(20)  NOT NULL,
  outcome    VARCHAR(20)  NOT NULL,
  file_name  VARCHAR(200) NULL,
  size       INT UNSIGNED NULL,
  update_id  INT UNSIGNED NULL,
  detail     TEXT         NULL,
  KEY ix_update_events_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Small facts about this installation: the agent's heartbeat and the last deploy time.
CREATE TABLE IF NOT EXISTS platform_state (
  k           VARCHAR(40)  NOT NULL PRIMARY KEY,
  v           TEXT         NULL,
  updated_at  DATETIME     NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
;

-- v5: demo requests from the home page (lead generation), handled in the overlord console.
CREATE TABLE IF NOT EXISTS leads (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  at          DATETIME     NOT NULL,
  name        VARCHAR(100) NOT NULL,
  company     VARCHAR(150) NOT NULL,
  phone       VARCHAR(15)  NOT NULL,
  email       VARCHAR(190) NULL,
  officers    INT UNSIGNED NULL,
  message     VARCHAR(1000) NULL,
  lang        VARCHAR(5)   NULL,
  ip          VARCHAR(45)  NULL,
  status      ENUM('new', 'contacted', 'demo_done', 'won', 'lost') NOT NULL DEFAULT 'new',
  note        VARCHAR(1000) NULL,
  updated_by  VARCHAR(190) NULL,
  updated_at  DATETIME     NULL,
  KEY ix_leads_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
;

-- v6: email. SMTP settings (one row, edited in the overlord console), every message sent, admin
-- email addresses and summary preferences, and password-reset links.
CREATE TABLE IF NOT EXISTS mail_settings (
  id              TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  host            VARCHAR(190) NULL,
  port            SMALLINT UNSIGNED NULL,
  security        ENUM('starttls', 'ssl', 'none') NOT NULL DEFAULT 'starttls',
  username        VARCHAR(190) NULL,
  password_enc    VARCHAR(500) NULL,
  from_name       VARCHAR(100) NULL,
  from_email      VARCHAR(190) NULL,
  site_url        VARCHAR(190) NULL,
  alert_to        VARCHAR(500) NULL,
  alert_leads     TINYINT(1)   NOT NULL DEFAULT 1,
  alert_updates   TINYINT(1)   NOT NULL DEFAULT 1,
  alert_support   TINYINT(1)   NOT NULL DEFAULT 1,
  summaries       TINYINT(1)   NOT NULL DEFAULT 1,
  updated_by      VARCHAR(190) NULL,
  updated_at      DATETIME     NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mail_log (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  at          DATETIME     NOT NULL,
  kind        VARCHAR(30)  NOT NULL,
  recipients  VARCHAR(1000) NOT NULL,
  subject     VARCHAR(250) NOT NULL,
  company_id  INT UNSIGNED NULL,
  status      ENUM('sending', 'sent', 'failed', 'skipped') NOT NULL,
  error       VARCHAR(500) NULL,
  dedupe_key  VARCHAR(100) NULL,
  UNIQUE KEY uq_mail_log_dedupe (dedupe_key),
  KEY ix_mail_log_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(190) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS summary_email ENUM('off', 'daily', 'weekly') NOT NULL DEFAULT 'daily';

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash  CHAR(64)     NOT NULL PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  created_at  DATETIME     NOT NULL,
  expires_at  DATETIME     NOT NULL,
  used_at     DATETIME     NULL,
  ip          VARCHAR(45)  NULL,
  KEY ix_password_resets_user (user_id),
  CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The overlords are told how each update ended. Updates staged from v6 on start at mailed = 0;
-- older rows (NULL) count as told.
ALTER TABLE platform_updates ADD COLUMN IF NOT EXISTS mailed TINYINT(1) NULL;
UPDATE platform_updates SET mailed = 1 WHERE mailed IS NULL
;

-- v7: where each account is (for recovery lists that come by pincode), and the agent deputed to each
-- pincode. New accounts in a pincode with a deputed agent are assigned to that agent on import.
ALTER TABLE loans ADD COLUMN IF NOT EXISTS state VARCHAR(60) NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS district VARCHAR(100) NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS pincode CHAR(6) NULL;
ALTER TABLE loans ADD KEY IF NOT EXISTS ix_loans_company_pincode (company_id, pincode);

CREATE TABLE IF NOT EXISTS area_agents (
  company_id    INT UNSIGNED NOT NULL,
  branch        VARCHAR(100) NOT NULL,
  pincode       CHAR(6)      NOT NULL,
  officer_code  VARCHAR(12)  NOT NULL,
  updated_by    VARCHAR(12)  NOT NULL,
  updated_at    DATETIME     NOT NULL,
  PRIMARY KEY (company_id, branch, pincode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
;

-- v8: where each field agent lives and how far they travel, for the pincode recruitment plan.
ALTER TABLE users ADD COLUMN IF NOT EXISTS base_pincode CHAR(6) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS range_km SMALLINT UNSIGNED NULL
;

-- v9: clients (the lenders whose accounts a company recovers, e.g. VFS Capital Limited), every column of a
-- client's file kept on the account, and agents who work for every client in their pincodes.
CREATE TABLE IF NOT EXISTS clients (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id     INT UNSIGNED NOT NULL,
  code           VARCHAR(20)  NOT NULL,
  name           VARCHAR(150) NOT NULL,
  contact_name   VARCHAR(100) NULL,
  contact_email  VARCHAR(190) NULL,
  contact_phone  VARCHAR(20)  NULL,
  fee_pct        DECIMAL(5,2) NULL,
  active         TINYINT(1)   NOT NULL DEFAULT 1,
  created_at     DATETIME     NOT NULL,
  UNIQUE KEY uq_clients_company_code (company_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE loans ADD COLUMN IF NOT EXISTS client_id INT UNSIGNED NULL;
ALTER TABLE loans ADD KEY IF NOT EXISTS ix_loans_company_client (company_id, client_id);
ALTER TABLE loans ADD COLUMN IF NOT EXISTS cust_code VARCHAR(40) NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS asset_class VARCHAR(20) NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS os_amt DECIMAL(14,2) NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS int_rate DECIMAL(6,2) NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS due_since DATE NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS od_days INT NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS p_odue DECIMAL(14,2) NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS i_odue DECIMAL(14,2) NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS o_odue DECIMAL(14,2) NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS t_odue DECIMAL(14,2) NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS npa_date DATE NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS source_row TEXT NULL
;
-- Account numbers are unique per client (two clients may use the same numbers).
ALTER TABLE loans ADD COLUMN IF NOT EXISTS client_key INT UNSIGNED AS (COALESCE(client_id, 0)) PERSISTENT;
ALTER TABLE loans ADD UNIQUE KEY IF NOT EXISTS uq_loans_company_client_loan_no (company_id, client_key, loan_no);
ALTER TABLE loans DROP INDEX IF EXISTS uq_loans_company_loan_no
;
ALTER TABLE imports ADD COLUMN IF NOT EXISTS client_id INT UNSIGNED NULL
;

-- v10: the field team. State Heads → District Coordinators → Agents; everyone reports to one person above.
-- Agents sign in as field officers, State Heads and Coordinators as supervisors of their own team.
ALTER TABLE users ADD COLUMN IF NOT EXISTS post ENUM('state_head', 'coordinator', 'agent') NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_code VARCHAR(12) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS area_states VARCHAR(300) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS area_districts VARCHAR(1000) NULL;
ALTER TABLE users ADD KEY IF NOT EXISTS ix_users_company_parent (company_id, parent_code)
;

-- v11: circles — billing areas a client's accounts are grouped into, defined by the company per client
-- (whole states, districts — possibly from two states — or single pincodes). Each payment keeps the
-- client and circle it had when it was collected, so a past bill never changes.
CREATE TABLE IF NOT EXISTS circles (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id  INT UNSIGNED NOT NULL,
  client_id   INT UNSIGNED NOT NULL,
  name        VARCHAR(100) NOT NULL,
  fee_pct     DECIMAL(5,2) NULL,
  created_at  DATETIME     NOT NULL,
  UNIQUE KEY uq_circles_client_name (client_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS circle_areas (
  circle_id  INT UNSIGNED NOT NULL,
  kind       ENUM('state', 'district', 'pincode') NOT NULL,
  value      VARCHAR(100) NOT NULL,
  PRIMARY KEY (circle_id, kind, value),
  CONSTRAINT fk_circle_areas FOREIGN KEY (circle_id) REFERENCES circles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE loans ADD COLUMN IF NOT EXISTS circle_id INT UNSIGNED NULL;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS circle_in_file VARCHAR(100) NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS client_id INT UNSIGNED NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS circle_id INT UNSIGNED NULL;
UPDATE payments p JOIN loans l ON l.id = p.loan_id SET p.client_id = l.client_id WHERE p.client_id IS NULL AND l.client_id IS NOT NULL
