# spark-core

Internal shared refs, schemas, and contracts. This package must not contain business logic.
Low-level mechanisms shared by Spark stores, such as JSON file formatting and atomic writes, can live here; package-specific snapshot validation stays with the owning package.
