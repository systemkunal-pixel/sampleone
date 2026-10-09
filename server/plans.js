// Plan tiers and the features each includes. The overlord can change the matrix and override any
// feature for one company; the defaults below apply wherever no change was made.

export const PLANS = [
  { code: 'regular', label: 'Regular' },
  { code: 'pro', label: 'Pro' },
  { code: 'enterprise', label: 'Enterprise' },
];
export const PLAN_CODES = PLANS.map((p) => p.code);

export const FEATURES = [
  {
    key: 'loan_import', label: 'Loan import', detail: 'Upload loans from Excel, CSV or JSON in the admin console.',
    defaults: { regular: true, pro: true, enterprise: true },
  },
  {
    key: 'bank_deposits', label: 'Bank deposits & verification',
    detail: 'Officers record deposits with a slip photo; supervisors verify or reject them.',
    defaults: { regular: false, pro: true, enterprise: true },
  },
  {
    key: 'loan_export', label: 'CSV export', detail: 'Download the loan list with dues and DPD.',
    defaults: { regular: false, pro: true, enterprise: true },
  },
  {
    key: 'audit_log', label: 'Audit log screen', detail: "Admins can browse the company's audit trail.",
    defaults: { regular: false, pro: true, enterprise: true },
  },
];
export const FEATURE_KEYS = FEATURES.map((f) => f.key);

/** The plan matrix with the overlord's changes applied: { regular: { loan_import: true, … }, … }. */
export async function planMatrix(conn) {
  const matrix = Object.fromEntries(PLAN_CODES.map((p) => [p, Object.fromEntries(FEATURES.map((f) => [f.key, f.defaults[p]]))]));
  for (const r of await conn.query('SELECT plan, feature, enabled FROM plan_features')) {
    if (matrix[r.plan] && FEATURE_KEYS.includes(r.feature)) matrix[r.plan][r.feature] = Boolean(r.enabled);
  }
  return matrix;
}

export async function planLimits(conn) {
  const rows = await conn.query('SELECT code, max_officers FROM plans');
  return Object.fromEntries(rows.map((r) => [r.code, { maxOfficers: r.max_officers }]));
}

/** What one company may use: its plan's features, then its own overrides; and its officer limit. */
export async function companyEntitlements(conn, companyId) {
  const [c] = await conn.query('SELECT plan, max_officers FROM companies WHERE id = ?', [companyId]);
  if (!c) return { plan: null, features: {}, maxOfficers: 0, overrides: {} };
  const features = { ...(await planMatrix(conn))[c.plan] };
  const overrides = {};
  for (const r of await conn.query('SELECT feature, enabled FROM company_feature_overrides WHERE company_id = ?', [companyId])) {
    if (!FEATURE_KEYS.includes(r.feature)) continue;
    overrides[r.feature] = Boolean(r.enabled);
    features[r.feature] = Boolean(r.enabled);
  }
  const limits = await planLimits(conn);
  return { plan: c.plan, features, overrides, maxOfficers: c.max_officers ?? limits[c.plan]?.maxOfficers ?? null };
}
