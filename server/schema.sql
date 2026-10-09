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
