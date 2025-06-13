/**
 * This is just a super simple in-memory database for the demo.
 * In a real application, you would use a proper database that persists the data.
 */

export class Database {
  #database: Map<string, any>;

  constructor() {
    this.#database = new Map();
  }

  async get(key: string) {
    return this.#database.get(key);
  }

  async set(key: string, value: any) {
    this.#database.set(key, value);
  }
}

let database: Database | undefined;

export function db() {
  if (!database) {
    database = new Database();
  }
  return database;
}
