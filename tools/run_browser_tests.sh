#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
: "${ODOO_ROOT:?Set ODOO_ROOT to the public Odoo 19 checkout}"
: "${ODOO_PYTHON:=python3}"
: "${DB_NAME:=alvina_test}"
: "${PGHOST:=/var/run/postgresql}"
: "${PGPORT:=5432}"
: "${PGUSER:=$(id -un)}"
alvina_data_args=()
if [ -n "${ODOO_DATA_DIR:-}" ]; then alvina_data_args+=("--data-dir=$ODOO_DATA_DIR"); fi
case "$DB_NAME" in *_test) ;; *) echo 'Use a disposable *_test database' >&2; exit 2 ;; esac
alvina_fixture_path=$(mktemp /tmp/alvina-browser.XXXXXX)
export ALVINA_BROWSER_FIXTURE="$alvina_fixture_path"
trap 'rm -f -- "$alvina_fixture_path"' EXIT
cd "$repo_dir"
for scenario in smoke after_commit before_commit; do
    "$ODOO_PYTHON" "$ODOO_ROOT/odoo-bin" shell \
        -d "$DB_NAME" --db_host="$PGHOST" --db_port="$PGPORT" --db_user="$PGUSER" \
        --addons-path="$ODOO_ROOT/addons,$repo_dir" --no-http "${alvina_data_args[@]}" \
        --logfile=/tmp/alvina-browser-fixture.log < tools/prepare_browser_fixture.py
    if [ "$scenario" = smoke ]; then
        node tools/browser_smoke.cjs
    else
        ALVINA_DROP_MODE="$scenario" node tools/browser_recovery.cjs
    fi
done
