import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

export interface BackendEmailConfig {
  enabled: boolean;
  frontendOrigin: string;
  smtp?: SmtpConfig;
}

export interface AdminMfaConfig {
  /** Base64 encoding of a 32-byte AES-256 key. Keep it outside PostgreSQL. */
  encryptionKey: string;
  /** Identifies the encryption key used for each factor's ciphertext. */
  keyVersion: string;
  /** Base64 encoding of a separate 32-byte HMAC key for attempt-counter subjects. */
  attemptHmacKey: string;
}

export interface BackendConfig {
  host: string;
  port: number;
  databaseUrl: string;
  sellerListingImageStorageDirectory: string;
  sellerEvidenceStorageDirectory: string;
  email: BackendEmailConfig;
  adminMfa?: AdminMfaConfig;
}

export type EnvSetting =
  | 'HOST'
  | 'PORT'
  | 'DATABASE_URL'
  | 'EMAIL_ENABLED'
  | 'FRONTEND_ORIGIN'
  | 'SMTP_HOST'
  | 'SMTP_PORT'
  | 'SMTP_USER'
  | 'SMTP_PASS'
  | 'EMAIL_FROM'
  | 'SELLER_LISTING_IMAGE_STORAGE_DIR'
  | 'SELLER_EVIDENCE_STORAGE_DIR'
  | 'ADMIN_MFA_ENCRYPTION_KEY'
  | 'ADMIN_MFA_KEY_VERSION'
  | 'ADMIN_MFA_ATTEMPT_HMAC_KEY';

const DEFAULT_FRONTEND_ORIGIN = 'http://127.0.0.1:5173';

const DEFAULT_SELLER_EVIDENCE_STORAGE_DIRECTORY = 'C:/tx-private/tennis-xpress/evidence';
const DEFAULT_SELLER_LISTING_IMAGE_STORAGE_DIRECTORY = 'C:/tx-private/tennis-xpress/listing-images';

const BACKEND_ENV_KEYS = [
  'HOST',
  'PORT',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'EMAIL_ENABLED',
  'FRONTEND_ORIGIN',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'EMAIL_FROM',
  'ADMIN_OPERATOR_KEYS_FILE',
  'ADMIN_MFA_ENCRYPTION_KEY',
  'ADMIN_MFA_KEY_VERSION',
  'ADMIN_MFA_ATTEMPT_HMAC_KEY',
  'SELLER_LISTING_IMAGE_STORAGE_DIR',
  'SELLER_EVIDENCE_STORAGE_DIR',
] as const;

const envSettingNames = new Set<string>(BACKEND_ENV_KEYS);

const portSchema = z.preprocess(
  (value: unknown) => (value === undefined ? '3000' : value),
  z.string().trim().regex(/^\d+$/u).transform(Number).pipe(z.number().int().min(1).max(65535)),
);

const baseSettingsSchema = z.object({
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: portSchema,
  DATABASE_URL: z.string().trim().min(1).refine(isValidDatabaseUrl),
  SELLER_EVIDENCE_STORAGE_DIR: z
    .preprocess(
      (value: unknown) => (value === undefined ? DEFAULT_SELLER_EVIDENCE_STORAGE_DIRECTORY : value),
      z.string().trim().min(1),
    )
    .refine(isAbsolute),
  SELLER_LISTING_IMAGE_STORAGE_DIR: z
    .preprocess(
      (value: unknown) =>
        value === undefined ? DEFAULT_SELLER_LISTING_IMAGE_STORAGE_DIRECTORY : value,
      z.string().trim().min(1),
    )
    .refine(isAbsolute),
  EMAIL_ENABLED: z.preprocess(
    (value: unknown) => (value === undefined ? 'false' : value),
    z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.enum(['true', 'false']))
      .transform((value) => value === 'true'),
  ),
});

const smtpSettingsSchema = z.object({
  FRONTEND_ORIGIN: z.preprocess(
    (value: unknown) => (value === undefined ? DEFAULT_FRONTEND_ORIGIN : value),
    z
      .string()
      .trim()
      .min(1)
      .refine(isValidFrontendOrigin)
      .transform((value) => new URL(value).origin),
  ),
  SMTP_HOST: z.string().trim().min(1),
  SMTP_PORT: z
    .string()
    .trim()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535)),
  SMTP_USER: z.string().trim().min(1),
  // Check for blank input but preserve the exact credential value.
  SMTP_PASS: z.string().refine((value) => value.trim().length > 0),
  EMAIL_FROM: z
    .string()
    .trim()
    .regex(/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u),
});

const adminMfaSettingsSchema = z.object({
  ADMIN_MFA_ENCRYPTION_KEY: z.string().refine(isBase64Encoded32ByteKey),
  ADMIN_MFA_KEY_VERSION: z.string().trim().min(1),
  ADMIN_MFA_ATTEMPT_HMAC_KEY: z.string().refine(isBase64Encoded32ByteKey),
});

export class EnvValidationError extends Error {
  constructor(
    readonly setting: EnvSetting,
    message: string,
  ) {
    super(`${setting} ${message}`);
    this.name = 'EnvValidationError';
  }
}

