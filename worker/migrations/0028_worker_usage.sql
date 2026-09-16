-- What the Workers page says of each machine, without a query per worker:
-- the resources it uses and the last task it finished. Both travel on
-- writes the pool already makes — the claim (usage: an average the worker
-- keeps of its host's CPU, memory and the work directory's disk, sampled
-- on its own clock) and the completion (last_task: id, kind, name,
-- version, how it ended, when) — so the public listing reads one row per
-- worker and nothing else.
ALTER TABLE build_workers ADD COLUMN usage TEXT;        -- JSON {cpu, ram, disk (%), cores, ram_gb, disk_gb, since}
ALTER TABLE build_workers ADD COLUMN usage_at TEXT;
ALTER TABLE build_workers ADD COLUMN last_task TEXT;    -- JSON {id, kind, name, version, status, at}
