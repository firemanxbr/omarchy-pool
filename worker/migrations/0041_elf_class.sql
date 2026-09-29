-- The ELF class a package's objects are built for, when it is not the
-- machine's own (#275): '32' for a lib32 (i686) package, '32 64' for one
-- that ships both, NULL for 64-bit — both architectures the pool serves are
-- 64-bit machines — or nothing to tell by. A library a binary loads comes
-- from a package of its class: lib32-curl's libc.so.6 is lib32-glibc's, and
-- glibc is not loaded by lib32 packages. The package page, its reverse
-- edges and the Security page's exposure read it on the package row they
-- read anyway, so the rule costs no row.
--
-- The Worker computes it at indexing (elf.ts, elfClassOf); this is the same
-- over the rows already there: the class forms (`libz.so=1-32`) a package
-- ships or declares in its manifest's provides, and the ones its .PKGINFO
-- depends on. One pass over the table, once; only the few 32-bit rows are
-- written. The LIKE is a cheap test on the text before the JSON is read.
--
-- Additive only: the Worker that runs during the deploy minute reads and
-- writes none of it, and a package it indexes then reads as 64-bit until its
-- next version.
ALTER TABLE packages ADD COLUMN elf_class TEXT;
UPDATE packages
   SET elf_class = CASE
         WHEN EXISTS (SELECT 1 FROM json_each(manifest_json, '$.provides') WHERE value GLOB '*.so=*-64')
           OR EXISTS (SELECT 1 FROM json_each(manifest_json, '$.pkginfo.depends') WHERE value GLOB '*.so=*-64')
         THEN '32 64' ELSE '32' END
 WHERE manifest_json LIKE '%.so=%-32"%'
   AND (EXISTS (SELECT 1 FROM json_each(manifest_json, '$.provides') WHERE value GLOB '*.so=*-32')
     OR EXISTS (SELECT 1 FROM json_each(manifest_json, '$.pkginfo.depends') WHERE value GLOB '*.so=*-32'));
