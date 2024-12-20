import SqliteDb from "libsql";
import {
  Kysely,
  Migrator,
  SqliteDialect,
  Migration,
  MigrationProvider,
  CompiledQuery,
  JSONColumnType,
  ColumnType,
  ParseJSONResultsPlugin,
} from "kysely";
import {
  ComAtprotoRepoStrongRef,
  SocialPskyChatRoom,
  SocialPskyRichtextFacet,
} from "@atcute/client/lexicons";

// Types

export type DatabaseSchema = {
  messages: MessageTable;
  users: UserTable;
  rooms: RoomTable;
};

export type MessageTable = {
  uri: ColumnType<string, string, never>;
  cid: string;
  did: ColumnType<string, string, never>;
  content: string;
  room: ColumnType<string, string, never>;
  facets: JSONColumnType<SocialPskyRichtextFacet.Main[]> | null;
  reply: JSONColumnType<ComAtprotoRepoStrongRef.Main> | null;
  indexed_at: ColumnType<Date, number, never>;
  updated_at: ColumnType<Date, never, number> | null;
};

export type RoomTable = {
  uri: ColumnType<string, string, never>;
  cid: string;
  owner_did: ColumnType<string, string, never>;
  name: string | null;
  languages: JSONColumnType<string[]> | null;
  topic: string | null;
  tags: JSONColumnType<string[]> | null;
  allowlist: JSONColumnType<SocialPskyChatRoom.ModlistRef> | null;
  denylist: JSONColumnType<SocialPskyChatRoom.ModlistRef> | null;
  updated_at: ColumnType<Date, number, number>;
};

export type UserTable = {
  did: ColumnType<string, string, never>;
  handle: string;
  active: ColumnType<number, number | undefined, number>;
  nickname: string | null;
  updated_at: ColumnType<Date, number, number>;
};

// Migrations

const migrations: Record<string, Migration> = {};

const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};

migrations["001"] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("messages")
      .addColumn("uri", "text", (col) => col.primaryKey())
      .addColumn("cid", "text", (col) => col.notNull())
      .addColumn("did", "text", (col) =>
        col.notNull().references("users.did").onDelete("cascade"),
      )
      .addColumn("content", "text", (col) => col.notNull())
      .addColumn("room", "text", (col) =>
        col.notNull().references("rooms.uri").onDelete("cascade"),
      )
      .addColumn("facets", "text")
      .addColumn("reply", "text")
      .addColumn("indexed_at", "integer", (col) => col.notNull())
      .addColumn("updated_at", "integer")
      .execute();

    await db.schema
      .createTable("rooms")
      .addColumn("uri", "text", (col) => col.primaryKey())
      .addColumn("cid", "text", (col) => col.notNull())
      .addColumn("name", "text")
      .addColumn("owner_did", "text", (col) =>
        col.notNull().references("users.did").onDelete("cascade"),
      )
      .addColumn("languages", "text")
      .addColumn("topic", "text")
      .addColumn("tags", "text")
      .addColumn("allowlist", "text")
      .addColumn("denylist", "text")
      .addColumn("updated_at", "integer", (col) => col.notNull())
      .execute();

    await db.schema
      .createTable("users")
      .addColumn("did", "text", (col) => col.primaryKey())
      .addColumn("handle", "text", (col) => col.notNull())
      .addColumn("active", "integer", (col) => col.notNull().defaultTo(true))
      .addColumn("nickname", "text")
      .addColumn("updated_at", "integer", (col) => col.notNull())
      .execute();
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable("messages").execute();
    await db.schema.dropTable("users").execute();
    await db.schema.dropTable("rooms").execute();
  },
};

// APIs

export const createDb = (location: string): Database => {
  const db = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: new SqliteDb(location),
    }),
    plugins: [new ParseJSONResultsPlugin()],
  });
  db.executeQuery(CompiledQuery.raw("PRAGMA journal_mode = WAL"));
  db.executeQuery(CompiledQuery.raw("PRAGMA foreign_keys = ON"));
  return db;
};

export const migrateToLatest = async (db: Database) => {
  const migrator = new Migrator({ db, provider: migrationProvider });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;
};

export type Database = Kysely<DatabaseSchema>;
