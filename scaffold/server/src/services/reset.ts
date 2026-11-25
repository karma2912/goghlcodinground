import { getDb } from '../db.js';
import { APP_PREFIX, deleteByPrefix } from '../redis.js';

/**
 * Delete all application data. MongoDB: every document in every collection
 * (indexes stay, so other running instances keep their guarantees).
 * Redis: app keys only; login sessions survive.
 */
export async function resetAll(): Promise<void> {
  const db = await getDb();
  const cols = await db.listCollections({}, { nameOnly: true }).toArray();
  await Promise.all(
    cols.filter((c) => !c.name.startsWith('system.')).map((c) => db.collection(c.name).deleteMany({})),
  );
  await deleteByPrefix(APP_PREFIX);
}
