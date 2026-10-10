import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const sessions = sqliteTable('sessions', {id:text('id').primaryKey(), payload:text('payload').notNull(), revision:integer('revision').notNull().default(0), expiresAt:integer('expires_at').notNull()}, t=>[index('sessions_expiry').on(t.expiresAt)]);
export const rooms = sqliteTable('rooms', {code:text('code').primaryKey(), payload:text('payload').notNull(), revision:integer('revision').notNull().default(0), expiresAt:integer('expires_at').notNull()}, t=>[index('rooms_expiry').on(t.expiresAt)]);
export const limits = sqliteTable('limits', {id:text('id').primaryKey(), count:integer('count').notNull().default(1), expiresAt:integer('expires_at').notNull()}, t=>[index('limits_expiry').on(t.expiresAt)]);
