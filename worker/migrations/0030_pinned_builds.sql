-- Where a build runs is the asker's call. A contributor's build goes to
-- their own worker first and to a worker the project shares after 14 days
-- (bumps) or at once (a request whose author has no worker); a build asked
-- for one worker — this one, not the emulated one; the project's native
-- x86_64 — is claimed by that worker only (pinned_to), and waits for it.
ALTER TABLE build_tasks ADD COLUMN pinned_to TEXT REFERENCES build_workers (id);
