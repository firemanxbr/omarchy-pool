-- Workers follow the brain: the mode (shared or the owner's packages only)
-- is the registration's once someone set it from the page or the command
-- line (mode_by), not what the container was started with; the worker's
-- own log — the lines between tasks — reaches the pool with each claim.
ALTER TABLE build_workers ADD COLUMN mode_by TEXT;   -- NULL: the worker's own flag applies · a login: set from the page · 'worker': set through its token
ALTER TABLE build_workers ADD COLUMN log_tail TEXT;  -- the last lines of the worker's own log (bounded), for its owner and the maintainers
ALTER TABLE build_workers ADD COLUMN log_at TEXT;
