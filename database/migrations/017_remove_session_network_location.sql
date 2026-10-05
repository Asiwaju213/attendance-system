-- Remove obsolete network/location metadata from cloud sessions and the K12
-- attendance-session projection. The standalone master-data tables remain.

DO $migration$
DECLARE
  target RECORD;
  dependent RECORD;
  relation_id regclass;
  target_attnum smallint;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('attendance_sessions', 'attendance_network_id'),
      ('attendance_sessions', 'location_id'),
      ('sync_attendance_sessions', 'cloud_attendance_network_id'),
      ('sync_attendance_sessions', 'cloud_location_id')
    ) AS columns_to_remove(table_name, column_name)
  LOOP
    relation_id := to_regclass(target.table_name);
    IF relation_id IS NULL THEN
      CONTINUE;
    END IF;

    target_attnum := NULL;
    SELECT attnum INTO target_attnum
    FROM pg_attribute
    WHERE attrelid = relation_id
      AND attname = target.column_name
      AND NOT attisdropped;

    IF target_attnum IS NULL THEN
      CONTINUE;
    END IF;

    FOR dependent IN
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = relation_id
        AND contype = 'f'
        AND target_attnum = ANY(conkey)
    LOOP
      RAISE NOTICE 'Dropping foreign key constraint % from %', dependent.conname, relation_id;
      EXECUTE format(
        'ALTER TABLE %s DROP CONSTRAINT %I',
        relation_id,
        dependent.conname
      );
    END LOOP;

    FOR dependent IN
      SELECT DISTINCT index_namespace.nspname AS schema_name,
                      index_class.relname AS index_name
      FROM pg_index AS index_info
      JOIN pg_class AS index_class ON index_class.oid = index_info.indexrelid
      JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
      WHERE index_info.indrelid = relation_id
        AND EXISTS (
          SELECT 1
          FROM unnest(index_info.indkey) AS indexed_column(attnum)
          WHERE indexed_column.attnum = target_attnum
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_constraint AS owning_constraint
          WHERE owning_constraint.conindid = index_info.indexrelid
        )
    LOOP
      RAISE NOTICE 'Dropping index %.% for %.%',
        dependent.schema_name, dependent.index_name, target.table_name, target.column_name;
      EXECUTE format(
        'DROP INDEX %I.%I',
        dependent.schema_name,
        dependent.index_name
      );
    END LOOP;

    RAISE NOTICE 'Dropping column %.% ', target.table_name, target.column_name;
    EXECUTE format(
      'ALTER TABLE %s DROP COLUMN IF EXISTS %I',
      relation_id,
      target.column_name
    );
  END LOOP;
END;
$migration$;