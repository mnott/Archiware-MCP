/**
 * Tables of the unified file index in the catalogue database (see findfile.ts, indexsync.ts).
 * Kept free of imports so catalog.ts can include them in its SCHEMA without a cycle.
 *
 * names     distinct file names (one row per distinct name, hash column = UNHEX(LEFT(SHA2(raw bytes,256),32)) is the uniqueness key,
 *           the prefix index serves anchored globs like "report*"; substring search scans this table, not the file rows)
 * dirs      distinct parent directories (a full path is never stored per file row)
 * p5_dirs   P5 directory entity id (eid) -> dirs row, per client: how file rows find their directory
 * p5_files  one row per version row of P5's backup index (client, eid = entity, btime = backup time)
 * index_state  per source and client: how far the extract got (last_id = highest P5 element id read, last_btime = newest
 *           backup time read, rows = rows processed)
 */
export const SCHEMA_INDEX: string[] = [
  `CREATE TABLE IF NOT EXISTS names (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(1024) NOT NULL,
  h BINARY(16) NOT NULL,
  UNIQUE KEY uq_names_h (h),
  KEY ix_names_name (name(100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS dirs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  path TEXT NOT NULL,
  h BINARY(16) NOT NULL,
  UNIQUE KEY uq_dirs_h (h)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS p5_dirs (
  client VARCHAR(64) NOT NULL,
  eid BIGINT UNSIGNED NOT NULL,
  dir_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (client, eid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS p5_files (
  client VARCHAR(64) NOT NULL,
  eid BIGINT UNSIGNED NOT NULL,
  btime INT UNSIGNED NOT NULL,
  pid BIGINT UNSIGNED NOT NULL,
  name_id BIGINT UNSIGNED NOT NULL,
  dir_id BIGINT UNSIGNED NOT NULL,
  dtime INT UNSIGNED NOT NULL,
  mtime BIGINT NOT NULL,
  size BIGINT UNSIGNED NOT NULL,
  type TINYINT NOT NULL,
  PRIMARY KEY (client, eid, btime),
  KEY ix_p5_files_name (name_id),
  KEY ix_p5_files_dir (dir_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS index_state (
  source VARCHAR(32) NOT NULL,
  client VARCHAR(64) NOT NULL,
  last_btime BIGINT NOT NULL DEFAULT 0,
  last_id BIGINT NOT NULL DEFAULT 0,
  \`rows\` BIGINT NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (source, client)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];
