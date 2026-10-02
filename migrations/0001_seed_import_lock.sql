-- The lock is a lease claimed with a conditional UPDATE, so its single row must exist.
INSERT INTO `import_lock` (`id`) VALUES (1);