export function loadBackendEnv(): void {
  const envFilePath = resolve(__dirname, '../../.env');

  if (!existsSync(envFilePath)) {
    return;
  }

  const shellValues = new Map(BACKEND_ENV_KEYS.map((key) => [key, process.env[key]] as const));

  loadEnvFile(envFilePath);

  for (const key of BACKEND_ENV_KEYS) {
    const shellValue = shellValues.get(key);

    if (shellValue !== undefined) {
      process.env[key] = shellValue;
    }
  }
}

export function parseEnv(env: NodeJS.ProcessEnv): BackendConfig {
  const base = parseSettings(baseSettingsSchema, env);
  const adminMfa = parseAdminMfaSettings(env);

  if (!base.EMAIL_ENABLED) {
    return {
      host: base.HOST,
      port: base.PORT,
      databaseUrl: base.DATABASE_URL,
      sellerEvidenceStorageDirectory: base.SELLER_EVIDENCE_STORAGE_DIR,
      sellerListingImageStorageDirectory: base.SELLER_LISTING_IMAGE_STORAGE_DIR,
      email: {
        enabled: false,
        frontendOrigin: DEFAULT_FRONTEND_ORIGIN,
      },
      ...(adminMfa ? { adminMfa } : {}),
    };
  }

  const smtp = parseSettings(smtpSettingsSchema, env);

  return {
    host: base.HOST,
    port: base.PORT,
    databaseUrl: base.DATABASE_URL,
    sellerEvidenceStorageDirectory: base.SELLER_EVIDENCE_STORAGE_DIR,
    sellerListingImageStorageDirectory: base.SELLER_LISTING_IMAGE_STORAGE_DIR,
    email: {
      enabled: true,
      frontendOrigin: smtp.FRONTEND_ORIGIN,
      smtp: {
        host: smtp.SMTP_HOST,
        port: smtp.SMTP_PORT,
        user: smtp.SMTP_USER,
        password: smtp.SMTP_PASS,
        from: smtp.EMAIL_FROM,
      },
    },
    ...(adminMfa ? { adminMfa } : {}),
  };
}

function parseAdminMfaSettings(env: NodeJS.ProcessEnv): AdminMfaConfig | undefined {
  const settingNames = [
    'ADMIN_MFA_ENCRYPTION_KEY',
    'ADMIN_MFA_KEY_VERSION',
    'ADMIN_MFA_ATTEMPT_HMAC_KEY',
  ] as const;

  if (settingNames.every((setting) => env[setting] === undefined)) {
    return undefined;
  }

  const settings = parseSettings(adminMfaSettingsSchema, env);

  return {
    encryptionKey: settings.ADMIN_MFA_ENCRYPTION_KEY,
    keyVersion: settings.ADMIN_MFA_KEY_VERSION,
    attemptHmacKey: settings.ADMIN_MFA_ATTEMPT_HMAC_KEY,
  };
}

function isBase64Encoded32ByteKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
    return false;
  }

  const decoded = Buffer.from(value, 'base64');

  return decoded.length === 32 && decoded.toString('base64') === value;
}

function parseSettings<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);

  if (!result.success) {
    const firstPathItem = result.error.issues[0]?.path[0];
    const setting =
      typeof firstPathItem === 'string' && envSettingNames.has(firstPathItem)
        ? (firstPathItem as EnvSetting)
        : 'DATABASE_URL';

    throw new EnvValidationError(setting, getValidationMessage(setting));
  }

  return result.data;
}

function getValidationMessage(setting: EnvSetting): string {
  switch (setting) {
    case 'HOST':
      return 'must not be blank';
    case 'PORT':
    case 'SMTP_PORT':
      return 'must be an integer from 1 to 65535';
    case 'DATABASE_URL':
      return 'must be a valid PostgreSQL connection URL';
    case 'EMAIL_ENABLED':
      return 'must be true or false';
    case 'FRONTEND_ORIGIN':
      return 'must be an absolute HTTP(S) origin without a path';
    case 'SMTP_HOST':
    case 'SMTP_USER':
    case 'SMTP_PASS':
      return 'is required and must not be blank when EMAIL_ENABLED is true';
    case 'EMAIL_FROM':
      return 'must be a valid sender email address';
    case 'ADMIN_MFA_ENCRYPTION_KEY':
    case 'ADMIN_MFA_ATTEMPT_HMAC_KEY':
      return 'must be a base64-encoded 32-byte key';
    case 'ADMIN_MFA_KEY_VERSION':
      return 'must not be blank';
    case 'SELLER_EVIDENCE_STORAGE_DIR':
      return 'must be an absolute path to a private evidence directory';
    case 'SELLER_LISTING_IMAGE_STORAGE_DIR':
      return 'must be an absolute path to a private listing image directory';
  }
}

function isValidDatabaseUrl(value: string): boolean {
  try {
    const parsedUrl = new URL(value);

    return (
      ['postgres:', 'postgresql:'].includes(parsedUrl.protocol) &&
      parsedUrl.hostname.length > 0 &&
      parsedUrl.pathname.length > 1
    );
  } catch {
    return false;
  }
}

function isValidFrontendOrigin(value: string): boolean {
  try {
    const parsedUrl = new URL(value);

    return (
      ['http:', 'https:'].includes(parsedUrl.protocol) &&
      parsedUrl.hostname.length > 0 &&
      parsedUrl.username.length === 0 &&
      parsedUrl.password.length === 0 &&
      parsedUrl.pathname === '/' &&
      parsedUrl.search.length === 0 &&
      parsedUrl.hash.length === 0
    );
  } catch {
    return false;
  }
}
