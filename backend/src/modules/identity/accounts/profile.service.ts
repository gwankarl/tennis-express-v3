import { and, eq, isNotNull } from 'drizzle-orm';
import type { DatabaseClient } from '../../../infrastructure/database/client.js';
import { identityUsers } from './user.table.js';
import type { UserProfileResponseData } from './profile.schema.js';

type ProfileDatabase = DatabaseClient['db'];

function toProfile(
  user:
    | {
        id: string;
        displayName: string | null;
        email: string;
        emailVerifiedAt: Date | null;
      }
    | undefined,
): UserProfileResponseData | undefined {
  if (!user?.emailVerifiedAt) {
    return undefined;
  }

  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt.toISOString(),
  };
}

/** Reads the active, verified profile belonging to the authenticated user. */
export async function getUserProfile(
  db: ProfileDatabase,
  userId: string,
): Promise<UserProfileResponseData | undefined> {
  const users = await db
    .select({
      id: identityUsers.id,
      displayName: identityUsers.displayName,
      email: identityUsers.deliveryEmail,
      emailVerifiedAt: identityUsers.emailVerifiedAt,
    })
    .from(identityUsers)
    .where(
      and(
        eq(identityUsers.id, userId),
        eq(identityUsers.status, 'active'),
        isNotNull(identityUsers.emailVerifiedAt),
      ),
    )
    .limit(1);

  return toProfile(users[0]);
}

/** Updates only the display name of the active, verified authenticated user. */
export async function updateUserDisplayName(
  db: ProfileDatabase,
  userId: string,
  displayName: string,
): Promise<UserProfileResponseData | undefined> {
  const users = await db
    .update(identityUsers)
    .set({
      displayName,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(identityUsers.id, userId),
        eq(identityUsers.status, 'active'),
        isNotNull(identityUsers.emailVerifiedAt),
      ),
    )
    .returning({
      id: identityUsers.id,
      displayName: identityUsers.displayName,
      email: identityUsers.deliveryEmail,
      emailVerifiedAt: identityUsers.emailVerifiedAt,
    });

  return toProfile(users[0]);
}
