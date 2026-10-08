// Server configuration from environment variables (a .env file in the project root is loaded if present).
try {
  process.loadEnvFile();
} catch {}

const env = process.env;

export const config = {
  port: Number(env.PORT) || 8080,
  host: env.HOST || '0.0.0.0',
  // Device timestamps are local time; keep server-side ones in the same zone.
  timezone: env.TZ || 'Asia/Kolkata',
  sessionDays: Number(env.SESSION_DAYS) || 30,
  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT) || 3306,
    user: env.DB_USER || 'recovery',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'loan_recovery',
    connectionLimit: Number(env.DB_POOL_SIZE) || 10,
  },
};

process.env.TZ = config.timezone;
