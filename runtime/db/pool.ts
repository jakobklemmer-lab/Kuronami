import { Pool } from "pg";

/**
 * Verbindungspool für die Runtime. Bewusst eine Fabrik und kein Modul-Singleton: der
 * Lebenszyklus gehört dem Aufrufer, damit Tests und später der Runtime-Prozess ihn
 * kontrolliert schließen können.
 */
export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL ist nicht gesetzt");
  }
  return new Pool({ connectionString });
}
