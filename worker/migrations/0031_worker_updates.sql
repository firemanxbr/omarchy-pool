-- Every worker follows the latest image: the release the pool last refused a worker for, so the journal says it once.
ALTER TABLE build_workers ADD COLUMN told_update TEXT;
