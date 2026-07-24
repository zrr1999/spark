# @zendev-lab/spark-update

This private workspace package is the single owner of Spark managed-install,
update-policy, quarantine, and rollback state. The public `spark` executable
only dispatches into it. The daemon and Cockpit may read updater state, but
must not write it.

Managed installs keep immutable package versions below the Spark XDG data
directory and switch a `current` symlink atomically. A version-independent
launcher in `$PREFIX/bin/spark` is the only executable referenced by service
managers.
