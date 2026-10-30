#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
: "${ODOO_ROOT:?Set ODOO_ROOT to the public Odoo 19 checkout}"
: "${ODOO_PYTHON:=python3}"
: "${DB_NAME:=alvina_test}"
: "${PGHOST:=/var/run/postgresql}"
: "${PGPORT:=5432}"
: "${PGUSER:=$(id -un)}"
case "$DB_NAME" in *_test) ;; *) echo 'Use a disposable database ending in _test' >&2; exit 2 ;; esac
"$ODOO_PYTHON" "$ODOO_ROOT/odoo-bin" \
    -d "$DB_NAME" --db_host="$PGHOST" --db_port="$PGPORT" --db_user="$PGUSER" \
    --addons-path="$ODOO_ROOT/addons,$repo_dir" \
    -i alvina_pos_employee_discount -u alvina_pos_employee_discount \
    --without-demo=all --test-enable --test-tags=/alvina_pos_employee_discount \
    --stop-after-init --no-http "$@"
