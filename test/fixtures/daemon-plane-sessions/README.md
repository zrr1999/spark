# Daemon plane session fixtures

The daemon execution-plane tests create temporary Spark session stores from this fixture plan: two sessions (`fixture-a`, `fixture-b`) are used for `session list`, `session show`, `session tree`, `session fork`, and run/event JSON command coverage. The test writes them into a temp Spark home so fork tests can mutate safely.
