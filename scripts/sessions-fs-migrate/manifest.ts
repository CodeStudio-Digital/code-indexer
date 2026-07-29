/**
 * Migration-local compatibility boundary. The canonical SQLite disposition
 * contract lives with the filesystem session storage package so both migration
 * 263 and the offline exporter consume exactly the same declarations.
 */
export * from '@mcp/session-storage/sqlite-disposition.js';
