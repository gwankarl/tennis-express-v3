import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type {
  AdminApproval,
  AdminOperationIntent,
  AdminOperator,
} from '../src/modules/identity/admin/admin-operations.service.js';
import {
  canonicalizeAdminIntent,
  executeAdminOperation,
} from '../src/modules/identity/admin/admin-operations.service.js';
import { parseEnv, loadBackendEnv } from '../src/config/env.js';
import { createDatabaseClient } from '../src/infrastructure/database/client.js';
import { createSmtpEmailSender } from '../src/infrastructure/email/smtp-email-sender.js';
import { createAdminMfaRecoveryEmail } from '../src/modules/identity/admin/mfa-recovery-email.js';

interface OperatorRegistry {
  operators: AdminOperator[];
  targets: Record<string, { database: string; login: string; serverAddress: string }>;
}

interface SignedApprovalFile {
  approvals: AdminApproval[];
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function requireEnvironmentConfirmation(environment: string): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Operator confirmation requires an interactive terminal.');
  }

  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await terminal.question(
      `Type ${environment} to confirm the target environment: `,
    );
    if (answer !== environment) throw new Error('Environment confirmation did not match.');
  } finally {
    terminal.close();
  }
}

async function run(): Promise<void> {
  loadBackendEnv();
  const args = process.argv.slice(2);
  const intentPath = readOption(args, '--intent');
  const approvalsPath = readOption(args, '--approvals');
  if (!intentPath) throw new Error('An intent file is required.');

  const intent = await readJsonFile<AdminOperationIntent>(intentPath);
  const canonical = canonicalizeAdminIntent(intent);
  if (args.includes('--show-payload')) {
    stdout.write(canonical);
    return;
  }
  const config = parseEnv(process.env);
  const isOperatorMfaRecovery = intent.action === 'operator_mfa_recovery';

  if (isOperatorMfaRecovery && (!config.adminMfa || !config.email.enabled || !config.email.smtp)) {
    throw new Error('Operator MFA recovery requires MFA keys and configured SMTP delivery.');
  }

  if ((intent.action === 'grant' || isOperatorMfaRecovery) && !stdout.isTTY) {
    throw new Error('This operation must run in an interactive terminal.');
  }

  const recoveryEmailSender =
    isOperatorMfaRecovery && config.email.smtp
      ? createSmtpEmailSender(config.email.smtp)
      : undefined;
  if (!approvalsPath) throw new Error('An approvals file is required.');

  const registryPath = process.env.ADMIN_OPERATOR_KEYS_FILE?.trim();
  if (!registryPath) throw new Error('ADMIN_OPERATOR_KEYS_FILE is required.');
  const registry = await readJsonFile<OperatorRegistry>(registryPath);
  const expectedTarget = registry.targets[intent.environment];
  if (!expectedTarget)
    throw new Error('The requested environment is not in the operator registry.');

  const approvalFile = await readJsonFile<SignedApprovalFile>(approvalsPath);
  if (!Array.isArray(approvalFile.approvals)) throw new Error('Approval file format is invalid.');

  const database = createDatabaseClient(config.databaseUrl);
  try {
    const targetResult = await database.pool.query<{
      database_name: string;
      login_name: string;
      server_address: string | null;
    }>(`SELECT current_database() AS database_name,
               current_user AS login_name,
               host(inet_server_addr()) AS server_address`);
    const connected = targetResult.rows[0];
    if (
      connected?.database_name !== expectedTarget.database ||
      connected.login_name !== expectedTarget.login ||
      connected.server_address !== expectedTarget.serverAddress
    ) {
      throw new Error(
        'Connected database identity does not match the protected environment registry.',
      );
    }

    stdout.write(
      `Environment: ${intent.environment}\nDatabase: ${connected.database_name}\nLogin: ${connected.login_name}\nServer: ${connected.server_address}\nTarget: ${intent.targetUserId} (${intent.normalizedEmail})\n`,
    );
    await requireEnvironmentConfirmation(intent.environment);

    const result = await executeAdminOperation(
      database.pool,
      intent,
      approvalFile.approvals,
      registry.operators,
    );

    if (result.operatorRecoveryNotification && recoveryEmailSender) {
      try {
        await recoveryEmailSender.send(
          createAdminMfaRecoveryEmail({
            to: result.operatorRecoveryNotification.recipient,
            frontendOrigin: config.email.frontendOrigin,
            adminHoldUntil: result.operatorRecoveryNotification.adminHoldUntil,
          }),
        );
      } catch {
        stdout.write(
          'MFA recovery committed, but notification delivery failed. Follow the independently verified manual notification procedure.\n',
        );
      }
    }

    stdout.write(`Operation result: ${result.status}\n`);
    if (result.enrollmentState) stdout.write(`MFA enrollment state: ${result.enrollmentState}\n`);
    if (result.enrollmentAuthorization) {
      if (!stdout.isTTY)
        throw new Error('Refusing to write an enrollment authorization outside a terminal.');
      stdout.write(
        `One-time enrollment authorization (deliver through the independently verified channel): ${result.enrollmentAuthorization}\n`,
      );
    }
  } finally {
    await database.close();
  }
}

run().catch(() => {
  process.stderr.write(
    'Administrator operation failed. Check the protected intent, approvals, registry, and target environment.\n',
  );
  process.exitCode = 1;
});
