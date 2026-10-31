-- 008: correct the record (review D1). 001_init.sql says the append-only
-- triggers hold "for any role, including the owner". That overstates it: the
-- table owner (or a superuser) can ALTER TABLE ... DISABLE TRIGGER. The real
-- guarantee is two barriers for the role the service uses: the triggers, and
-- acme_app having no UPDATE, DELETE or TRUNCATE grant. 001 cannot be edited:
-- the migration checksum would refuse every existing database.
COMMENT ON FUNCTION forbid_mutation() IS
  'Blocks UPDATE/DELETE/TRUNCATE on append-only tables for every role while the trigger is enabled. '
  'The owner can disable triggers; the app role (acme_app) is not the owner and has no such grants either.';
