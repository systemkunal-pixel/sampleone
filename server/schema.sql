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
ALTER TABLE loans ADD UNIQUE KEY IF NOT EXISTS uq_loans_company_loan_no (company_id, loan_no);
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
